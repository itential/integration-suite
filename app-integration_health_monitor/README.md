# app-integration_health_monitor

A custom Itential Platform application that periodically calls a
user-configured task (a REST route already exposed by an adapter or
integration instance) and tracks whether it's responding correctly. If a
configured call returns a valid (non-error) response, that target is
considered "healthy" - capable of talking to its integrated system. Anything
else (timeout, connection error, non-2xx status, or an embedded error
payload) marks it "unhealthy".

Everything - which call to use per target, and how often to run it - is
configured from this app's own UI. No pronghorn.json edits or platform
restarts are needed to add or change a check.

## Self-signed certificates

Set `platformProps.insecureTLS: true` to skip TLS certificate verification
on every call this app makes to Platform's own `baseUrl` on behalf of an
Adapter or App target - the `/login` call (`authMode` username/password),
the OAuth2 client-credentials token fetch (`authMode: "oauth2"`), and the
Restart action's stop/start calls. This was previously only possible for
Integration targets, which have always honored a per-check `insecureTLS`
flag for the actual health-check request itself; Adapter/App targets had no
equivalent for the platform-level auth/restart calls, which is fixed by this
flag. Per-check `insecureTLS` (set on an individual check) still controls
the actual health-check HTTP request for ANY target type, independent of
this platform-wide flag - use whichever applies to the certificate you're
actually working around.

## Encrypting secrets - two supported paths

This app never requires plaintext credentials to sit unprotected once one of
the two paths below is in place. Both are supported at the same time (for
different fields, or as a fallback for environments without Vault) - just
don't use both on the SAME field, since Platform will not double-encrypt and
an admin who pastes an already-`$ENC...` value into a field Vault is also
managing risks re-encrypting ciphertext-as-plaintext.

### Path 1 - Automatic, Vault-backed (recommended, needs HashiCorp Vault)

`propertiesSchema.json` and `propertiesDecorators.json` ship at the root of
this app, alongside `pronghorn.json`. `propertiesDecorators.json` marks these
fields for automatic encryption:

- `/mongoProps/password`
- `/platformProps/password`
- `/platformProps/authToken`
- `/platformProps/oauth/clientSecret`

If your Platform instance has Vault configured, an admin just types the
plaintext value into these fields in Admin Essentials (or via the config API)
and saves as normal - Platform stores the value in Vault, never in Mongo, and
hands this app back the decrypted plaintext at runtime. Nothing in this app's
own code has to run for this path to work; it's entirely Platform-side. If
Vault is NOT configured on your instance, Platform ignores the decorators and
just saves plaintext as before - fall back to Path 2 below.

### Path 2 - Manual, $ENC/PropertyEncryption (works without Vault)

Every field the Vault decorators cover, PLUS this app's own `health_checks`
documents (`authPassword`, `authToken`, `oauth.clientSecret` on a check), can
also be manually encrypted with this app's `encryptValue` admin utility
(`POST /health-monitor/encrypt-value`, `{"value": "the-plaintext-secret"}`).
It returns an `$ENC...`-prefixed string using IAP's own `PropertyEncryption`
module (the same mechanism IAP's core has used since before Vault-backed
encryption existed) - paste that string into the property instead of the
plaintext, and this app decrypts it transparently on every read.

