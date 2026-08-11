# Integration Health Monitor for Itential Platform 6

A custom Itential Platform 6 application that periodically calls a
user-configured operation against an adapter, app, or **Integration
Instance**, and tracks whether it's responding correctly — a lightweight,
purpose-built health dashboard for the things you've built on top of
Itential's **Integration Models**.

> **Why this exists.** An Integration Instance is only as useful as your
> confidence that it's actually working. Rather than finding out during a
> workflow run, this app gives you a standing, scheduled, visible answer to
> "is this target healthy right now" — sortable, filterable, and able to
> restart an unresponsive adapter/app directly from the dashboard.

`[SCREENSHOT: Dashboard view showing a sortable/filterable table of checks
with health state badges (healthy/unhealthy/unknown) per row]`

---

## Table of contents

1. [What it does](#what-it-does)
2. [Installation](#installation)
3. [Configuration reference](#configuration-reference)
4. [Using the app](#using-the-app)
5. [Security](#security)
6. [Troubleshooting](#troubleshooting)
7. [Uninstalling](#uninstalling)

---

## What it does

- **Scheduled health checks** against adapters, custom apps, or Integration
  Instances — each check has its own interval, independent of the others.
- **Sortable, filterable dashboard** across every column (target, type,
  state, last checked, last status code, response time).
- **Auto-discovery of targets** — pulls candidate adapters/apps/integrations
  from Platform's own configuration so you're picking from a real list, not
  typing target names by hand.
- **Operation picker for Integration targets** — reads the target's own
  OpenAPI model (via the companion OpenAPI Editor's model data) and offers
  its operations directly, including whichever one was marked as the
  "default health check call" in that model's Operations tab.
- **Restart action** for unresponsive adapters/apps, directly from the
  dashboard (not offered for Integrations — restarting a process isn't a
  concept that applies to them).
- **Run Now** — trigger any check on demand, outside its schedule.
- **Flexible per-check auth** — none, Basic, static Bearer token, or its own
  independent OAuth2 client-credentials grant, entirely separate from the
  auth this app itself uses to reach Platform.
- **Encrypted storage for every secret this app holds** — both the
  credentials it uses to reach Platform, and the target-auth secrets stored
  on a check itself. See [Security](#security).

`[SCREENSHOT: Add/Edit Check form showing target picker, operation picker,
interval field, and auth mode selector]`

## Installation

### Option A — RPM (recommended for production)

A self-contained ("fat") RPM ships with this release: the app's production
`npm` dependencies are already installed and bundled inside it, and its UI
is already built. Installing it requires **no network access and no `npm
install`/build step** on the target host.

```bash
rpm -ivh itential-health-monitor-1.0.0-1.noarch.rpm
systemctl restart pronghorn
```

If you only have the source tarball and spec file (not a prebuilt `.rpm`),
build it yourself on any host with `rpmbuild`, `node` (>=18), and `npm`:

```bash
./build_rpm.sh /path/to/app-openapi_editor /path/to/app-integration_health_monitor
# RPMs land in ./dist/
```

### Option B — Manual install from source

1. Copy the app folder into Platform's services directory:
   ```bash
   cd /opt/itential/platform/services
   # unzip/untar/git clone app-integration_health_monitor here
   cd app-integration_health_monitor
   npm install --omit=dev
   ```
2. Restart the platform:
   ```bash
   systemctl restart pronghorn
   ```
3. In **Admin Essentials → Applications**, confirm
   `app-integration_health_monitor` is listed and create a **Service
   Instance** for it.
4. Configure `mongoProps` and `platformProps` (see
   [Configuration reference](#configuration-reference) below) — unlike the
   Editor app, this app **does** need both, since it runs unattended on a
   schedule with no logged-in user to borrow a session from.
5. **Authorize** a group (e.g. `admin`) for the app's roles
   (`admin`, `health_monitor_user`) so it shows up in the left-hand
   navigation as **Health Monitor**.

`[SCREENSHOT: Admin Essentials Applications page with
app-integration_health_monitor listed and its Service Instance
configuration panel open]`

## Configuration reference

Unlike the Editor app, this app runs unattended on a schedule — there's no
logged-in user to borrow a session token from — so `mongoProps` (where it
stores its own check configuration and results) and `platformProps` (how it
authenticates when calling an adapter/app's status endpoint) are both
**required**.

| Property | Type | Required | Notes |
|---|---|---|---|
| `mongoProps.host` / `.port` / `.database` | string/number | Yes | This app's own `health_checks` collection lives here |
| `mongoProps.username` / `.password` | string | If your Mongo requires auth | **Encrypt this** — see [Security](#security) |
| `platformProps.baseUrl` | string | Yes | Where Platform's own web server is reachable, e.g. `http://127.0.0.1:3000` |
| `platformProps.authMode` | `"none"` \| `"query"` \| `"header"` \| `"oauth2"` | Yes | How to authenticate calls to an **adapter/app** target's status endpoint. Has no effect on Integration targets, which use their own independent auth below |
| `platformProps.username` / `.password` | string | If `authMode` uses username/password login | **Encrypt `.password`** |
| `platformProps.authToken` | string | If using a static token instead of login | **Encrypt this** |
| `platformProps.oauth.tokenUrl` / `.clientId` / `.clientSecret` / `.scope` / `.audience` | string | If `authMode` = `"oauth2"` | **Encrypt `.clientSecret`** |

Per-check settings (target, operation, interval, auth mode, and — for
Integration targets — their own independent `authUsername`/`authPassword`/
`authToken`/`oauth.{...}`/`credentialPaths.{...}`) are configured entirely
through the app's own UI, not through Service Instance properties — see
[Using the app](#using-the-app) below.

`[SCREENSHOT: Admin Essentials Service Instance properties form for
app-integration_health_monitor, showing mongoProps/platformProps fields]`

## Using the app

### Adding a check

Click **Add Check**. Pick a target from the auto-discovered list (adapters,
apps, and Integration Instances are all offered, labeled by type). For an
Integration target, the operation picker reads that model's own OpenAPI
document and highlights whichever operation was marked as the default
health check call in the OpenAPI Editor app's Operations tab — pick that one
unless you have a specific reason not to. Set an interval (checks run
independently of each other; a shared internal scheduler just wakes up every
15 seconds to see which ones are due).

`[SCREENSHOT: Add Check form with an Integration target selected and its
operation picker open, default-marked operation highlighted]`

### Auth mode, per check

- **None** — for targets that don't require auth to reach the checked
  endpoint.
- **Basic** — static username/password, or a `credentialPaths.username`/
  `.password` dot-path into that target's own `service_configs` document
  (so nothing has to be typed twice, and this app transparently decrypts an
  `$ENC...`-encrypted value found at that path).
- **Bearer** — a static override token.
- **OAuth2** — this check's own `tokenUrl`/`clientId`/`clientSecret`,
  entirely independent of `platformProps.oauth` (which is only used for
  adapter/app targets). Cached per-check until near expiry, with one
  automatic retry on a 401 before marking the check unhealthy — this covers
  "the token simply expired," not a real auth failure.

### Dashboard

Every column is sortable and filterable — target name, type, current state,
last checked time, last status code, last response time. Click a row for
its last response body and error detail, useful for telling "unreachable"
apart from "reachable but rejecting the request" at a glance.

`[SCREENSHOT: Dashboard row expanded showing last error detail and last
response body]`

### Run Now / Restart

**Run Now** executes a check immediately, outside its schedule — useful
right after creating or editing one, so you don't wait for the interval to
elapse to see if it's configured correctly. **Restart** (adapters/apps only)
calls Platform's own stop-then-start sequence for that target directly from
the row.

`[SCREENSHOT: Dashboard row with the Run Now and Restart action buttons
visible]`

### Custom check interval

Set per check, in seconds — there is no platform-wide interval; each check
is independent.

## Security

Treat this section as a checklist, not background reading. This app is the
more security-sensitive of the two published here, because unlike the
Editor app, it **must** hold a standing credential — it runs unattended on a
schedule, with no logged-in user to act on behalf of.

- **Encrypt everything this app is configured with**, both `mongoProps`/
  `platformProps` (Service Instance properties) and any per-check target
  auth stored in `health_checks` (`authPassword`, `authToken`,
  `oauth.clientSecret`). Two supported paths for `mongoProps`/`platformProps`
  — mix them per field, never apply both to the same field:
  - **Preferred, if HashiCorp Vault is configured on your Platform
    instance**: this app ships `propertiesSchema.json` and
    `propertiesDecorators.json` decorating `mongoProps.password`,
    `platformProps.password`, `platformProps.authToken`, and
    `platformProps.oauth.clientSecret` for automatic encryption. Type the
    plaintext value into Admin Essentials and save — Platform encrypts it
    in Vault, never in Mongo, and hands this app the decrypted plaintext at
    runtime. No app-side action needed.
  - **Fallback, no Vault required**: use this app's own `encryptValue`
    admin utility —
    ```bash
    curl -X POST http://<platform>/health-monitor/encrypt-value \
      -H "Content-Type: application/json" \
      -d '{"value": "the-plaintext-secret"}'
    ```
    — and paste the returned `$ENC...`-prefixed string into the property
    instead of the plaintext. This app decrypts it transparently on every
    read (`_decryptIfEnc`), wherever that field is used.
- **`health_checks`' own target-auth fields are encrypted automatically —
  no admin action needed.** `authPassword`, `authToken`, and
  `oauth.clientSecret` on a check are run through `_encryptForStorage`
  before every write, and this app **fails the save closed** (refuses to
  persist) rather than silently storing plaintext if encryption is
  unavailable for any reason.
- **Restart is a real, disruptive action.** It stops and starts the target
  process. Scope who can reach this app's UI (the `health_monitor_user`
  role) with that in mind — anyone who can restart an adapter/app can cause
  a real, visible outage for anyone using it.
- **This app's standing Platform credential is broad by nature.** Because
  it authenticates independently of any individual user, whatever role/
  permissions that credential has apply every time this app runs, on a
  schedule, unattended. Give it the narrowest role that still lets it reach
  the adapter/app status endpoints it needs — not a blanket admin account,
  if your Platform version supports scoping it more tightly.
- **This RPM ships with an npm-audit-clean dependency tree** at time of
  packaging (`npm audit` reports 0 vulnerabilities against the bundled
  production `node_modules`, both the cog and the built UI's runtime
  dependencies). The one flagged item in the *development* toolchain
  (`webpack-dev-server`, used only by `npm start` for local UI development)
  is a devDependency that is never bundled into the built UI or this RPM —
  it has no runtime exposure in a deployed instance. Re-run `npm audit` for
  yourself before every release; dependency trees drift.

## Troubleshooting

**A check against an App/Adapter target fails with 401 "malformed... does
not correspond with an active session"** — this is Platform's own generic
"no valid token presented" response; it's equally consistent with a bad
token AND with no token being sent at all. Check first whether
`_getAuthToken`'s OAuth2/login flow is silently failing — its `.catch(() =>
null)` swallows the real error by design (falls through to "no token"
rather than crashing), so add temporary logging there if you need to see the
underlying failure. Also confirm the service was **restarted** after any
property change — the resolved token is cached in memory for the life of
the process.

**Same 401, but only after switching a property to (or from) an
`$ENC...`-encrypted value** — confirm the field in question is one this app
actually decrypts. `platformProps.password`/`.authToken`/`.oauth.clientSecret`
and `mongoProps.password` are all covered by `_decryptIfEnc()`; if you've
modified `src.js`, verify that call is still present in `_getPlatformConfig`/
`_getDb`. Pasting ciphertext into a field that's never decrypted will send
the literal `$ENC...` string as the actual credential — this exact bug was
found and fixed during this app's development.

**`encryptValue` (or an automatic encrypt) throws "none of
PropertyEncryption's expected methods exist"** — the encrypt-side method
name on your Platform build's `PropertyEncryption` class hasn't been
confirmed to match this app's best guess (`newEncryption`, `encrypt`, or
`newEncrypt`, tried in that order). Run this on the server to get the real
name, then update the `candidateMethods` list in `_encryptForStorage`
(`src.js`):
```bash
node -e "const { PropertyEncryption } = require('/opt/itential/platform/server/node_modules/@itential/itential-utils'); console.log(Object.getOwnPropertyNames(PropertyEncryption.prototype));"
```

**A check flaps between healthy/unhealthy every cycle on an OAuth2
target** — likely the token is expiring faster than expected, or the target
issues a shorter TTL than reported; this app refreshes 15 seconds before the
reported expiry and retries once automatically on a 401, but a target with
an unusually short-lived token can still race that. Reduce the check
interval, or confirm the target's actual token TTL.

**Integration operation picker returns nothing** — expected for adapter/app
targets (not a bug; picking an operation isn't a concept that applies to
them). For Integration targets, confirm the target's model actually has
operations defined and that Platform's `/integration-models` API is
reachable from wherever this app's UI runs.

**A dashboard row never leaves "unknown"** — the check hasn't run yet.
Either wait for its interval to elapse, or click **Run Now**.

## Uninstalling

```bash
rpm -e itential-health-monitor
systemctl restart pronghorn
```

Uninstalling this app removes only its own service directory. Its
configured checks and their history live in this app's own `health_checks`
Mongo collection and are **not** removed automatically — back that
collection up first if you might reinstall later, or drop it by hand if
you're done with it for good.
