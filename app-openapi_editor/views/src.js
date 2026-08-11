/**
 * @itential/app-openapi_editor
 *
 * Cog (server-side business logic) for a custom Itential Platform app that
 * lets a user view and edit the OpenAPI documents IAP stores for Integration
 * Models, in the `integration_models` MongoDB collection.
 *
 * Each document in that collection is a full OpenAPI 3.0.x / 3.1.0 spec
 * object (see README.md for a real example), keyed by Mongo's _id
 * (ObjectId) and also carrying a human-readable `versionId` field (e.g.
 * "MockServer API:1.0.0"). Both `_id` and `versionId` are Itential/Mongo
 * bookkeeping fields, not part of the OpenAPI spec itself - this cog strips
 * them out before handing a document to the client for editing/validation/
 * rendering, and re-attaches/recomputes them only at the moment it writes
 * back to Mongo. See getModel/saveModel below.
 *
 * This file intentionally uses the plain MongoDB Node.js driver rather than
 * IAP's internal Integration Model management APIs, per the customer's
 * request to read/write the document directly. If your IAP build exposes a
 * supported Integration Model REST API for your version, prefer calling that
 * instead of writing to this collection directly - see the guide doc for the
 * tradeoffs.
 */

const { MongoClient, ObjectId } = require('mongodb');
const SwaggerParser = require('@apidevtools/swagger-parser');
const axios = require('axios');
const https = require('https');
const { execFile } = require('child_process');

const COLLECTION_NAME = 'integration_models';

// Reused whenever a test call has insecureTLS enabled - skips certificate
// verification entirely, for self-signed/internal endpoints. Same pattern
// established for app-integration_health_monitor.
const INSECURE_HTTPS_AGENT = new https.Agent({ rejectUnauthorized: false });

// Confirmed against a live Platform 6 instance (see
// app-integration_health_monitor's README for the full discovery): this is
// the real package IAP's own core code uses to decrypt legacy $ENC-prefixed
// values. Required by absolute path since this app's own directory isn't
// necessarily nested under /opt/itential/platform/server, so normal Node
// module resolution wouldn't otherwise find it.
const ITENTIAL_UTILS_PATH = '/opt/itential/platform/server/node_modules/@itential/itential-utils';

function OpenApiEditor() {
  this.client = null;
  // Cached OAuth2 token for calls to Itential's own Integration Model/
  // Integrations REST API - see _getPlatformOAuthToken.
  this._platformToken = null;
  this._platformTokenExpiresAt = null;
  // undefined = not yet resolved; null = resolved and unavailable - same
  // lazy-init pattern as app-integration_health_monitor.
  this._propertyEncryption = undefined;
}

/**
 * Lazily construct (once) IAP's own PropertyEncryption helper, using the
 * process-wide `pronghornProps` global for its encryptionKey/vaultProps.
 * Ported verbatim from app-integration_health_monitor - see that app's
 * README for the full discovery narrative on why this works.
 */
