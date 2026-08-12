/**
 * @itential/app-integration_health_monitor
 *
 * Cog for a custom Itential Platform app that periodically calls a
 * user-configured task (a REST route already exposed by an adapter or
 * integration instance) and records whether it responded successfully. If
 * the call returns a non-error HTTP response, the target is considered
 * "healthy" / capable of talking to its integrated system. Anything else
 * (timeout, connection error, non-2xx, or an error payload in an
 * otherwise-200 response) marks it "unhealthy".
 *
 * Configuration (which call to use per target, and how often) is entirely
 * driven from this app's own UI and stored in Mongo - there is no need to
 * touch pronghorn.json or restart the platform to add/change a check.
 *
 * Mongo access and connection-property resolution follow the same pattern
 * established for @itential/app-openapi_editor - see that app's src.js and
 * the companion developer guide (Section 4.3) for why service_config is
 * used instead of a bare `properties` global.
 */

const { MongoClient, ObjectId } = require('mongodb');
const axios = require('axios');
const https = require('https');
const { execFile } = require('child_process');

// Reused whenever a check has insecureTLS enabled - skips certificate
// verification entirely, for self-signed/internal endpoints (e.g. IAP's own
// REST API is commonly deployed with tls.rejectUnauthorized: false).
const INSECURE_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Confirmed against a live Platform 6 instance: this is the real package
// IAP's own core code uses to decrypt legacy $ENC-prefixed values (the
// non-Vault property encryption path). Its PropertyEncryption class exposes
// a synchronous newDecryption(value) method that needs only an encryption
// key - no propertiesDecorators.json/schema required, unlike
// decryptProperties() which IAP uses internally for whole-document
// decryption. Requiring it by absolute path (rather than a bare
// require('@itential/itential-utils')) because this app's own directory
// isn't necessarily nested under /opt/itential/platform/server, so normal
// Node module resolution wouldn't otherwise find it.
const ITENTIAL_UTILS_PATH = '/opt/itential/platform/server/node_modules/@itential/itential-utils';

const COLLECTION_NAME = 'health_checks';
// Same collection name app-openapi_editor stores Integration Models under -
// read-only here, purely to list an integration's own operations for the
// Add/Edit Check form's operation picker (see getIntegrationOperations).
const INTEGRATION_MODELS_COLLECTION = 'integration_models';
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// How often the in-process scheduler wakes up to see which checks are due.
// Individual checks still only actually run at their own configured
// intervalSeconds - this is just the tick granularity.
const SCHEDULER_TICK_MS = 15000;

function HealthMonitor() {
  this.client = null;
  this.schedulerHandle = null;
  this._cachedToken = null;
  this._cachedTokenExpiresAt = null;
  // Per-check OAuth2 token cache, keyed by check _id - each integration can
  // have its own tokenUrl/clientId/clientSecret, entirely independent of
  // platformProps and of every other check's OAuth2 config.
  this._targetTokenCache = new Map();
  // undefined = not yet resolved; null = resolved and unavailable. Lazily
  // initialized on first use since pronghornProps (a process-wide implicit
  // global, same pattern as service_config) may not be set the instant this
  // constructor runs.
  this._propertyEncryption = undefined;
  this.startScheduler();
}

/**
 * Lazily construct (once) IAP's own PropertyEncryption helper, using the
 * process-wide `pronghornProps` global (populated from the INIT_PROPS env
 * var by ServiceBootstrap.js for every service type, adapters/integrations/
 * apps alike - confirmed present at the same implicit-global bare-assignment
 * pattern as `service_config`) for its encryptionKey and vaultProps. Returns
 * null (cached) if either the global or the package isn't available, so
 * callers can fail with a clear message rather than crashing.
 */
HealthMonitor.prototype._getPropertyEncryption = function _getPropertyEncryption() {
  if (this._propertyEncryption !== undefined) return this._propertyEncryption;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { PropertyEncryption } = require(ITENTIAL_UTILS_PATH);
    const vaultProps = (typeof pronghornProps !== 'undefined' && pronghornProps && pronghornProps.vaultProps) || {};
    const encryptionKey = (typeof pronghornProps !== 'undefined' && pronghornProps && pronghornProps.encryptionKey) || '';
    this._propertyEncryption = new PropertyEncryption(vaultProps, encryptionKey);
  } catch (err) {
    this._propertyEncryption = null;
  }
  return this._propertyEncryption;
};

/**
 * Encrypts a plaintext secret using IAP's own PropertyEncryption module -
 * the write-side counterpart to _decryptIfEnc's `enc.newDecryption()` call
 * below. This is what lets createCheck/updateCheck store $ENC...-encrypted
 * values in `health_checks` instead of the plaintext this app previously
 * wrote for authPassword/authToken/oauth.clientSecret - those fields sit in
 * this app's OWN Mongo collection (not Platform's), so unlike the "borrow
 * the user's session" work done for the Editor app, there's no way around
 * needing a real standing credential here (Health Monitor runs on a
 * schedule, unattended, with no logged-in user) - encrypting what's stored
 * at rest is the actual fix available to it.
 *
 * NOT YET CONFIRMED LIVE: the exact method name. `_decryptIfEnc` below
 * calls `enc.newDecryption(value)`, confirmed working against a real
 * Platform 6 instance earlier this engagement - the natural mirrored name
 * for the encrypt side would be `enc.newEncryption(value)`, which is what's
 * tried first here, with a couple of other plausible names as fallbacks.
 * If ALL of them are wrong, this throws a clear error naming every name it
 * tried, rather than silently leaving the value in plaintext - run
 *   node -e "const { PropertyEncryption } = require('/opt/itential/platform/server/node_modules/@itential/itential-utils'); console.log(Object.getOwnPropertyNames(PropertyEncryption.prototype));"
 * on the server to get the real name, then this list is a one-line fix.
 *
 * Idempotent: a value that's already $ENC-prefixed (e.g. an admin pasted an
 * already-encrypted value by hand) is returned unchanged rather than
 * double-encrypted. Empty/falsy values pass through unchanged too - no
 * point encrypting "".
 */
HealthMonitor.prototype._encryptForStorage = function _encryptForStorage(value) {
  if (typeof value !== 'string' || !value || value.startsWith('$ENC')) return value;
  const enc = this._getPropertyEncryption();
  if (!enc) {
    throw new Error('Cannot encrypt: IAP\'s PropertyEncryption module could not be loaded (pronghornProps.encryptionKey unavailable, or @itential/itential-utils not found at the expected path).');
  }
  const candidateMethods = ['newEncryption', 'encrypt', 'newEncrypt'];
  for (const methodName of candidateMethods) {
    if (typeof enc[methodName] === 'function') {
      try {
        return enc[methodName](value);
      } catch (err) {
        throw new Error(`Found PropertyEncryption.${methodName}() but it threw: ${err.message}`);
      }
    }
  }
  throw new Error(
    `Cannot encrypt: none of PropertyEncryption's expected methods (${candidateMethods.join(', ')}) exist on this build's `
    + 'instance. Run the node -e enumeration command in this method\'s doc comment on the server to find the real name, '
    + 'then update the candidateMethods list in _encryptForStorage.',
  );
};