`src.js`'s `_decryptIfEnc()` is called wherever a value that might be
`$ENC...`-prefixed gets used: `_getDb()` (mongoProps.password),
`_getPlatformConfig()` (platformProps.password/authToken/oauth.clientSecret),
and `_resolveTargetCredentials()` (a check's own `credentialPaths`, reading a
target integration's own `service_configs` document). Plaintext values, and
values Platform already decrypted itself via Path 1, pass through unchanged -
`_decryptIfEnc` only acts on strings that actually start with `$ENC`.

`createCheck`/`updateCheck` go the other direction: `_encryptCheckSecrets()`
runs a check's `authPassword`/`authToken`/`oauth.clientSecret` through
`_encryptForStorage()` before every write to `health_checks`, so this app's
own bespoke collection (which Path 1's decorators can't reach - those only
apply to Service Instance properties, not to Mongo documents this app writes
itself) never has plaintext secrets land on disk either.

**Not yet confirmed live**: `_encryptForStorage`'s encrypt method name
(`newEncryption`/`encrypt`/`newEncrypt`, tried in that order) - the decrypt
side (`enc.newDecryption()`) is confirmed working against a real Platform 6
instance; the mirrored encrypt name hasn't been. If none of the three names
match your build, `_encryptForStorage` throws an error naming all three it
tried. Run this on the server to get the real name and update the
`candidateMethods` list in `src.js`:

```
node -e "const { PropertyEncryption } = require('/opt/itential/platform/server/node_modules/@itential/itential-utils'); console.log(Object.getOwnPropertyNames(PropertyEncryption.prototype));"
```

## Structure

```
app-integration_health_monitor/
├── package.json          # cog's npm package manifest (mongodb, axios)
├── pronghorn.json        # app manifest: methods/routes, view, roles
├── src.js                # the cog - Mongo persistence + in-process scheduler + HTTP checks
├── sampleProperties.json # example service instance configuration
├── img/icon.png          # app icon shown in the IAP nav (Itential mark)
├── views/                # live template copy (see "known deployment quirk" note below)
└── ui/
    ├── package.json
    ├── webpack.config.js
    ├── src/
    │   ├── index.html / index.jsx / App.jsx / styles.css / api.js / mockData.js
    │   └── components/
    │       ├── StatusBadge.jsx   # Healthy / Unhealthy / Not yet checked pill
    │       ├── CheckTable.jsx    # dashboard table of all configured checks
    │       └── CheckForm.jsx     # add/edit modal
    └── dist/              # pre-built production bundle (already built)
```

## How a "check" works

Each configured check is one document in a `health_checks` MongoDB
collection:

```json
{
  "_id": "...",
  "name": "Slack Adapter - Ping",
  "targetType": "adapter",
  "serviceName": "slack-adapter",
  "method": "GET",
  "path": "/offlinePing",
  "intervalSeconds": 300,
  "timeoutMs": 5000,
  "enabled": true,
  "status": {
    "state": "healthy",
    "lastCheckedAt": "2026-07-24T22:10:00.000Z",
    "lastResponseTimeMs": 84,
    "lastStatusCode": 200,
    "lastError": null
  }
}
```

At the configured interval, the cog's in-process scheduler sends
`method` to `<platform base URL>/<serviceName><path>` - i.e., the exact same
REST route IAP already exposes for that adapter/integration/app's own
task, the same way a workflow task or another app would call it. The
response is classified:

- HTTP 2xx **and** no top-level `error` key in a JSON body → **healthy**
- Anything else (non-2xx, timeout, connection refused, or a 200 with an
  embedded `error` field) → **unhealthy**, with the reason captured in
  `status.lastError`

## What it does (routes)

| Method | Route | Purpose |
|---|---|---|
| `listTargets` | `GET /health-monitor/targets` | Best-effort list of installed adapter/integration/app instances, for the Add Check form's dropdown. See caveat below. |
| `listChecks` | `GET /health-monitor/checks` | All configured checks + their latest status, for the dashboard. |
| `getCheck` | `GET /health-monitor/checks/:checkId` | One check's full config + status. |
| `createCheck` | `POST /health-monitor/checks` | Add a new check. Body: `{ config }`. |
| `updateCheck` | `PUT /health-monitor/checks/:checkId` | Edit a check's config (name, target, interval, enabled, etc). |
| `deleteCheck` | `DELETE /health-monitor/checks/:checkId` | Remove a check. |
| `runCheckNow` | `POST /health-monitor/checks/:checkId/run` | Run one check immediately, out of its schedule - used by the UI's "Run Now" button. |

## Target auto-discovery (and its limits)

The "Add Check" form now offers a dropdown of installed adapter/integration/
app instances instead of requiring you to type the exact route name. This is
populated by `listTargets`, which reads directly from a `service_configs`
Mongo collection - the same collection referenced in internal Itential docs
as the place each service's resolved config is matched by a `name` field.

**This has not been confirmed against a live instance's actual document
shape** - it was inferred from documentation, not verified the way the
Mongo access pattern for `app-openapi_editor` was. Before trusting the
dropdown:

```bash
mongosh <your-db-name> --eval 'db.service_configs.findOne()'
```

and confirm it actually has a `name` field matching real, working route
segments. If the dropdown comes back empty, wrong, or missing entries,
select **"Other (type manually)…"** in the form and type the instance name
directly - this manual path always works and is what the app used
exclusively before this update.

## Picking an Integration's operation from its own OpenAPI model

When Target type is Integration and you've selected/typed a target
instance, the Add/Edit Check form now offers a searchable picker of that
integration's own documented operations - pulled directly from the same
OpenAPI model `app-openapi_editor` edits, instead of requiring the method
and call path to be typed in from memory. Selecting one fills in Method
and Call path above; you can still edit them afterward, or ignore the
picker entirely and type them manually as before.

This works by looking up the instance's `service_configs.properties.type`
field (the same field confirmed as the real model-to-instance link during
`app-openapi_editor`'s work - see that app's README) to get the model's
`versionId`, then reading that model's `paths` straight out of the
`integration_models` collection (read-only). Nothing is written back to
that collection from here.

**Default health-check call.** If a model has one operation marked as its
default health-check call - done from the OpenAPI Editor's Operations tab,
clicking the star next to any operation - that operation automatically
fills Method/Call path the first time you select that target on a **new**
check (never overwriting an existing check's already-configured values).
You can still pick a different operation from the list, or type your own,
at any point.

This is deliberately not attempted for Adapter or App targets in
this version - those don't have a document in `integration_models` the way
Integrations do, so the picker simply doesn't appear for those (no error,
just nothing to show); type Method/Call path manually for those, same as
before.

## POST/PUT calls with a payload

Most real adapter/integration calls are POST with a request body, not a
bare GET - the Add Check form now shows a **Request payload (JSON body)**
textarea whenever Method is set to POST or PUT. It's validated as JSON on
submit (a clear inline error if it isn't); the parsed object is stored on
the check config as `body` and sent as-is via axios (`data: config.body`),
which sets `Content-Type: application/json` automatically. Leave it blank
for calls that don't need one, and leave Method as GET wherever a
side-effect-free read-only call already exists - see the note under
"Backend (cog) notes" about not pointing this at anything that mutates data
downstream.

## Diagnosing a 401 (authentication failing)

A 401 means the request reached the target route but was rejected as
unauthenticated/unauthorized - a different failure mode than a 404
(wrong route entirely). Two things changed to help with this:

- **`platformProps.authMode`** now controls how the token is sent:
  `"query"` (default, `?token=`), `"header"` (`Authorization: Bearer`),
  `"oauth2"` (also `Authorization: Bearer`, but the token itself comes from
  an OAuth2 client-credentials exchange - see below), or `"none"`. If a
  route expects the token in a header rather than a query string (or vice
  versa), a 401 is exactly what you'd see - try switching `authMode` first.
- **OAuth2 (`authMode: "oauth2"`).** Set `platformProps.oauth`:
  ```json
  "oauth": {
    "tokenUrl": "https://your-auth-provider.example.com/oauth/token",
    "clientId": "...",
    "clientSecret": "...",
    "scope": "",
    "audience": ""
  }
  ```
  On first use (and whenever the cached token is within 15 seconds of
  expiring) the cog POSTs a standard RFC 6749 client-credentials grant to
  `tokenUrl` (`grant_type=client_credentials` plus `client_id`/`client_secret`
  and, if set, `scope`/`audience`, form-urlencoded) and expects
  `access_token` + `expires_in` back. The token is cached in memory and
  reused across checks until it's about to expire, at which point it's
  silently refreshed - no restart or manual action needed. If a check still
  comes back 401 with oauth2 configured, it's automatically retried once
  with a freshly-fetched token, same as the username/password flow below.
  Double-check `tokenUrl` and the client id/secret first if 401s persist -
  those are the most common misconfiguration.
- **Token refresh.** A single static `authToken` will eventually go stale
  once IAP's own session/token TTL expires, which shows up as a check that
  used to pass suddenly returning 401. If you instead configure
  `platformProps.username`/`password`, the cog will call `<baseUrl>/login`
  on demand, cache the resulting token, and automatically retry once with a
  freshly-obtained token if a check comes back 401 - so a single stale
  token no longer causes a persistent false "unhealthy" reading.
  **Caveat:** the exact field IAP's `/login` response returns the token
  under (`token` / `access_token` / `jwt_token`) has not been confirmed
  against a live instance - `_getAuthToken()` in `src.js` checks all three,
  but if login is silently failing, check that first.
- If a 401 persists after that automatic retry, `status.lastError` will now
  say so explicitly ("Authentication failed (401) - check
  platformProps.authMode/authToken/username+password") rather than just a
  generic status message, to point straight at the fix.

## Decrypting credentials directly from IAP (avoiding plaintext overrides)

Rather than typing a plaintext username/password/client-secret override on a
check, you can check "Decrypt credentials from IAP instead of entering them
here" (shown once an Auth type other than None is selected) and instead
supply a dot-path into the target's own `service_configs` document (e.g.
`properties.properties.authentication.basicAuth.password`). If that path
resolves to a `$ENC...`-prefixed value, it's decrypted on the fly, on every
check run, using IAP's own real decryption - nothing decrypted is ever
written back to this app's own `health_checks` collection.

This works by requiring IAP's own `@itential/itential-utils` package
directly (confirmed present at
`/opt/itential/platform/server/node_modules/@itential/itential-utils` on a
live Platform 6 instance) and constructing a `PropertyEncryption` instance
using `pronghornProps.encryptionKey`/`pronghornProps.vaultProps` - a
process-wide implicit global populated from the `INIT_PROPS` environment
variable by `ServiceBootstrap.js` for every service type (adapters,
integrations, and custom apps alike), the same mechanism that gives this
app's own `service_config` global. `PropertyEncryption.newDecryption(value)`
is a plain, synchronous, single-value decrypt method - no
`propertiesDecorators.json`/schema needed, unlike the whole-document
`decryptProperties()` IAP uses internally.

**Caveats:**
- This depends on an undocumented internal path
  (`/opt/itential/platform/server/node_modules/@itential/itential-utils`)
  that could change between IAP versions or differ across deployments (e.g.
  containerized installs with a different base directory). If the path is
  wrong on your instance, decryption fails with a clear error rather than
  silently falling back to plaintext.
- Only works for legacy `$ENC...` values. Values already migrated to
  `$SECRET_...` (Vault) are a separate mechanism this app does not yet
  integrate with - see "Vault as a future option" below.
- If a dot-path is left blank, that one credential falls back to its
  literal-value field instead - fields can be mixed (e.g. a non-encrypted
  `client_id` read literally, alongside a decrypted `client_secret`).

### Vault as a future option

Itential's actively-recommended replacement for `$ENC` is HashiCorp Vault
(`$SECRET_<path> $KEY_<key>` syntax). Since Vault is a real external secrets
store rather than an internal IAP implementation detail, a cleaner
long-term integration would be for this app to talk to Vault directly using
its own scoped token/policy - not something built yet, since this
environment is still primarily on `$ENC`. Worth reconsidering once/if
credentials here migrate to Vault.

## Calling integrations vs. adapters (important architectural difference)

Adapters are reached through IAP's own generic proxy route
(`<platformProps.baseUrl>/<serviceName><path>`). **Integrations are not** -
that generic route (documented historically as "Integration API Routes")
was deprecated in IAP 2023.1.2 and removed in 2023.2. Integrations are
called at their own directly-configured endpoint instead.

For a check with `targetType: "integration"`, the cog now looks up the
integration's own service config document in the `service_configs`
collection (matched by `name === serviceName`) and reads its
`properties.server: { protocol, host, port, base_path }` object - this is
the same server info shown when you inspect that integration's instance
properties in Admin Essentials. It builds the request URL directly from
that (`<protocol>://<host>:<port><base_path><path>`) rather than routing
through `platformProps.baseUrl`. If that lookup fails, `status.lastError`
will say so explicitly rather than silently falling back to the adapter
behavior.

### "Use curl" option

Each check can optionally be run via the system's own `curl` binary instead
of axios (checkbox in the Add/Edit form, stored as `useCurl`). This exists
as a diagnostic escape hatch: if a check fails through the normal HTTP
client but a manual `curl` against the same URL succeeds (or vice versa),
that isolates whether the problem is in the request itself (bad URL, bad
auth, target down) versus something specific to how Node/axios is making
the call. Requires `curl` to be installed and on the `PATH` of the host
running this service.

## Diagnosing a 404 against a target you believe is correct

A 404 almost always means `serviceName` doesn't match the actual route
segment IAP uses for that specific instance - which is the instance name
you gave it in Admin Essentials, not necessarily the underlying adapter
package's name. Confirm the real route directly before assuming the app is
broken:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/<exact-instance-name>/<known-good-path>?token=<your-token>"
```

If that also 404s with the exact same path you know works elsewhere (e.g.
from a workflow task), double check for a typo'd instance name first - it's
the most common cause. A previous version of this app also had a URL-
building bug where a trailing slash on `platformProps.baseUrl` or a stray
slash on `serviceName` produced a double slash in the request path (e.g.
`.../meraki-adapter//organizations`), which some routers reject as a 404
even though the real route exists - this is now fixed defensively in
`buildCheckUrl()` in `src.js`, but if you're running an older copy of this
app, that's worth checking too.

## Backend (cog) notes

- **Scheduler is a single in-process `setInterval`**, ticking every 15
  seconds, checking which enabled checks are due based on their own
  `intervalSeconds` and `status.lastCheckedAt`. This is deliberately simple
  (no external cron/job-queue dependency) per the "simple custom app for
  now" scope - it only works because this app's singleton cog instance
  stays resident for the life of the service process. If check volume grows
  large or sub-15-second precision is ever needed, revisit this in favor of
  IAP's own scheduled-trigger/workflow mechanism instead.
- **How it reaches another adapter/integration**: this app calls back into
  IAP's own web server over plain HTTP (`axios`), the same way a browser or
  a workflow task would hit that route - it does **not** attempt to
  `require()` another service's code directly. This matters architecturally:
  on this IAP build, each adapter/integration/app runs as its own separate
  Node.js process (dispatched via BullMQ), so in-process calls between cogs
  aren't possible - HTTP-back-to-the-platform is the only viable mechanism
  and is what every other cross-service call in IAP does anyway.
- **Auth for that HTTP call**: configured via this app's own
  `platformProps.authToken` (see `sampleProperties.json`), appended as a
  `?token=` query parameter - matching the pattern used elsewhere in IAP
  (e.g. the `/login` → token flow shown in Itential's own tutorials). You
  will need a valid, sufficiently-privileged token/session for whatever
  adapters/integrations you configure checks against. This has **not** been
  tested against a live instance - confirm the exact auth mechanism your
  IAP build expects (query param vs. `Authorization: Bearer` header vs.
  session cookie) before relying on it; `_executeCheck` in `src.js` is the
  single place to adjust if it turns out to be different.
- Mongo connection properties are resolved the same way established for
  `app-openapi_editor` (`service_config.properties.mongoProps`) - see that
  app's README and the companion developer guide for why.
- **Choose a lightweight, side-effect-free route for each check.** Since
  this literally invokes the configured route on a schedule, don't point it
  at anything that creates/modifies data downstream - use a read-only
  "ping"/"get" style task if the adapter/integration has one.

## Frontend notes

- Dashboard-style UI (no per-item detail page needed for this scope): a
  summary bar (total / healthy / unhealthy / not-yet-checked counts) above
  a table of every configured check, each row showing target, the exact
  call configured, interval, live status, last-checked time, and the last
  error if any.
- **Polls `listChecks` every 10 seconds** so status updates show up without
  a manual refresh, reflecting whatever the backend scheduler has run in
  the meantime.
- Add/Edit is a modal form (`CheckForm.jsx`) with interval presets (1m, 5m,
  15m, 30m, 1h, 6h) rather than a raw seconds field, since that's how this
  will actually be configured day-to-day; the underlying stored value is
  always `intervalSeconds`.
- Same Itential navy/teal visual language as `app-openapi_editor`, adapted
  to a dashboard/table layout instead of a split editor.
- Falls back to bundled demo data (`mockData.js`) with a "Demo data" pill
  if no live backend is reachable, so the UI is explorable standalone; in
  that mode, Save/Delete/Run Now show an info message rather than silently
  no-op'ing.

## Known deployment quirk: view template path

Same issue documented for `app-openapi_editor`: IAP resolves a view's
`template` relative to the app's `views/` directory, not wherever
`uiDirectories` points. This package's `pronghorn.json` already sets
`"template": "index.html"`, with a synced copy of the built `index.html` +
`bundle.js` kept in `views/`. If you rebuild the UI, copy the new
`ui/dist/*` files into `views/` again, or IAP will serve a stale shell.

## Build & install

```bash
# 1. Build the UI (already built once into ui/dist/ in this delivery)
cd ui
npm install
npm run build
cp dist/* ../views/     # keep views/ in sync - see quirk above

# 2. Place the whole app-integration_health_monitor/ folder in IAP's services directory
cd /opt/itential/platform/services
git clone <your-repo> app-integration_health_monitor   # or copy this folder directly
cd app-integration_health_monitor
npm install       # installs the cog's dependencies (mongodb, axios)

# 3. Match ownership to your other installed apps, e.g.:
chown -R itential:itential /opt/itential/platform/services/app-integration_health_monitor

# 4. Restart IAP
systemctl restart pronghorn

# 5. In Admin Essentials:
#    - Configure the app's Service Instance properties: mongoProps (Mongo
#      connection) and platformProps (baseUrl + authToken) - see
#      sampleProperties.json and "Backend (cog) notes" above
#    - Authorize a group (e.g. admin) for the app's roles
```

The app will then appear in IAP's navigation as "Health Monitor". Add your
first check via **+ Add Check**, pointing it at a lightweight existing
route on the adapter/integration you want monitored.

## Verification performed

- `npm run build` (Webpack, production mode) completes with no errors from
  a clean `npm install`.
- `src.js` was syntax-checked with `node -c`.
- **Not yet tested against a live IAP instance.** In particular, verify
  before relying on this in production:
  - The exact auth mechanism `_executeCheck` needs to successfully call
    another adapter/integration's route on your specific IAP build (query
    token vs. header vs. session).
  - That `service_config.properties.mongoProps` resolves the same way it
    did for `app-openapi_editor` on your instance (it's an unverified,
    reverse-engineered mechanism, not officially documented by Itential -
    see the companion developer guide, Section 4.3).
  - The MongoDB driver's `findOneAndUpdate` return shape in `updateCheck`
    (handled defensively for both v4-style `{ value }` and newer
    direct-document return shapes, but not exercised against your actual
    installed `mongodb` package version).

## Status as of this session / where to pick back up

This app is mid-troubleshooting against a live instance, not yet confirmed
fully working end-to-end. Known open threads for next time:

1. **404s against known-good adapters/integrations** - the URL-building
   double-slash bug is fixed, but the more likely remaining cause is
   `serviceName` not matching the real instance name IAP uses in its route.
   Confirm with the `curl` test in "Diagnosing a 404" above *before*
   assuming there's still a bug in this app.
2. **401s** - `authMode` and username/password-based token refresh were
   added this session to address this, but neither has been confirmed
   against the live instance yet. Next step: pick an `authMode` matching
   how that specific route expects its token, retest, and report back what
   `status.lastError` says.
3. **POST/PUT payload support** was added this session (the Add Check
   form's JSON body textarea) but has not yet been exercised against a real
   POST-based adapter/integration call - worth confirming the body actually
   arrives as expected on the receiving end.
4. **Target auto-discovery** (`listTargets`, reading `service_configs`) is
   still unverified against a real document shape - run the `mongosh`
   check under "Target auto-discovery" before trusting the dropdown for
   anything beyond convenience.

Recommended order for the next session: get one single check fully green
end-to-end (pick the simplest possible GET first, confirm 200, *then* move
to a real POST-with-payload check), before configuring the rest.