OpenApiEditor.prototype._getPropertyEncryption = function _getPropertyEncryption() {
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
 * If `value` is a legacy $ENC-prefixed string, decrypt it fresh using IAP's
 * own encryption key; otherwise return it unchanged. This is what lets
 * platformProps.oauth.clientId/clientSecret (and platformProps.password)
 * be stored as $ENC... instead of plaintext in this app's own Service
 * Instance properties - nothing decrypted here is ever persisted, it's
 * re-resolved on every use.
 */
OpenApiEditor.prototype._decryptIfEnc = function _decryptIfEnc(value) {
  if (typeof value !== 'string' || !value.startsWith('$ENC')) return value;
  const enc = this._getPropertyEncryption();
  if (!enc) {
    throw new Error('Value is $ENC-encrypted, but IAP\'s PropertyEncryption module could not be loaded (pronghornProps.encryptionKey unavailable, or @itential/itential-utils not found at the expected path) - cannot decrypt it.');
  }
  try {
    return enc.newDecryption(value);
  } catch (err) {
    throw new Error(`Failed to decrypt an $ENC value: ${err.message}`);
  }
};

/**
 * Lazily open (and cache) a single MongoClient for the life of the app.
 *
 * On this IAP build, the resolved service instance properties (the
 * "properties" block of this app's properties.json, containing mongoProps)
 * are exposed via a process-wide implicit global named `service_config`,
 * set up by /opt/itential/platform/server/core/Service/ServiceBootstrap.js
 * at service startup - NOT via a bare `properties` global as older Pronghorn
 * docs describe. Confirmed against a live Platform 6 instance.
 */
OpenApiEditor.prototype._getDb = function _getDb() {
  const instanceProps = (typeof service_config !== 'undefined' && service_config && service_config.properties)
    ? service_config.properties
    : {};

  const props = instanceProps.mongoProps || {
    host: process.env.OPENAPI_EDITOR_MONGO_HOST || '127.0.0.1',
    port: process.env.OPENAPI_EDITOR_MONGO_PORT || 27017,
    database: process.env.OPENAPI_EDITOR_MONGO_DB || 'itential-master',
  };

  const auth = props.username
    ? `${encodeURIComponent(props.username)}:${encodeURIComponent(props.password)}@`
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
 * Derive the `versionId` bookkeeping field IAP stores alongside each
 * integration model, from the spec's own info.title/info.version - e.g.
 * "MockServer API:1.0.0". Recomputed on every save so it never drifts out
 * of sync if a user edits the title or version in the editor.
 */
function computeVersionId(spec) {
  const title = (spec && spec.info && spec.info.title) || 'Untitled API';
  const version = (spec && spec.info && spec.info.version) || '0.0.0';
  return `${title}:${version}`;
}

/**
 * Strip the Mongo/Itential-only fields off a raw document, leaving a pure
 * OpenAPI 3.0.x/3.1.0 object suitable for editing, validation, and rendering
 * (e.g. in swagger-ui-react).
 *
 * `model` was added to this list after confirming (via IAP's own
 * GET /integration-models/{name} REST API response shape - see README) that
 * a real integration_models document carries a top-level `model` field (a
 * package-style identifier like "@itential/adapter_GitHub:v5") alongside
 * `versionId`/`properties` - it is bookkeeping, not part of the OpenAPI
 * document itself, and is needed later (see safeUpdateModel) to look up
 * which live Integration instances are built from this model.
 */
function toPureSpec(doc) {
  const spec = Object.assign({}, doc);
  delete spec._id;
  delete spec.versionId;
  delete spec.model;
  return spec;
}

/**
 * Where to reach Itential Platform's own REST API for the sanctioned
 * Integration Model / Integrations endpoints used by safeUpdateModel below -
 * distinct from mongoProps (direct DB access) and from a test call's own
 * per-request auth. Configure under this app's own Service Instance
 * properties - see sampleProperties.json.
 *
 * authMode:
 *   "oauth2" - OAuth2 client-credentials grant (oauth.tokenUrl/clientId/
 *              clientSecret[/scope/audience]), sent as
 *              Authorization: Bearer <token>. Required on builds where
 *              Basic auth against these routes returns 401 even with valid
 *              platform credentials - confirmed to be the case here.
 *   "basic"  - HTTP Basic (username/password) - IAP's own documented
 *              default for this API, but not usable on every build/account.
 * Defaults to "oauth2" if oauth.tokenUrl is set, else "basic" if username
 * is set, else "none" (calls will fail with a clear 401/403 rather than
 * silently sending no auth).
 */
OpenApiEditor.prototype._getPlatformApiConfig = function _getPlatformApiConfig() {
  const instanceProps = (typeof service_config !== 'undefined' && service_config && service_config.properties)
    ? service_config.properties
    : {};
  return instanceProps.platformProps || {
    baseUrl: process.env.OPENAPI_EDITOR_PLATFORM_URL || 'http://127.0.0.1:3000',
    authMode: process.env.OPENAPI_EDITOR_PLATFORM_AUTH_MODE || 'basic',
    username: process.env.OPENAPI_EDITOR_PLATFORM_USERNAME || '',
    password: process.env.OPENAPI_EDITOR_PLATFORM_PASSWORD || '',
    oauth: {
      tokenUrl: process.env.OPENAPI_EDITOR_PLATFORM_OAUTH_TOKEN_URL || '',
      clientId: process.env.OPENAPI_EDITOR_PLATFORM_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.OPENAPI_EDITOR_PLATFORM_OAUTH_CLIENT_SECRET || '',
      scope: process.env.OPENAPI_EDITOR_PLATFORM_OAUTH_SCOPE || '',
      audience: process.env.OPENAPI_EDITOR_PLATFORM_OAUTH_AUDIENCE || '',
    },
  };
};

function resolvePlatformAuthMode(platform) {
  if (platform.authMode) return platform.authMode;
  if (platform.oauth && platform.oauth.tokenUrl) return 'oauth2';
  if (platform.username) return 'basic';
  return 'none';
}

/**
 * Fetch (and cache, refreshed 15s before expiry) an OAuth2 access token via
 * the client-credentials grant for calling Itential's own REST API - kept
 * separate from the per-test-call fetchOAuthToken() below, which is never
 * cached since test calls are ad hoc/interactive against arbitrary targets.
 * This one backs repeated calls within a single multi-step save (delete/
 * delete/put/post/post...), so caching avoids a token fetch per step.
 */
OpenApiEditor.prototype._getPlatformOAuthToken = function _getPlatformOAuthToken(platform, forceRefresh) {
  if (!forceRefresh && this._platformToken && this._platformTokenExpiresAt && Date.now() < this._platformTokenExpiresAt) {
    return Promise.resolve(this._platformToken);
  }
  const oauth = platform.oauth || {};
  if (!oauth.tokenUrl || !oauth.clientId || !oauth.clientSecret) {
    return Promise.reject(new Error('platformProps.authMode is "oauth2" but oauth.tokenUrl/clientId/clientSecret are not fully configured.'));
  }

  // clientId/clientSecret may be stored as $ENC...-encrypted values instead
  // of plaintext in this app's own Service Instance properties - decrypted
  // fresh on every token fetch using IAP's own encryption key, never
  // persisted anywhere. Plain (non-$ENC) values pass through unchanged.
  let clientId;
  let clientSecret;
  try {
    clientId = this._decryptIfEnc(oauth.clientId);
    clientSecret = this._decryptIfEnc(oauth.clientSecret);
  } catch (err) {
    return Promise.reject(err);
  }

  const params = new URLSearchParams();
  params.set('grant_type', 'client_credentials');
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  if (oauth.scope) params.set('scope', oauth.scope);
  if (oauth.audience) params.set('audience', oauth.audience);

  return axios.post(oauth.tokenUrl, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 8000,
  }).then((response) => {
    const token = response.data && response.data.access_token;
    const expiresInSec = (response.data && response.data.expires_in) || 300;
    if (!token) throw new Error('OAuth2 token endpoint did not return an access_token.');
    this._platformToken = token;
    this._platformTokenExpiresAt = Date.now() + (expiresInSec * 1000) - 15000;
    return token;
  });
};

/**
 * Thin wrapper around axios for calls to IAP's own Integration Model /
 * Integrations REST API (JSON body). Every real request/response shape
 * used here was confirmed against Itential's own published API reference
 * (docs.itential.com/itential-platform/6/api-reference/integration-models/*
 * and .../integrations/*) - see README for the exact pages and example
 * bodies. Retries exactly once on 401 with a freshly-fetched OAuth2 token,
 * in case the cached one simply expired mid-save.
 */
OpenApiEditor.prototype._platformApiRequest = function _platformApiRequest(method, path, data) {
  const platform = this._getPlatformApiConfig();
  const mode = resolvePlatformAuthMode(platform);
  const base = String(platform.baseUrl || '').replace(/\/+$/, '');

  const getAuth = (forceRefresh) => {
    if (mode === 'oauth2') {
      return this._getPlatformOAuthToken(platform, forceRefresh).then((token) => ({ header: `Bearer ${token}` }));
    }
    if (mode === 'basic') {
      try {
        return Promise.resolve({ basic: { username: platform.username, password: this._decryptIfEnc(platform.password) } });
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return Promise.resolve({});
  };

  const attempt = (auth) => axios.request({
    url: `${base}${path}`,
    method,
    data,
    auth: auth.basic,
    headers: Object.assign({ 'Content-Type': 'application/json' }, auth.header ? { Authorization: auth.header } : {}),
    timeout: 20000,
    validateStatus: () => true,
  });

  return getAuth(false)
    .then((auth) => attempt(auth).then((response) => ({ response, auth })))
    .then(({ response, auth }) => {
      if (response.status === 401 && mode === 'oauth2') {
        return getAuth(true).then((freshAuth) => attempt(freshAuth));
      }
      return response;
    })
    .then((response) => {
      if (response.status >= 200 && response.status < 300) return response.data;
      const message = (response.data && response.data.message) || `HTTP ${response.status}`;
      throw new Error(`${method} ${path} failed: ${message}`);
    });
};

/**
 * The integration_models collection does NOT carry a `model` field (an
 * earlier assumption, based on IAP's GET /integration-models/{name} API
 * response shape, turned out wrong - confirmed against a real document,
 * which only has `versionId`). The actual link between a model and its
 * instances is: an instance's own `properties.type` (nested inside its
 * service_configs document) equals the model's `versionId` exactly (e.g.
 * both "IAP:1.0.0"). An instance's top-level `model` string is in turn
 * always exactly "@itential/adapter_" + versionId (confirmed against three
 * separate real examples: "IAP:1.0.0" -> "@itential/adapter_IAP:1.0.0",
 * "GitHub:v5" -> "@itential/adapter_GitHub:v5") - so it's derived here
 * rather than trusted from a stored field on either side.
 */
function deriveModelIdentifier(versionId) {
  return versionId ? `@itential/adapter_${versionId}` : '';
}

/**
 * Finds every live Integration instance built from a given model (matched
 * by the model's OWN versionId against each instance's properties.type),
 * by reading service_configs directly (read-only, safe) rather than the
 * REST API's generic filter query params (?equalsField=...&equals=...),
 * which haven't been exercised against a live instance the way this direct
 * read has. Returns full raw documents (minus _id) so they can double as
 * both the "what would this affect" preview AND the backup payload used to
 * recreate them later - see safeUpdateModel.
 */
OpenApiEditor.prototype._findAssociatedIntegrations = function _findAssociatedIntegrations(versionId) {
  if (!versionId) return Promise.resolve([]);
  return this._getDb()
    .then((db) => db.collection('service_configs').find({ 'properties.type': versionId }).toArray())
    .then((docs) => docs.map((doc) => {
      const copy = Object.assign({}, doc);
      delete copy._id;
      return copy;
    }));
};

/**
 * GET /openapi-editor/models/:modelId/update-impact
 * Read-only preview of what a Save on this model would affect - used by the
 * UI to show the "this will remove and reapply..." warning with the real
 * list of dependent Integration instances (if any) BEFORE anything is
 * changed, and to let the user download a backup up front. Never mutates
 * anything.
 */
OpenApiEditor.prototype.getUpdateImpact = function getUpdateImpact(modelId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(modelId) }))
    .then((doc) => {
      if (!doc) throw new Error(`No integration model found for id ${modelId}`);
      return this._findAssociatedIntegrations(doc.versionId).then((integrations) => callback({
        versionId: doc.versionId,
        model: deriveModelIdentifier(doc.versionId),
        associatedIntegrations: integrations.map((i) => ({ name: i.name, type: i.type, description: i.description })),
        backup: {
          model: toPureSpec(doc),
          meta: { versionId: doc.versionId, model: deriveModelIdentifier(doc.versionId) },
          integrations,
        },
      }));
    })
    .catch((err) => callback(null, err));
};