/**
 * Applies _encryptForStorage to every secret-shaped field a check config
 * can carry (authPassword, authToken, oauth.clientSecret) - called by
 * createCheck/updateCheck right before every Mongo write, so plaintext
 * never touches disk even momentarily. Returns a new object; does not
 * mutate the input. Fields already $ENC-prefixed, empty, or absent pass
 * through unchanged (see _encryptForStorage).
 */
HealthMonitor.prototype._encryptCheckSecrets = function _encryptCheckSecrets(config) {
  const next = Object.assign({}, config);
  if (next.authPassword) next.authPassword = this._encryptForStorage(next.authPassword);
  if (next.authToken) next.authToken = this._encryptForStorage(next.authToken);
  if (next.oauth && next.oauth.clientSecret) {
    next.oauth = Object.assign({}, next.oauth, { clientSecret: this._encryptForStorage(next.oauth.clientSecret) });
  }
  return next;
};

/**
 * Read-side counterpart to _encryptForStorage, generalized so it can be used
 * anywhere a value MIGHT be a manually-pasted $ENC...-encrypted string - not
 * just the check-level credential-path lookup in _resolveTargetCredentials
 * (which had its own inline copy of this same enc.newDecryption() call).
 * Used below to cover this app's OWN Service Instance properties
 * (mongoProps.password, platformProps.password/authToken/oauth.clientSecret)
 * - fields that were previously read completely raw, meaning an admin who
 * pasted an $ENC... value into one of them (per this app's own
 * encryptValue-based instructions) would have had the literal ciphertext
 * sent as the actual password/token, breaking auth. This closes that gap.
 *
 * Values NOT starting with "$ENC" are returned unchanged - this covers both
 * plaintext values (still fully supported) and values already decrypted
 * transparently by Platform itself before this app ever saw them, which is
 * what happens for any property declared in propertiesDecorators.json when
 * HashiCorp Vault is configured (those arrive here as plain strings, with no
 * $SECRET_/$ENC prefix at all - Platform decrypts them upstream, so no
 * app-side handling is needed or possible for that path).
 *
 * Fails closed (throws) if a value IS $ENC-prefixed but can't be decrypted,
 * for the same reason _encryptForStorage fails closed on the write side:
 * silently falling back to the raw ciphertext string as if it were the real
 * secret is worse than a loud, clear startup/connection error.
 */
HealthMonitor.prototype._decryptIfEnc = function _decryptIfEnc(value) {
  if (typeof value !== 'string' || !value.startsWith('$ENC')) return value;
  const enc = this._getPropertyEncryption();
  if (!enc) {
    throw new Error('Value is $ENC-encrypted, but IAP\'s PropertyEncryption module could not be loaded (pronghornProps.encryptionKey unavailable, or @itential/itential-utils not found at the expected path) - cannot decrypt it.');
  }
  try {
    return enc.newDecryption(value);
  } catch (err) {
    throw new Error(`Failed to decrypt an $ENC-prefixed value: ${err.message}`);
  }
};

/**
 * Simple dot-path resolver for reading a nested value out of a raw Mongo
 * document (e.g. "properties.properties.authentication.basicAuth.password").
 */
function resolveDotPath(obj, dotPath) {
  return String(dotPath || '').split('.').filter(Boolean).reduce(
    (acc, key) => (acc === undefined || acc === null ? undefined : acc[key]),
    obj,
  );
}

/**
 * Same properties-resolution pattern as app-openapi_editor: on this IAP
 * build, resolved service instance properties are exposed via a
 * process-wide implicit global named `service_config`
 * (service_config.properties), NOT a bare `properties` global as older
 * Pronghorn docs describe. Guarded with typeof so a wrong assumption fails
 * safe rather than crashing the service.
 */
HealthMonitor.prototype._getInstanceProps = function _getInstanceProps() {
  return (typeof service_config !== 'undefined' && service_config && service_config.properties)
    ? service_config.properties
    : {};
};

HealthMonitor.prototype._getDb = function _getDb() {
  const instanceProps = this._getInstanceProps();
  const props = instanceProps.mongoProps || {
    host: process.env.HEALTH_MONITOR_MONGO_HOST || '127.0.0.1',
    port: process.env.HEALTH_MONITOR_MONGO_PORT || 27017,
    database: process.env.HEALTH_MONITOR_MONGO_DB || 'itential-master',
  };

  // Transparently decrypt a manually-pasted $ENC... password (see
  // _decryptIfEnc) - a plaintext password, or one Platform already
  // decrypted itself via propertiesDecorators.json + Vault, passes through
  // unchanged.
  const mongoPassword = this._decryptIfEnc(props.password);

  const auth = props.username
    ? `${encodeURIComponent(props.username)}:${encodeURIComponent(mongoPassword)}@`
    : '';
  const uri = `mongodb://${auth}${props.host}:${props.port}/${props.database}`;

  if (this.client) {
    return Promise.resolve(this.client.db(props.database));
  }

  return MongoClient.connect(uri, { useUnifiedTopology: true }).then((client) => {
    this.client = client;
    return client.db(props.database);
  });
};

/**
 * Where to reach the platform's own web server to invoke an adapter's or
 * integration's route (e.g. http://127.0.0.1:3000), and how to authenticate
 * those calls. Configure this under this app's own Service Instance
 * properties - see sampleProperties.json. Defaults to localhost:3000, which
 * is correct for most single-node installs since the health check runs
 * in-process alongside the rest of the platform.
 *
 * authMode:
 *   "query"  - append ?token=<token> to the request (matches the pattern
 *              shown in Itential's own internal tutorials)
 *   "header" - send Authorization: Bearer <token>, using a static
 *              authToken or a username/password login (see below)
 *   "oauth2" - obtain a token via the OAuth2 client-credentials grant from
 *              oauth.tokenUrl, cache it for its reported lifetime, and send
 *              it as Authorization: Bearer <token>. This is the mode to use
 *              when the target's own auth (or IAP's own API auth for your
 *              deployment) is OAuth2, e.g. an API gateway / identity
 *              provider in front of the platform.
 *   "none"   - send no auth at all (only if the target route genuinely
 *              requires none)
 *
 * For "header" mode, if username/password are provided (in addition to, or
 * instead of, a static authToken), the cog will POST to <baseUrl>/login on
 * demand to obtain a fresh token and automatically re-login once if a check
 * comes back 401 - a static authToken alone will go stale whenever IAP's
 * own session/token TTL expires.
 *
 * oauth config (only used when authMode === "oauth2"):
 *   oauth: {
 *     tokenUrl: "https://auth.example.com/oauth/token",
 *     clientId: "...",
 *     clientSecret: "...",
 *     scope: "optional space-separated scopes",
 *     audience: "optional, some providers (e.g. Auth0) require this"
 *   }
 */