/**
 * GET /openapi-editor/models
 * List every integration model as a lightweight summary for the sidebar.
 */
OpenApiEditor.prototype.listModels = function listModels(callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME)
      .find({}, { projection: { _id: 1, info: 1, openapi: 1, versionId: 1 } })
      .toArray())
    .then((docs) => {
      const models = docs.map((doc) => ({
        id: doc._id.toString(),
        title: doc.info && doc.info.title,
        version: doc.info && doc.info.version,
        openapiVersion: doc.openapi,
        versionId: doc.versionId,
      }));
      callback(models);
    })
    .catch((err) => callback(null, err));
};

/**
 * GET /openapi-editor/models/:modelId
 * Fetch one model, split into:
 *   - spec: the pure OpenAPI document (openapi/info/servers/paths/...),
 *     safe to hand straight to a JSON editor or swagger-ui-react.
 *   - meta: the Itential/Mongo bookkeeping fields (id, versionId) that are
 *     NOT part of the OpenAPI spec, needed only when writing back to Mongo.
 */
OpenApiEditor.prototype.getModel = function getModel(modelId, callback) {
  this._getDb()
    .then((db) => db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(modelId) }))
    .then((doc) => {
      if (!doc) {
        return callback(null, new Error(`No integration model found for id ${modelId}`));
      }
      return callback({
        spec: toPureSpec(doc),
        meta: {
          id: doc._id.toString(),
          versionId: doc.versionId,
          model: deriveModelIdentifier(doc.versionId),
        },
      });
    })
    .catch((err) => callback(null, err));
};