HealthMonitor.prototype._getPlatformConfig = function _getPlatformConfig() {
  const instanceProps = this._getInstanceProps();
  const platform = instanceProps.platformProps || {
    baseUrl: process.env.HEALTH_MONITOR_PLATFORM_URL || 'http://127.0.0.1:3000',
    authMode: process.env.HEALTH_MONITOR_AUTH_MODE || 'query',
    authToken: process.env.HEALTH_MONITOR_AUTH_TOKEN || '',
    username: process.env.HEALTH_MONITOR_AUTH_USERNAME || '',
    password: process.env.HEALTH_MONITOR_AUTH_PASSWORD || '',
    oauth: {
      tokenUrl: process.env.HEALTH_MONITOR_OAUTH_TOKEN_URL || '',
      clientId: process.env.HEALTH_MONITOR_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.HEALTH_MONITOR_OAUTH_CLIENT_SECRET || '',
      scope: process.env.HEALTH_MONITOR_OAUTH_SCOPE || '',
      audience: process.env.HEALTH_MONITOR_OAUTH_AUDIENCE || '',
    },
  };

  // Transparently decrypt any of these three fields if a manually-pasted
  // $ENC... value is present (see _decryptIfEnc) - plaintext, or a value
  // Platform already decrypted itself via propertiesDecorators.json + Vault,
  // passes through unchanged. This is what actually lets platformProps use
  // either encryption path: Vault-backed automatic decoration (Platform
  // decrypts before this app ever sees it - nothing to do here) or the
  // manual $ENC/PropertyEncryption fallback (decrypted right here, fresh on
  // every call - never cached in encrypted form).
  return Object.assign({}, platform, {
    authToken: this._decryptIfEnc(platform.authToken),
    password: this._decryptIfEnc(platform.password),
    oauth: Object.assign({}, platform.oauth, {
      clientSecret: this._decryptIfEnc((platform.oauth || {}).clientSecret),
    }),
  });
};

/**
 * Fetch a fresh OAuth2 access token via the client-credentials grant.
 * Standard-compliant providers (Okta, Auth0, Keycloak, Azure AD, etc.) all
 * accept this exact request shape - see README for provider-specific notes
 * (e.g. Auth0 wanting `audience`).
 */
function fetchOAuthToken(oauth, insecureTLS) {
  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', oauth.clientId);
  params.set('client_secret', oauth.clientSecret);
  if (oauth.scope) params.set('scope', oauth.scope);
  if (oauth.audience) params.set('audience', oauth.audience);

  return axios.post(oauth.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000,
    httpsAgent: insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
  }).then((response) => {
    const token = response.data && response.data.access_token;
    const expiresInSec = (response.data && response.data.expires_in) || 300;
    return { token: token || null, expiresAt: Date.now() + (expiresInSec * 1000) - 15000 }; // refresh 15s early
  });
}

/**
 * Return a usable auth token, obtaining/refreshing it as needed depending
 * on authMode:
 *   - "oauth2": client-credentials grant, cached until near its expiry
 *   - "header"/"query" with username/password: POST <baseUrl>/login,
 *     cached indefinitely until a 401 forces a refresh (no expiry reported)
 *   - otherwise: the static authToken, or null for "none"
 *
 * forceRefresh=true discards any cached token and re-fetches - used after a
 * 401 to rule out "the token simply expired" before giving up.
 *
 * NOTE: the exact shape of IAP's own /login response (token / access_token
 * / jwt_token) has not been confirmed against a live instance from this
 * app - adjust the lookup below if your build returns it under a different
 * key. The OAuth2 client-credentials response shape (`access_token`,
 * `expires_in`) is the standard per RFC 6749 and should not need
 * adjustment for a compliant provider.
 */
HealthMonitor.prototype._getAuthToken = function _getAuthToken(platform, forceRefresh) {
  if (forceRefresh) {
    this._cachedToken = null;
    this._cachedTokenExpiresAt = null;
  }

  if (platform.authMode === 'oauth2') {
    const oauth = platform.oauth || {};
    const stillValid = this._cachedToken && this._cachedTokenExpiresAt && Date.now() < this._cachedTokenExpiresAt;
    if (stillValid) return Promise.resolve(this._cachedToken);
    if (!oauth.tokenUrl || !oauth.clientId || !oauth.clientSecret) return Promise.resolve(null);
    return fetchOAuthToken(oauth, platform.insecureTLS)
      .then(({ token, expiresAt }) => {
        this._cachedToken = token;
        this._cachedTokenExpiresAt = expiresAt;
        return token;
      })
      .catch(() => null); // token endpoint unreachable/misconfigured - fall through, request will 401 and surface a clear error
  }

  if (this._cachedToken) return Promise.resolve(this._cachedToken);
  if (platform.authToken && !platform.username) return Promise.resolve(platform.authToken);
  if (!platform.username) return Promise.resolve(platform.authToken || null);

  const base = String(platform.baseUrl || '').replace(/\/+$/, '');
  return axios.post(`${base}/login`, { user: { username: platform.username, password: platform.password } }, {
    timeout: 8000,
    // Same platformProps.insecureTLS toggle the actual check requests
    // already honored (via config.insecureTLS in sendRequest/curl) - this
    // covers self-signed certs on Platform's OWN baseUrl for
    // Adapter/App-targeted checks, which previously had no way to skip
    // verification even though Integration-targeted checks already did.
    httpsAgent: platform.insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
  })
    .then((response) => {
      const token = response.data && (response.data.token || response.data.access_token || response.data.jwt_token);
      this._cachedToken = token || null;
      return this._cachedToken;
    })
    .catch(() => null); // if login itself fails, fall through to unauthenticated/expired-token behavior below
};

function serialize(doc) {
  if (!doc) return doc;
  const out = Object.assign({}, doc);
  out.id = doc._id.toString();
  delete out._id;
  return out;
}

function defaultStatus() {
  return {
    state: 'unknown',
    lastCheckedAt: null,
    lastResponseTimeMs: null,
    lastStatusCode: null,
    lastError: null,
    lastResponseBody: null,
  };
}

// Cap how much of a response body gets persisted - large payloads (e.g. a
// verbose adapter response) shouldn't bloat the health_checks document or
// the UI. The full (truncated-to-this-length) text is stored and shown via
// a hover tooltip in the table; anything the operator needs beyond that
// should come from the adapter/integration's own logs.
const MAX_STORED_RESPONSE_CHARS = 4000;

function stringifyResponseBody(data) {
  if (data === undefined || data === null) return null;
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  if (!text) return null;
  return text.length > MAX_STORED_RESPONSE_CHARS
    ? `${text.slice(0, MAX_STORED_RESPONSE_CHARS)}… (truncated)`
    : text;
}

/**
 * Actually invoke the configured route and decide healthy/unhealthy.
 * - Network error, timeout, or non-2xx HTTP status -> unhealthy.
 * - 2xx response whose JSON body contains a top-level "error" key is also
 *   treated as unhealthy, since some adapters return 200 with an embedded
 *   error object rather than a real HTTP error status.
 */
function trimSlashes(value) {
  return String(value || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Build the target URL defensively - a trailing slash on baseUrl or a
 * leading/trailing slash on serviceName previously produced a double slash
 * (e.g. ".../meraki-adapter//organizations"), which some routers 404 on
 * even though the route itself exists. This is the ADAPTER path: adapters
 * are reached through IAP's own web server as a generic proxy route.
 */
function buildAdapterUrl(platform, config) {
  const base = String(platform.baseUrl || '').replace(/\/+$/, ''); // keep protocol, drop trailing slash only
  const service = trimSlashes(config.serviceName);
  const rawPath = config.path || '/';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return `${base}/${service}${path}`;
}

/**
 * Integrations are NOT reached through IAP's generic proxy route the way
 * adapters are - that generic "<baseUrl>/<serviceName>/<operationId>" route
 * was deprecated in IAP 2023.1.2 and removed in 2023.2. Instead, each
 * Integration instance has its own configured endpoint, stored in Admin
 * Essentials under the integration's own service config as a
 * `properties.server: { protocol, host, port, base_path }` object (this is
 * exactly what you see when you inspect the integration instance's
 * properties - e.g. { protocol: "http", host: "192.168.0.181", port: 8000,
 * base_path: "" }). A health check for an integration must call that
 * endpoint directly, using the OpenAPI path for the operation being tested,
 * NOT go through platformProps.baseUrl.
 */
HealthMonitor.prototype._getIntegrationServer = function _getIntegrationServer(serviceName) {
  return this._getDb().then((db) => db.collection('service_configs').findOne({ name: serviceName }))
    .then((doc) => {
      // Confirmed against a live instance: the server config is nested one
      // level deeper than the adapter/app service_configs shape - the
      // document's own `properties` wraps a second `properties` object
      // (the integration instance's actual runtime config), which is where
      // `server` lives: doc.properties.properties.server. Falling back to
      // doc.properties.server too, in case a different IAP build/version
      // stores it one level shallower.
      const inner = doc && doc.properties;
      const server = (inner && inner.properties && inner.properties.server) || (inner && inner.server);
      if (!server || !server.host) {
        throw new Error(`Could not find a configured server endpoint for integration "${serviceName}" in service_configs - confirm the name matches exactly what's shown in Admin Essentials > Integrations.`);
      }
      const protocol = server.protocol || 'http';
      const port = server.port ? `:${server.port}` : '';
      const basePath = server.base_path ? (server.base_path.startsWith('/') ? server.base_path : `/${server.base_path}`) : '';
      return `${protocol}://${server.host}${port}${basePath}`;
    });
};

/**
 * Resolve the full URL to call for a given check, branching on target type.
 * Adapters (and custom apps) go through IAP's own web server; integrations
 * are called at their own directly-configured endpoint.
 */
HealthMonitor.prototype._resolveCheckUrl = function _resolveCheckUrl(platform, config) {
  const rawPath = config.path || '/';
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

  if (config.targetType === 'integration') {
    return this._getIntegrationServer(config.serviceName).then((base) => `${base}${path}`);
  }

  return Promise.resolve(buildAdapterUrl(platform, config));
};

/**
 * Basic Auth header for the target's OWN credentials - distinct from
 * platformProps auth, which only governs how this app authenticates to
 * IAP's web server (relevant for adapter checks). Integrations are called
 * directly at their own endpoint and often require their own username/
 * password (e.g. NSO/RESTCONF). IAP stores that integration's own
 * credentials encrypted at rest ($ENC...) with no way for another app's cog
 * to decrypt them, so this is a per-check override: set config.authUsername
 * / config.authPassword in the Add/Edit form to supply working plaintext
 * credentials for that specific target, independent of whatever IAP has
 * stored (and independent of platformProps entirely).
 */
function basicAuthHeader(config) {
  if (!config.authUsername) return null;
  const raw = `${config.authUsername}:${config.authPassword || ''}`;
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/**
 * Which per-check auth strategy applies to a TARGET (not platformProps,
 * which is only about reaching IAP's own web server for adapter checks).
 * Every integration can need something different - none, Basic, a static
 * bearer token, or its own OAuth2 client-credentials grant - so this is
 * explicit per check rather than inherited from any single global setting.
 *
 * `targetAuthMode` is the explicit field going forward ("none" | "basic" |
 * "bearer" | "oauth2"). Older saved checks won't have it set, so for
 * backward compatibility: if it's missing but authUsername is set, treat
 * that as "basic" (matches the behavior introduced for the NSO case).
 */
function resolveTargetAuthMode(config) {
  if (config.targetAuthMode) return config.targetAuthMode;
  return config.authUsername ? 'basic' : 'none';
}

/**
 * Resolve a per-check OAuth2 token for target-level auth, using this check's
 * own config.oauth = { tokenUrl, clientId, clientSecret, scope, audience } -
 * completely independent of platformProps.oauth. Cached per check id in
 * this._targetTokenCache, refreshed 15s before reported expiry (handled
 * inside fetchOAuthToken), or immediately on forceRefresh (used after a
 * 401 to rule out "token simply expired").
 */
HealthMonitor.prototype._getTargetOAuthToken = function _getTargetOAuthToken(config, forceRefresh) {
  const key = String(config._id || config.serviceName);
  const oauth = config.oauth || {};

  if (!forceRefresh) {
    const cached = this._targetTokenCache.get(key);
    if (cached && cached.expiresAt && Date.now() < cached.expiresAt) {
      return Promise.resolve(cached.token);
    }
  }

  if (!oauth.tokenUrl || !oauth.clientId || !oauth.clientSecret) return Promise.resolve(null);

  return fetchOAuthToken(oauth, config.insecureTLS)
    .then(({ token, expiresAt }) => {
      this._targetTokenCache.set(key, { token, expiresAt });
      return token;
    })
    .catch(() => null); // token endpoint unreachable/misconfigured - request will 401 with a clear message
};

/**
 * Compute the { header, queryToken } auth to apply to a request, given the
 * already-resolved platform token (adapters) and/or target token (OAuth2
 * integrations). At most one of header/queryToken is set.
 */
function resolveAuth(platform, config, platformToken, targetToken) {
  if (config.targetType === 'integration') {
    const mode = resolveTargetAuthMode(config);
    if (mode === 'basic') return { header: basicAuthHeader(config), queryToken: null };
    if (mode === 'bearer' && config.authToken) return { header: `Bearer ${config.authToken}`, queryToken: null };
    if (mode === 'oauth2' && targetToken) return { header: `Bearer ${targetToken}`, queryToken: null };
    return { header: null, queryToken: null }; // "none", or a mode that needs config that isn't set
  }

  // Adapter (or custom app) target: unchanged platformProps-driven behavior.
  if (platformToken && (platform.authMode === 'header' || platform.authMode === 'oauth2')) {
    return { header: `Bearer ${platformToken}`, queryToken: null };
  }
  if (platformToken && platform.authMode !== 'none') {
    return { header: null, queryToken: platformToken };
  }
  return { header: null, queryToken: null };
}

/**
 * Perform the actual HTTP request for one attempt, given precomputed auth.
 */
function sendRequest(config, url, auth) {
  const params = {};
  const headers = {};
  if (auth.header) headers.Authorization = auth.header;
  if (auth.queryToken) params.token = auth.queryToken;

  return axios.request({
    url,
    method: config.method || 'GET',
    params,
    headers,
    data: config.body || undefined, // JSON object -> axios sets Content-Type: application/json automatically
    timeout: config.timeoutMs || 5000,
    httpsAgent: config.insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
    validateStatus: () => true, // we classify status ourselves below
  });
}

/**
 * Alternative to axios: shell out to the system's own `curl` binary. Useful
 * as a diagnostic escape hatch when something in the request pipeline
 * (proxying, keep-alive behavior, TLS defaults, header casing, etc.)
 * behaves differently between axios and a plain curl call against the same
 * URL - if curl succeeds where the axios path doesn't, that narrows the
 * problem down to something Node/axios-specific rather than the target
 * itself. Enable per-check via the "Use curl" option in the Add/Edit form
 * (stored as config.useCurl).
 *
 * Emulates the same response shape consumed by _executeCheck: { status,
 * data }. Uses `-w '\n%{http_code}'` with no other output decoration so the
 * last line of stdout is always the numeric status code and everything
 * before it is the raw response body (parsed as JSON when possible).
 */
function sendRequestCurl(config, url, auth) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '--max-time', String(Math.max(1, Math.ceil((config.timeoutMs || 5000) / 1000)))];
    if (config.insecureTLS) args.push('-k');
    args.push('-X', config.method || 'GET');

    let finalUrl = url;
    if (auth.header) {
      args.push('-H', `Authorization: ${auth.header}`);
    } else if (auth.queryToken) {
      const sep = url.includes('?') ? '&' : '?';
      finalUrl = `${url}${sep}token=${encodeURIComponent(auth.queryToken)}`;
    }

    if (config.body !== undefined) {
      args.push('-H', 'Content-Type: application/json');
      args.push('-d', JSON.stringify(config.body));
    }

    args.push('-w', '\n%{http_code}');
    args.push(finalUrl);

    execFile('curl', args, { timeout: (config.timeoutMs || 5000) + 2000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        reject(new Error(`curl failed: ${stderr || err.message}`));
        return;
      }
      const trimmed = String(stdout || '').replace(/\s+$/, '');
      const lastNewline = trimmed.lastIndexOf('\n');
      const statusText = lastNewline === -1 ? trimmed : trimmed.slice(lastNewline + 1);
      const bodyText = lastNewline === -1 ? '' : trimmed.slice(0, lastNewline);
      const status = parseInt(statusText, 10) || 0;
      let data = bodyText;
      try { data = JSON.parse(bodyText); } catch (parseErr) { /* leave as raw text */ }
      resolve({ status, data });
    });
  });
}