/**
 * Shared validation helper. Supports OpenAPI 3.0.x and 3.1.0 (via
 * @apidevtools/swagger-parser, which validates 3.1 documents natively as of
 * its current major version - no special-casing needed here beyond keeping
 * that dependency reasonably current). swagger-parser mutates $ref pointers
 * when it dereferences, so we validate a deep clone and return the
 * *original* document back to the caller untouched.
 */
function validateSpec(spec) {
  const clone = JSON.parse(JSON.stringify(spec));
  return SwaggerParser.validate(clone)
    .then(() => ({ valid: true, errors: [] }))
    .catch((err) => ({
      valid: false,
      errors: [err.message],
    }));
}

/**
 * POST /openapi-editor/models/validate
 * Validate a candidate spec (pure OpenAPI document, no _id/versionId)
 * without persisting it - used by the UI's "Validate" button before Save.
 */
OpenApiEditor.prototype.validateModel = function validateModelMethod(spec, callback) {
  validateSpec(spec)
    .then((result) => callback(result))
    .catch((err) => callback(null, err));
};

/**
 * POST /openapi-editor/models
 *
 * Creates a brand-new Integration Model. This is deliberately a much
 * simpler path than saveModel's sanctioned update sequence below: a new
 * model has no existing Integration instances to delete/recreate, so the
 * only thing that needs to happen is the actual creation call - Itential's
 * own POST /integration-models IS the sanctioned way to create a model,
 * with no cleanup dance required.
 *
 * What this does NOT do, on purpose: it does not create an Integration
 * instance for the new model. Creating a model and creating an instance of
 * that model are two different, independently-sanctioned actions in
 * Itential Platform - this app's scope is the model definition itself.
 * Once a model is created here, use Itential Platform's own normal process
 * (Admin Essentials -> Integrations -> Add, or however your build performs
 * it) to create an instance against it, the same way you would for any
 * other model that already existed. The UI surfaces this explicitly after
 * a successful create (see App.jsx).
 */