/**
 * Dispatches to axios or curl depending on config.useCurl.
 */
function performRequest(config, url, auth) {
  return config.useCurl
    ? sendRequestCurl(config, url, auth)
    : sendRequest(config, url, auth);
}

/**
 * Resolves the actual credential values a check's auth mode needs,
 * transparently decrypting any $ENC-prefixed value read from a dot-path
 * into the target integration's OWN service_configs document
 * (config.credentialPaths.{username,password,authToken,clientId,
 * clientSecret,tokenUrl}). This is the alternative to typing a plaintext
 * override: nothing decrypted here is ever persisted - it's re-resolved
 * fresh on every check run, straight from IAP's own stored config, using
 * IAP's own real PropertyEncryption module and encryption key.
 *
 * Falls back to the literal config fields (authUsername/authPassword/
 * authToken/oauth.{clientId,clientSecret,tokenUrl}) for any path left
 * blank, so a check can mix "path" and "literal" per-field if needed (e.g.
 * a non-encrypted client_id read literally, alongside a decrypted secret).
 */
HealthMonitor.prototype._resolveTargetCredentials = function _resolveTargetCredentials(config) {
  const paths = config.credentialPaths || {};
  const literal = {
    username: config.authUsername,
    password: config.authPassword,
    authToken: config.authToken,
    clientId: (config.oauth || {}).clientId,
    clientSecret: (config.oauth || {}).clientSecret,
    tokenUrl: (config.oauth || {}).tokenUrl,
  };

  const hasAnyPath = Object.values(paths).some(Boolean);
  if (!hasAnyPath) return Promise.resolve(literal);

  return this._getDb()
    .then((db) => db.collection('service_configs').findOne({ name: config.serviceName }))
    .then((doc) => {
      if (!doc) {
        throw new Error(`Could not find a service_configs document named "${config.serviceName}" to resolve credential paths from.`);
      }
      const resolveOne = (dotPath, fallback) => {
        if (!dotPath) return fallback;
        const raw = resolveDotPath(doc, dotPath);
        if (raw === undefined) {
          throw new Error(`Credential path "${dotPath}" did not resolve to anything in "${config.serviceName}"'s service_configs document - double-check it against the real document shape.`);
        }
        try {
          return this._decryptIfEnc(raw);
        } catch (err) {
          throw new Error(`Failed to resolve value at "${dotPath}": ${err.message}`);
        }
      };
      return {
        username: resolveOne(paths.username, literal.username),
        password: resolveOne(paths.password, literal.password),
        authToken: resolveOne(paths.authToken, literal.authToken),
        clientId: resolveOne(paths.clientId, literal.clientId),
        clientSecret: resolveOne(paths.clientSecret, literal.clientSecret),
        tokenUrl: resolveOne(paths.tokenUrl, literal.tokenUrl),
      };
    });
};

HealthMonitor.prototype._executeCheck = function _executeCheck(config) {
  const platform = this._getPlatformConfig();
  const started = Date.now();
  const isIntegration = config.targetType === 'integration';
  const targetAuthMode = isIntegration ? resolveTargetAuthMode(config) : null;

  return (isIntegration ? this._resolveTargetCredentials(config) : Promise.resolve(null))
    .then((creds) => {
      // Merge resolved (possibly decrypted) credentials back into a config
      // shape the rest of the auth pipeline already understands - keeps
      // basicAuthHeader/_getTargetOAuthToken/resolveAuth unchanged.
      const effectiveConfig = creds ? Object.assign({}, config, {
        authUsername: creds.username,
        authPassword: creds.password,
        authToken: creds.authToken,
        oauth: Object.assign({}, config.oauth, {
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          tokenUrl: creds.tokenUrl,
        }),
      }) : config;

      // Fetch whichever token this check actually needs:
      //  - adapter checks: platformProps' token (unchanged behavior)
      //  - integration checks with targetAuthMode "oauth2": this check's own
      //    OAuth2 client-credentials token, entirely separate from platformProps
      //  - everything else (integration "none"/"basic"/"bearer"): no token fetch
      const getPlatformToken = (forceRefresh) => (!isIntegration ? this._getAuthToken(platform, forceRefresh) : Promise.resolve(null));
      const getTargetToken = (forceRefresh) => (targetAuthMode === 'oauth2' ? this._getTargetOAuthToken(effectiveConfig, forceRefresh) : Promise.resolve(null));

      return this._resolveCheckUrl(platform, config)
        .then((url) => Promise.all([getPlatformToken(false), getTargetToken(false)])
          .then(([platformToken, targetToken]) => {
            const auth = resolveAuth(platform, effectiveConfig, platformToken, targetToken);
            return performRequest(effectiveConfig, url, auth)
              .then((response) => {
                // A 401 might just mean the cached token expired - if we have a
                // way to get a new one, try exactly once more before reporting
                // unhealthy, rather than flapping every cycle on a token that
                // simply needs refreshing. Doesn't apply to static credentials
                // (Basic override, static bearer) - retrying with the "same"
                // credentials again would never help.
                const canRefresh = isIntegration
                  ? targetAuthMode === 'oauth2'
                  : (platform.authMode === 'oauth2' || !!platform.username);
                if (response.status === 401 && canRefresh) {
                  return Promise.all([getPlatformToken(true), getTargetToken(true)])
                    .then(([freshPlatformToken, freshTargetToken]) => performRequest(
                      effectiveConfig,
                      url,
                      resolveAuth(platform, effectiveConfig, freshPlatformToken, freshTargetToken),
                    ));
                }
                return response;
              });
          }));
    })
    .then((response) => {
      const responseTimeMs = Date.now() - started;
      const isHttpOk = response.status >= 200 && response.status < 300;
      const hasErrorPayload = response.data && typeof response.data === 'object' && 'error' in response.data;

      const lastResponseBody = stringifyResponseBody(response.data);

      if (isHttpOk && !hasErrorPayload) {
        return {
          state: 'healthy',
          lastCheckedAt: new Date(),
          lastResponseTimeMs: responseTimeMs,
          lastStatusCode: response.status,
          lastError: null,
          lastResponseBody,
        };
      }

      let lastError;
      if (response.status === 401 || response.status === 403) {
        if (targetAuthMode === 'basic') {
          lastError = `Authentication failed (${response.status}) - the target rejected the override username/password set on this check. Confirm the password is the real plaintext credential the target expects, NOT IAP's encrypted "$ENC..." value from service_configs (that string is only meaningful to IAP's own decryption key and will never work as a literal password).`;
        } else if (targetAuthMode === 'oauth2') {
          lastError = `Authentication failed (${response.status}) - this check's own oauth.{tokenUrl,clientId,clientSecret} was used to fetch a token for the target, but it was rejected. Confirm those values are correct for THIS target (they are independent of platformProps.oauth).`;
        } else if (targetAuthMode === 'bearer') {
          lastError = `Authentication failed (${response.status}) - the static override token (authToken) set on this check was rejected by the target.`;
        } else if (isIntegration) {
          lastError = `Authentication failed (${response.status}) - this integration requires authentication but this check's Auth type is set to "None". Set Auth type to Basic, Bearer token, or OAuth2 on this check.`;
        } else {
          lastError = `Authentication failed (${response.status}) - check platformProps.authMode and, depending on mode, authToken / username+password / oauth.{tokenUrl,clientId,clientSecret,scope,audience}`;
        }
      } else if (response.status === 404) {
        lastError = config.targetType === 'integration'
          ? `Not found (404) - confirm the path matches an operation in the integration's OpenAPI spec, and that the integration's configured server (protocol/host/port/base_path in Admin Essentials) is correct`
          : `Not found (404) - confirm serviceName matches the actual instance name IAP uses in its route, not just the adapter/integration package name`;
      } else if (hasErrorPayload) {
        lastError = JSON.stringify(response.data.error);
      } else {
        lastError = `Unexpected HTTP status ${response.status}`;
      }

      return {
        state: 'unhealthy',
        lastCheckedAt: new Date(),
        lastResponseTimeMs: responseTimeMs,
        lastStatusCode: response.status,
        lastError,
        lastResponseBody,
      };
    })
    .catch((err) => ({
      state: 'unhealthy',
      lastCheckedAt: new Date(),
      lastResponseTimeMs: Date.now() - started,
      lastStatusCode: (err.response && err.response.status) || null,
      lastResponseBody: err.response ? stringifyResponseBody(err.response.data) : null,
      lastError: err.message,
    }));
};

HealthMonitor.prototype._runAndPersist = function _runAndPersist(db, doc) {
  return this._executeCheck(doc).then((status) => db.collection(COLLECTION_NAME)
    .updateOne({ _id: doc._id }, { $set: { status } })
    .then(() => Object.assign({}, doc, { status })));
};

/**
 * In-process scheduler: every SCHEDULER_TICK_MS, look at every enabled
 * check and run any whose intervalSeconds has elapsed since its last run.
 * Deliberately simple (no external job queue/cron dependency) per the
 * "simple custom app" requirement - a single long-lived setInterval on the
 * app's own singleton instance, which stays resident for the life of the
 * service process.
 */
HealthMonitor.prototype.startScheduler = function startScheduler() {
  if (this.schedulerHandle) return;
  // console.error (not console.log) so this is visible regardless of
  // loggerProps.console_level - "warn" filters out console.log, per the
  // discovery made while debugging the OpenAPI Editor app.
  console.error(`[health-monitor] scheduler starting - tick every ${SCHEDULER_TICK_MS}ms`);
  let tickCount = 0;
  this.schedulerHandle = setInterval(() => {
    tickCount += 1;
    let dbRef;
    this._getDb()
      .then((db) => {
        dbRef = db;
        return db.collection(COLLECTION_NAME).find({ enabled: true }).toArray();
      })
      .then((docs) => {
        const now = Date.now();
        const due = docs.filter((doc) => {
          const last = doc.status && doc.status.lastCheckedAt ? new Date(doc.status.lastCheckedAt).getTime() : 0;
          const intervalMs = (doc.intervalSeconds || 300) * 1000;
          return now - last >= intervalMs;
        });
        console.error(`[health-monitor] scheduler tick #${tickCount}: ${docs.length} enabled check(s), ${due.length} due`);
        return Promise.all(due.map((doc) => this._runAndPersist(dbRef, doc).catch((err) => {
          console.error(`[health-monitor] scheduled run failed for check "${doc.name}":`, err && err.message);
          return null;
        })));
      })
      .catch((err) => {
        // Still log it (was previously silently swallowed) - a persistent
        // Mongo connection issue here would otherwise look identical to the
        // scheduler simply not running at all.
        console.error('[health-monitor] scheduler tick failed:', err && err.message);
      });
  }, SCHEDULER_TICK_MS);
  // NOTE: deliberately NOT calling .unref() here anymore. unref() means this
  // timer alone will never keep the process's event loop alive - if nothing
  // else in this service's process happens to be holding the loop open
  // between BullMQ messages, the scheduler could go idle or the process
  // could exit between ticks. Since the whole point of this timer is to run
  // unattended in the background, it should always keep the process alive.
};