OpenApiEditor.prototype.createModel = function createModel(spec, callback) {
  const steps = [];
  const recordStep = (name, ok, detail) => steps.push({ name, ok, detail: detail || null });

  validateSpec(spec)
    .then((validation) => {
      if (!validation.valid) {
        return callback({ success: false, steps, errors: validation.errors });
      }
      recordStep('Validate spec', true);

      const versionId = computeVersionId(spec);
      let db;

      return this._getDb()
        .then((database) => {
          db = database;
          return db.collection(COLLECTION_NAME).findOne({ versionId });
        })
        .then((existing) => {
          if (existing) {
            throw new Error(
              `A model with versionId "${versionId}" already exists (title + version must be unique) `
              + '- edit the existing model instead of creating a new one, or change info.title/info.version.',
            );
          }
          return this._platformApiRequest('POST', '/integration-models', { model: spec });
        })
        .then(() => {
          recordStep(`Create integration model "${versionId}"`, true);
          // Re-read the newly-created document to get Mongo's own _id, so
          // the UI can immediately select/open it like any other model.
          return db.collection(COLLECTION_NAME).findOne({ versionId });
        })
        .then((created) => {
          callback({
            success: true,
            steps,
            versionId,
            model: deriveModelIdentifier(versionId),
            modelId: created && created._id ? created._id.toString() : null,
            errors: [],
          });
        })
        .catch((err) => {
          recordStep(`Create integration model "${versionId}"`, false, err.message);
          callback({
            success: false,
            steps,
            errors: [err.message],
          });
        });
    })
    .catch((err) => callback(null, err));
};

/**
 * PUT /openapi-editor/models/:modelId
 *
 * Updates an integration model the way Itential Platform's own tooling
 * does it, NOT via a direct Mongo write. Confirmed against Itential's
 * documentation (see README) that Platform 6 has no supported in-place
 * update for a model with existing Integration instances - the sanctioned
 * process is delete the dependent instances, delete the model, re-import
 * (PUT) the updated model, then recreate the instances. A direct
 * `updateOne` (this app's original behavior) writes the Mongo document
 * correctly but skips whatever cleanup/registration Itential's own DELETE/
 * PUT/POST routes perform - which is exactly the bug this replaces.
 *
 * Steps, in order (each recorded in the returned `steps` array so the UI
 * can show real progress/results, and so a partial failure is diagnosable
 * rather than silent):
 *   1. Re-read the current document (need its OLD versionId/model to know
 *      what to delete, and to find dependent integrations).
 *   2. Find every Integration instance built from this model (Mongo read).
 *   3. Delete each of those instances via DELETE /integrations/{name}. If
 *      ANY of these fail, stop here without touching the model at all -
 *      partial deletion with no way back is worse than not starting.
 *   4. Delete the model itself via DELETE /integration-models/{versionId}.
 *   5. Re-create ("reapply") the model via POST /integration-models with the
 *      edited spec (POST/create, not PUT/update, because step 4 already
 *      deleted the model - there is nothing left for PUT to update, which
 *      is why PUT here previously failed with an HTTP 500).
 *   6. Compute the NEW versionId/model identifier from the edited spec
 *      (its version suffix changes if info.version changed) - deriveModelIdentifier()
 *      turns a versionId into the "@itential/adapter_<versionId>" string
 *      confirmed against real service_configs documents (see
 *      _findAssociatedIntegrations above for why this is derived rather
 *      than read from a `model` field on the model document, which turned
 *      out not to exist).
 *   7. Recreate every previously-deleted instance via POST /integrations,
 *      using its backed-up properties/config but with BOTH its top-level
 *      `model` string AND its properties.type updated to the NEW versionId
 *      (properties.type is the actual field IAP matches an instance to its
 *      model by - confirmed against a real document). Every instance is
 *      attempted even if one fails, and the full backup is always included
 *      in the response so nothing is unrecoverable even on a partial
 *      failure this late in the process.
 */
OpenApiEditor.prototype.saveModel = function saveModel(modelId, spec, callback) {
  const steps = [];
  const recordStep = (name, ok, detail) => steps.push({ name, ok, detail: detail || null });

  validateSpec(spec).then((validation) => {
    if (!validation.valid) {
      return callback({ success: false, steps, errors: validation.errors });
    }

    let db;
    let originalDoc;
    let associatedIntegrations = [];

    return this._getDb()
      .then((database) => {
        db = database;
        return db.collection(COLLECTION_NAME).findOne({ _id: new ObjectId(modelId) });
      })
      .then((doc) => {
        if (!doc) throw new Error(`No integration model found for id ${modelId}`);
        originalDoc = doc;
        recordStep('Read current model', true);
        return this._findAssociatedIntegrations(doc.versionId);
      })
      .then((integrations) => {
        associatedIntegrations = integrations;
        recordStep(
          `Identify associated integration instances`,
          true,
          `${integrations.length} found${integrations.length ? `: ${integrations.map((i) => i.name).join(', ')}` : ''}`,
        );

        // Step 3: delete every dependent instance. All-or-nothing - if one
        // fails, we deliberately do not proceed to delete the model.
        return integrations.reduce(
          (chain, integration) => chain.then((allOk) => this._platformApiRequest('DELETE', `/integrations/${encodeURIComponent(integration.name)}`)
            .then(() => {
              recordStep(`Delete integration instance "${integration.name}"`, true);
              return allOk;
            })
            .catch((err) => {
              recordStep(`Delete integration instance "${integration.name}"`, false, err.message);
              return false;
            })),
          Promise.resolve(true),
        );
      })
      .then((allDeletesOk) => {
        if (!allDeletesOk) {
          throw Object.assign(
            new Error('Stopped before touching the model - not every dependent integration instance could be deleted. See steps for details; nothing else was changed.'),
            { haltedEarly: true },
          );
        }

        // Step 4: delete the model itself, identified by its OLD versionId.
        return this._platformApiRequest('DELETE', `/integration-models/${encodeURIComponent(originalDoc.versionId)}`)
          .then(() => recordStep('Delete integration model', true))
          .catch((err) => {
            recordStep('Delete integration model', false, err.message);
            throw new Error(`Failed to delete the model - stopped here. Associated integration instances were already deleted; see the backup below to recreate them manually. (${err.message})`);
          });
      })
      .then(() => this._platformApiRequest('POST', '/integration-models', { model: spec })
        .then(() => recordStep('Reapply (recreate) integration model', true))
        .catch((err) => {
          recordStep('Reapply (recreate) integration model', false, err.message);
          throw new Error(`Model was deleted but could not be recreated - use the backup below to restore it manually. (${err.message})`);
        }))
      .then(() => {
        // Step 6: the new versionId/model identifier, computed directly
        // from the edited spec - no need to re-read anything back from
        // Mongo for this (see deriveModelIdentifier's doc comment for why).
        const newVersionId = computeVersionId(spec);
        const newModel = deriveModelIdentifier(newVersionId);

        // Step 7: recreate every instance, best-effort (attempt all, even
        // if one fails) - the model is already replaced at this point, so
        // getting instances back matters more than stopping on one error.
        //
        // IMPORTANT (confirmed against a real POST /integrations request
        // body captured from the platform): the entire integration object
        // is nested one level deeper than we originally assumed, under a
        // top-level `properties` key - i.e. the request body itself is
        // `{ properties: { name, model, type, properties, isEncrypted,
        // loggerProps, virtual, description } }`. And the INNER
        // `properties.properties` field is the FULL wrapper exactly as
        // stored in service_configs - { id, type, brokers, groups,
        // properties: {...actual config...} } - not unwrapped. Only the
        // wrapper's own `type` field (matching the model's versionId) needs
        // updating to the new versionId; everything else is copied as-is.
        return associatedIntegrations.reduce(
          (chain, integration) => chain.then(() => {
            const innerWrapper = Object.assign({}, integration.properties, { type: newVersionId });
            return this._platformApiRequest('POST', '/integrations', {
              properties: {
                name: integration.name,
                type: integration.type || 'Adapter',
                model: newModel,
                properties: innerWrapper,
                virtual: integration.virtual !== undefined ? integration.virtual : true,
                isEncrypted: !!integration.isEncrypted,
                description: integration.description,
                loggerProps: integration.loggerProps,
              },
            })
              .then(() => recordStep(`Recreate integration instance "${integration.name}"`, true))
              .catch((err) => recordStep(`Recreate integration instance "${integration.name}"`, false, err.message));
          }),
          Promise.resolve(),
        ).then(() => newVersionId);
      })
      .then((newVersionId) => {
        const allOk = steps.every((s) => s.ok);
        callback({
          success: allOk,
          steps,
          versionId: newVersionId,
          errors: allOk ? [] : steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`),
          backup: {
            model: toPureSpec(originalDoc),
            meta: { versionId: originalDoc.versionId, model: deriveModelIdentifier(originalDoc.versionId) },
            integrations: associatedIntegrations,
          },
        });
      })
      .catch((err) => {
        callback({
          success: false,
          steps,
          errors: [err.message],
          haltedEarly: !!err.haltedEarly,
          backup: {
            model: toPureSpec(originalDoc || spec),
            meta: originalDoc ? { versionId: originalDoc.versionId, model: deriveModelIdentifier(originalDoc.versionId) } : null,
            integrations: associatedIntegrations,
          },
        });
      });
  });
};

/**
 * Fetch an OAuth2 access token via the client-credentials grant (RFC 6749).
 * Fetched fresh on every test call rather than cached - test calls are ad
 * hoc/interactive, not on a schedule, so the extra round trip is negligible
 * and avoids ever handing back a token that's gone stale mid-session.
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
  }).then((response) => response.data && response.data.access_token);
}

/**
 * Reads a dot-path (e.g. "data.token.access_token") out of a parsed JSON
 * object - same convention as Health Monitor's credentialPaths, so a user
 * who already knows that syntax doesn't have to learn a second one here.
 */
function getByPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce(
    (acc, key) => (acc === undefined || acc === null ? undefined : acc[key]),
    obj,
  );
}

/**
 * Two-step ("login then use token") auth: runs a separate, fully-configurable
 * request (its own method/URL/headers/body - typically a POST with a
 * username/password body) against whatever login endpoint the target API
 * exposes, pulls a token out of the JSON response via a dot-path, and hands
 * it back so the caller can format it however THAT API expects (a custom
 * header name/prefix, or a query param - see resolveTestAuth below) rather
 * than assuming it's always "Authorization: Bearer <token>".
 */
function performLoginRequest(login) {
  const headers = {};
  (login.headers || []).forEach((h) => {
    if (h && h.key) headers[h.key] = h.value;
  });

  return axios.request({
    url: login.url,
    method: (login.method || 'POST').toUpperCase(),
    headers,
    data: login.body !== undefined && login.body !== '' ? login.body : undefined,
    transformRequest: [(data) => data],
    timeout: login.timeoutMs || 15000,
    httpsAgent: login.insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
    validateStatus: () => true,
    responseType: 'text',
  }).then((response) => {
    let parsed = response.data;
    try {
      parsed = JSON.parse(response.data);
    } catch (err) {
      // Not JSON - getByPath below will simply fail to resolve, surfaced
      // as the "no value found" error rather than a parse error, since a
      // non-JSON login response is itself useful diagnostic information
      // (shown via the thrown error message).
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Login request failed: HTTP ${response.status} - ${typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`);
    }
    const token = getByPath(parsed, login.tokenPath);
    if (token === undefined || token === null || token === '') {
      throw new Error(`Login request succeeded, but no value was found at response path "${login.tokenPath || '(empty)'}"`);
    }
    return token;
  });
}

/**
 * Resolve the auth this test call should use, based on the auth panel's
 * selection in the UI - entirely independent of whatever securitySchemes/
 * Authorize button Swagger UI's own spec-driven auth may already have set.
 * Returns { headers, queryParams } to merge into the real request - "none"
 * returns both empty, leaving whatever headers the caller already
 * assembled (e.g. custom headers from the UI) untouched.
 */
function resolveTestAuth(config) {
  const mode = config.authMode || 'none';
  if (mode === 'basic' && config.authUsername) {
    const raw = `${config.authUsername}:${config.authPassword || ''}`;
    return Promise.resolve({ headers: { Authorization: `Basic ${Buffer.from(raw, 'utf8').toString('base64')}` }, queryParams: {} });
  }
  if (mode === 'bearer' && config.authToken) {
    return Promise.resolve({ headers: { Authorization: `Bearer ${config.authToken}` }, queryParams: {} });
  }
  if (mode === 'oauth2') {
    const oauth = config.oauth || {};
    if (!oauth.tokenUrl || !oauth.clientId || !oauth.clientSecret) return Promise.resolve({ headers: {}, queryParams: {} });
    return fetchOAuthToken(oauth, config.insecureTLS)
      .then((token) => ({ headers: token ? { Authorization: `Bearer ${token}` } : {}, queryParams: {} }))
      .catch((err) => {
        throw new Error(`OAuth2 token request failed: ${err.message}`);
      });
  }
  if (mode === 'login') {
    const login = config.login || {};
    if (!login.url || !login.tokenPath) return Promise.resolve({ headers: {}, queryParams: {} });
    return performLoginRequest(login).then((token) => {
      if (login.applyAs === 'query') {
        return { headers: {}, queryParams: { [login.queryParam || 'token']: token } };
      }
      const headerName = login.headerName || 'Authorization';
      const prefix = login.prefix !== undefined ? login.prefix : 'Bearer ';
      return { headers: { [headerName]: `${prefix}${token}` }, queryParams: {} };
    });
  }
  return Promise.resolve({ headers: {}, queryParams: {} });
}

/**
 * Perform the actual outbound HTTP call via axios. Runs server-side, inside
 * this app's own cog process - the browser never talks to the target
 * directly, which is what avoids CORS entirely (the browser only ever calls
 * this app's own same-origin /openapi-editor/test-request route; this
 * server-to-server call is not subject to CORS at all).
 */
function sendTestRequestAxios(config) {
  return axios.request({
    url: config.url,
    method: config.method || 'GET',
    headers: config.headers || {},
    data: config.body !== undefined ? config.body : undefined,
    // The body coming from Swagger UI is already a JSON string (or empty) -
    // pass it through verbatim rather than letting axios re-serialize it.
    transformRequest: [(data) => data],
    timeout: config.timeoutMs || 15000,
    httpsAgent: config.insecureTLS ? INSECURE_HTTPS_AGENT : undefined,
    validateStatus: () => true,
    responseType: 'text',
  }).then((response) => ({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data: response.data,
  }));
}

/**
 * Alternative to axios: shell out to curl, same diagnostic-escape-hatch
 * rationale as app-integration_health_monitor's "Use curl" option - useful
 * when something in the request pipeline (proxying, keep-alive, TLS
 * defaults, header casing) behaves differently between axios and a plain
 * curl call against the same URL.
 */
function sendTestRequestCurl(config) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '-i', '--max-time', String(Math.max(1, Math.ceil((config.timeoutMs || 15000) / 1000)))];
    if (config.insecureTLS) args.push('-k');
    args.push('-X', config.method || 'GET');

    Object.keys(config.headers || {}).forEach((key) => {
      args.push('-H', `${key}: ${config.headers[key]}`);
    });

    if (config.body !== undefined && config.body !== '') {
      args.push('-d', config.body);
    }

    args.push(config.url);

    execFile('curl', args, { timeout: (config.timeoutMs || 15000) + 2000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        reject(new Error(`curl failed: ${stderr || err.message}`));
        return;
      }
      // With -i, stdout is the raw response headers followed by a blank
      // line, then the body. Split on the first blank line.
      const raw = String(stdout || '');
      const splitAt = raw.indexOf('\r\n\r\n') !== -1 ? raw.indexOf('\r\n\r\n') : raw.indexOf('\n\n');
      const headerBlock = splitAt === -1 ? raw : raw.slice(0, splitAt);
      const body = splitAt === -1 ? '' : raw.slice(splitAt).replace(/^[\r\n]+/, '');
      const statusLine = headerBlock.split(/\r?\n/)[0] || '';
      const statusMatch = statusLine.match(/\s(\d{3})\s/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      const headers = {};
      headerBlock.split(/\r?\n/).slice(1).forEach((line) => {
        const idx = line.indexOf(':');
        if (idx > -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      });
      resolve({ status, statusText: '', headers, data: body });
    });
  });
}