/**
 * Distinguishes an Integration instance from a real Adapter instance in
 * service_configs, based directly on a live-confirmed pattern in the
 * `model` field - NOT the document's own `type` field, which is unreliable
 * here: integrations are stored in service_configs as "virtual" documents
 * that carry `"type": "Adapter"` even though they are not actual adapters
 * (see the README's "Calling integrations vs. adapters" section). Relying
 * on `type` alone is exactly what caused integrations like "IAP65" to show
 * up mislabeled as "(adapter)" in the Add/Edit Check dropdown.
 *
 * The real, reliable signal is the `model` string's shape:
 *   - Adapter example:      "@itential/adapter-automation_gateway"
 *   - Integration example:  "@itential/adapter_IAP REST API:1.0.0"
 * An integration's model always ends in "<Display Name>:<version>" (a
 * colon followed by a dotted version number); a plain adapter's model never
 * has that trailing ":<version>" suffix. That trailing pattern is the
 * trigger checked below - its presence means integration, its absence means
 * either an adapter or a custom app (distinguished next by the `model`
 * string's own package-name pattern), falling back to the document's own
 * `type`/`unknown` only when there's no `model` string to inspect at all.
 */
function classifyTargetType(doc) {
  const model = typeof doc.model === 'string' ? doc.model : '';
  const looksLikeIntegration = /:\s*\d+(?:\.\d+){0,3}\s*$/.test(model);
  if (looksLikeIntegration) return 'integration';
  // Custom apps' own package ids follow @itential/app-<name> or
  // @itential/app_<name> (confirmed from this app's and the OpenAPI
  // Editor's own pronghorn.json `id` fields), distinct from adapters'
  // @itential/adapter-<name> pattern. Check this before falling back to
  // the generic "any model string means adapter" assumption, otherwise
  // apps and adapters get lumped into one bucket.
  if (/@itential\/app[-_]/i.test(model)) return 'app';
  if (model) return 'adapter';
  return (doc.type || 'unknown').toLowerCase();
}

/**
 * GET /health-monitor/targets
 * Best-effort listing of installed adapter/integration/app instances, read
 * directly from the same Mongo database IAP itself uses to track them, so
 * the "Add Check" form can offer a dropdown instead of requiring the exact
 * route/instance name to be typed in by hand.
 *
 * IMPORTANT: this reads from the `service_configs` collection based on a
 * single internal reference ("IAP Configuration" - each service's resolved
 * config document is matched by a `name` field in service_configs, and its
 * profile by `id` in iap_profiles). This has NOT been confirmed against a
 * live instance's actual document shape. Treat the returned list as a
 * convenience only - inspect `db.service_configs.findOne()` yourself before
 * trusting it, and the manual "Custom..." entry in the UI always remains
 * available if this comes back empty or wrong.
 */
HealthMonitor.prototype.listTargets = function listTargets(callback) {
  this._getDb()
    .then((db) => db.collection('service_configs')
      .find({}, { projection: { name: 1, type: 1, model: 1 } })
      .toArray())
    .then((docs) => {
      const seen = new Set();
      const targets = docs
        .map((doc) => ({
          name: doc.name,
          type: classifyTargetType(doc),
        }))
        .filter((t) => {
          if (!t.name || seen.has(t.name)) return false;
          seen.add(t.name);
          return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      callback(targets);
    })
    .catch((err) => callback(null, err));
};

/**
 * GET /health-monitor/targets/:name/operations
 *
 * For an Integration target, looks up its own OpenAPI model (the same
 * integration_models document app-openapi_editor edits) and returns the
 * list of operations it defines, so the Add/Edit Check form can offer a
 * "pick from this integration's own API" picker instead of requiring the
 * method/path to be typed in by hand - mirroring what the OpenAPI Editor's
 * own Operations/Test tabs already do for the same documents.
 *
 * The link from an instance name to its model is the same one confirmed
 * for app-openapi_editor's sanctioned update process: the instance's own
 * service_configs.properties.type field IS the model's versionId - NOT a
 * `model` field on the model document (which doesn't exist), and not a
 * naive match on the instance's own top-level `model` string.
 *
 * If the model has an operation marked `x-health-monitor-default: true`
 * (set from the OpenAPI Editor's Operations tab - click the star next to
 * any operation), that operation is returned separately as
 * `defaultOperation` so the UI can pre-fill method/path with it the first
 * time a target is selected, without forcing that choice - the picker
 * still lets you choose any other operation instead.
 *
 * Deliberately NOT attempted for adapters/apps in this version - those
 * don't have a document in integration_models the way Integrations do, so
 * this will simply come back with an empty operations list for them (not
 * an error) until/unless a similar lookup is confirmed for that case.
 */
HealthMonitor.prototype.getIntegrationOperations = function getIntegrationOperations(serviceName, callback) {
  this._getDb()
    .then((db) => db.collection('service_configs')
      .findOne({ name: serviceName }, { projection: { 'properties.type': 1 } })
      .then((svcDoc) => {
        const versionId = svcDoc && svcDoc.properties && svcDoc.properties.type;
        if (!versionId) return { versionId: null, defaultOperation: null, operations: [] };

        return db.collection(INTEGRATION_MODELS_COLLECTION).findOne({ versionId }).then((modelDoc) => {
          if (!modelDoc || !modelDoc.paths) return { versionId, defaultOperation: null, operations: [] };

          const operations = [];
          let defaultOperation = null;
          Object.keys(modelDoc.paths).forEach((path) => {
            const pathItem = modelDoc.paths[path] || {};
            HTTP_METHODS.forEach((method) => {
              // DELETE is deliberately not offered as a health-check call for now -
              // health checks should be safe, read-mostly probes, not destructive calls.
              if (method === 'delete') return;
              const op = pathItem[method];
              if (!op) return;
              const entry = {
                method: method.toUpperCase(),
                path,
                summary: op.summary || op.operationId || '',
                isDefault: !!op['x-health-monitor-default'],
              };
              operations.push(entry);
              if (entry.isDefault) defaultOperation = { method: entry.method, path: entry.path };
            });
          });

          return { versionId, defaultOperation, operations };
        });
      }))
    .then((result) => callback(result))
    .catch((err) => callback(null, err));
};

/**
 * GET /health-monitor/checks
 */
HealthMonitor.prototype.listChecks = function listChecks(callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).find({}).sort({ name: 1 }).toArray())
    .then((docs) => callback(docs.map(serialize)))
    .catch((err) => callback(null, err));
};

/**
 * POST /health-monitor/encrypt-value
 * Admin utility, not used by this app's own UI: hands back the
 * $ENC...-encrypted form of a plaintext string using the exact same
 * _encryptForStorage call createCheck/updateCheck now use automatically.
 * Meant to be called by hand (e.g. via Admin Essentials' API browser,
 * POSTing { "value": "the-plaintext-secret" } - note the body must be
 * wrapped under the declared input name "value", same convention every
 * object/string-bodied route in this engagement has needed) to produce an
 * $ENC... string an admin can paste into ANY app's Service Instance
 * properties instead of leaving a credential in plaintext there - e.g.
 * this app's own mongoProps.password, or platformProps.oauth.clientSecret.
 * Persists nothing.
 */
HealthMonitor.prototype.encryptValue = function encryptValue(value, callback) {
  try {
    callback({ encrypted: this._encryptForStorage(value) });
  } catch (err) {
    callback(null, err);
  }
};

/**
 * GET /health-monitor/checks/:checkId
 */