/**
 * POST /openapi-editor/test-request
 * Executes one ad hoc HTTP call against a real target server, server-side -
 * this is how "testing the spec" works without hitting browser CORS
 * restrictions. The UI's Test panel builds the request (server/path/method/
 * headers/body straight from the OpenAPI document being edited) and this
 * method is the only thing that ever actually reaches out to the target;
 * the browser only ever talks to this app's own same-origin route.
 *
 * config: {
 *   url, method, headers, body,
 *   authMode: "none" | "basic" | "bearer" | "oauth2" | "login",
 *   authUsername, authPassword, authToken,
 *   oauth: { tokenUrl, clientId, clientSecret, scope, audience },
 *   login: { url, method, headers, body, tokenPath, applyAs, headerName, prefix, queryParam },
 *   useCurl, insecureTLS, timeoutMs
 * }
 * `headers` is a plain object here - the UI's repeatable key/value header
 * list is flattened to an object before this is called (see api.js).
 */
OpenApiEditor.prototype.testRequest = function testRequest(config, callback) {
  const started = Date.now();
  resolveTestAuth(config)
    .then(({ headers: authHeaders, queryParams }) => {
      const headers = Object.assign({}, config.headers || {}, authHeaders);
      let { url } = config;
      if (queryParams && Object.keys(queryParams).length) {
        const usp = new URLSearchParams(queryParams);
        url += `${url.includes('?') ? '&' : '?'}${usp.toString()}`;
      }
      const exec = config.useCurl ? sendTestRequestCurl : sendTestRequestAxios;
      return exec(Object.assign({}, config, { url, headers }));
    })
    .then((response) => {
      callback({
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        data: response.data,
        timeMs: Date.now() - started,
      });
    })
    .catch((err) => callback(null, err));
};

module.exports = new OpenApiEditor();