HealthMonitor.prototype.getCheck = function getCheck(checkId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(checkId) }))
    .then((doc) => {
      if (!doc) return callback(null, new Error(`No health check found for id ${checkId}`));
      return callback(serialize(doc));
    })
    .catch((err) => callback(null, err));
};

/**
 * POST /health-monitor/checks
 * config: { name, targetType, serviceName, method, path, intervalSeconds,
 *           timeoutMs, enabled, body? }
 */
HealthMonitor.prototype.createCheck = function createCheck(config, callback) {
  let encryptedConfig;
  try {
    // Encrypts authPassword/authToken/oauth.clientSecret (if present and
    // not already $ENC-prefixed) before this document ever reaches Mongo -
    // see _encryptForStorage/_encryptCheckSecrets above for why this app,
    // unlike the Editor app, still needs a real standing credential
    // (unattended, scheduled) and this is the mitigation available to it.
    encryptedConfig = this._encryptCheckSecrets(config);
  } catch (err) {
    // Fail CLOSED, not open: if encryption isn't working, refuse to save
    // rather than silently writing plaintext secrets to Mongo. Caught here
    // (not left to throw) because an uncaught exception kills this
    // service's entire process, not just this one request - see
    // LESSONS_LEARNED.md from earlier in this engagement.
    return callback(null, err);
  }

  const doc = Object.assign({
    targetType: 'adapter',
    targetAuthMode: 'none',
    method: 'GET',
    intervalSeconds: 300,
    timeoutMs: 5000,
    enabled: true,
    useCurl: false,
  }, encryptedConfig, {
    status: defaultStatus(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).insertOne(doc))
    .then((result) => callback(serialize(Object.assign({}, doc, { _id: result.insertedId }))))
    .catch((err) => callback(null, err));
};

/**
 * PUT /health-monitor/checks/:checkId
 */
HealthMonitor.prototype.updateCheck = function updateCheck(checkId, config, callback) {
  let encryptedConfig;
  try {
    encryptedConfig = this._encryptCheckSecrets(config);
  } catch (err) {
    return callback(null, err);
  }

  const update = Object.assign({}, encryptedConfig, { updatedAt: new Date() });
  delete update._id;
  delete update.id;
  delete update.status; // status is only ever written by the checker itself

  return this._getDb()
    .then((db) => db.collection(COLLECTION_NAME)
      .findOneAndUpdate(
        { _id: new ObjectId(checkId) },
        { $set: update },
        { returnDocument: 'after' },
      ))
    .then((result) => {
      const doc = result.value || result; // driver version differences
      if (!doc) return callback(null, new Error(`No health check found for id ${checkId}`));
      return callback(serialize(doc));
    })
    .catch((err) => callback(null, err));
};

/**
 * DELETE /health-monitor/checks/:checkId
 */
HealthMonitor.prototype.deleteCheck = function deleteCheck(checkId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).deleteOne({ _id: new ObjectId(checkId) }))
    .then((result) => callback({ success: true, deletedCount: result.deletedCount }))
    .catch((err) => callback(null, err));
};

/**
 * POST /health-monitor/checks/:checkId/run
 * Runs a check immediately, independent of its schedule, and returns the
 * updated status - used by the UI's "Run Now" button.
 */
HealthMonitor.prototype.runCheckNow = function runCheckNow(checkId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(checkId) })
      .then((doc) => {
        if (!doc) throw new Error(`No health check found for id ${checkId}`);
        return this._runAndPersist(db, doc);
      }))
    .then((updated) => callback(serialize(updated)))
    .catch((err) => callback(null, err));
};

/**
 * Restart the adapter or app a check targets (stop, then start), via
 * Itential Platform's own service-management REST API:
 *   PUT /adapters/{name}/stop      PUT /adapters/{name}/start
 *   PUT /applications/{name}/stop  PUT /applications/{name}/start
 * (confirmed against docs.itential.com/itential-platform/6/api-reference/,
 * both the Adapters and Applications categories - "applications" is the
 * route segment for what this app calls targetType "app"). There is no
 * single "restart" call; a stop followed by a start is the sanctioned
 * sequence, with a short pause between them so the process has a moment to
 * fully exit before being asked to start again.
 *
 * Deliberately NOT offered for targetType "integration" - restarting a
 * process is a concept that only applies to adapters/apps, which run as
 * their own long-lived Node.js service. An Integration has no separate
 * running process of its own to restart (see README 3.2.2 on why
 * integrations are architecturally different from adapters).
 *
 * Auth: these are platform administration routes, documented with Basic
 * auth (BasicAuth security scheme) - this uses platformProps.username/
 * password directly for that reason, distinct from the authMode/oauth2/
 * token machinery _getAuthToken provides for calling into an adapter's own
 * task routes. Not yet confirmed end-to-end against a live instance - if
 * this 401s even with valid platformProps.username/password, check
 * whether your build instead expects the same bearer/oauth2 token
 * _getAuthToken already knows how to fetch, and adjust the auth block
 * below accordingly.
 */
HealthMonitor.prototype._restartService = function _restartService(name, targetType, callback) {
  const platform = this._getPlatformConfig();
  const base = String(platform.baseUrl || '').replace(/\/+$/, '');
  const segment = targetType === 'app' ? 'applications' : 'adapters';
  const authConfig = platform.username
    ? { auth: { username: platform.username, password: platform.password } }
    : {};

  const call = (verb) => axios.put(`${base}/${segment}/${encodeURIComponent(name)}/${verb}`, {}, {
    timeout: 15000,
    // Same platformProps.insecureTLS toggle used for token/login calls and
    // for the actual check requests - restarting an Adapter/App hits
    // Platform's own baseUrl too, so it needs the same self-signed-cert
    // escape hatch.
    httpsAgent: platform.insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
    ...authConfig,
  });

  call('stop')
    .then(() => new Promise((resolve) => { setTimeout(resolve, 1500); }))
    .then(() => call('start'))
    .then((res) => {
      callback({
        success: true,
        status: (res.data && res.data.status) || 'OK',
        message: (res.data && res.data.message) || `${name} restarted.`,
      });
    })
    .catch((err) => {
      const message = (err.response && err.response.data && err.response.data.message)
        || err.message;
      callback({ success: false, message: `Restart failed: ${message}` });
    });
};

/**
 * POST /health-monitor/checks/:checkId/restart
 * Looks up the check's own target (serviceName/targetType) and restarts
 * that adapter/app. Rejects targetType "integration" outright - see
 * _restartService above for why that's not a supported action.
 */
HealthMonitor.prototype.restartTarget = function restartTarget(checkId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(checkId) }))
    .then((doc) => {
      if (!doc) throw new Error(`No health check found for id ${checkId}`);
      if (doc.targetType === 'integration') {
        throw new Error('Restart does not apply to Integrations - only Adapters and Apps have a running process to restart.');
      }
      return new Promise((resolve) => {
        this._restartService(doc.serviceName, doc.targetType, resolve);
      });
    })
    .then((result) => callback(result))
    .catch((err) => callback({ success: false, message: err.message }));
};

module.exports = new HealthMonitor();
