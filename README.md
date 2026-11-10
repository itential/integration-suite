# Itential Platform 6 Custom Apps: OpenAPI Editor & Integration Health Monitor

This guide covers two companion custom Itential Platform 6 applications,
published together but installed and run as two independent services:

| App | Installed directory |
|---|---|
| **OpenAPI Editor** | `app-openapi_editor` |
| **Integration Health Monitor** | `app-integration_health_monitor` |

Both install under Platform's services directory, e.g.:

```
/opt/itential/platform/services/app-openapi_editor
/opt/itential/platform/services/app-integration_health_monitor
```

They can be installed together or independently — neither requires the
other to function, though the Editor's Operations tab and the Monitor's
operation picker are designed to complement each other (see each app's
section below).

> **Why these exist.** Itential Platform's Integration Models and
> Integration Instances are powerful, but working with them day-to-day —
> tweaking an operation, testing a call against a real target, safely
> re-publishing a model that already has instances attached, backing one up
> before a risky change, or simply knowing whether an instance is actually
> healthy right now — normally means moving between Admin Essentials screens
> and raw API calls with no safety net. These two apps are a purpose-built
> productivity layer on top of Itential's own sanctioned APIs, aimed at the
> people who work with Integration Models and Instances regularly and want
> fewer chances to make an unrecoverable mistake.

`[SCREENSHOT: Admin Essentials Applications list showing both
app-openapi_editor and app-integration_health_monitor installed]`

---

## Table of contents

**Part 1 — OpenAPI Editor** (`app-openapi_editor`)
1. [What it does](#1-what-it-does)
2. [Architecture, in brief](#2-architecture-in-brief)
3. [Installation](#3-installation)
4. [Configuration reference](#4-configuration-reference)
5. [Using the app](#5-using-the-app)
6. [Security](#6-security)
7. [Troubleshooting](#7-troubleshooting)
8. [Uninstalling](#8-uninstalling)

**Part 2 — Integration Health Monitor** (`app-integration_health_monitor`)
1. [What it does](#1-what-it-does-1)
2. [Installation](#2-installation-1)
3. [Configuration reference](#3-configuration-reference-1)
4. [Using the app](#4-using-the-app-1)
5. [Security](#5-security-1)
6. [Troubleshooting](#6-troubleshooting-1)
7. [Uninstalling](#7-uninstalling-1)

---

# Part 1 — OpenAPI Editor

**Installed directory: `app-openapi_editor`**
(e.g. `/opt/itential/platform/services/app-openapi_editor`)

A custom Itential Platform 6 application for viewing, editing, validating,
testing, and safely updating the OpenAPI documents behind Itential's
**Integration Models**, and for managing the **Integration Instances** built
from them — all from one screen, without hand-editing JSON in Mongo or
juggling multiple Admin Essentials pages.

`[SCREENSHOT: Full app screen showing the model list sidebar on the left and
the JSON editor open on the right, with the toolbar (Validate / Backup /
Restore / Save / Delete) visible at the top]`

## 1. What it does

- **Browse and edit Integration Models** — a searchable list of every model
  on the platform, opened into a real JSON code editor (not a plain
  textarea) with syntax highlighting and inline error markers.
- **Validate** a model against the OpenAPI 3.0/3.1 spec before saving, with
  the specific error, its severity, and the line it's on called out — plus a
  clear reminder that a failed validation doesn't necessarily mean the model
  or its instances won't work; it means you should test before relying on it.
- **Save** a model through Itential's own sanctioned update sequence
  (Platform has no supported in-place update for a model with existing
  instances — this app handles the delete/reapply/recreate dance for you and
  shows you every step).
- **Backup and Restore** — a full model, on demand, before you touch it.
  Restores go back through the same sanctioned create path, never a raw
  database write.
- **Delete** a model (and, optionally, its instances) with a type-to-confirm
  safety step — no accidental deletes.
- **Create a new model from scratch**, or **Import** one from a JSON file
  someone hands you.
- **Integration Instances tab** — list, create, edit, back up, restore, and
  delete the instances tied to a model, in the same screen as the model
  itself.
- **Test panel** — fire a real HTTP request at a target server, from the
  app's own server process (not your browser, so it's never blocked by
  CORS), with Basic/Bearer/OAuth2/two-step-login auth overrides and an
  optional raw-`curl` execution path for diagnosing Node/axios-specific
  request quirks.
- **Operations tab** — pick which operation in a model should be used as its
  "default health check call" (a marker the companion Integration Health
  Monitor app reads automatically — see Part 2), and clean up/preview an
  operation before testing it.

`[SCREENSHOT: Operations tab showing an operation selected as the default
health check call, with the marker/badge visible]`

## 2. Architecture, in brief

This app talks to Itential Platform in two different ways, and which one
applies depends on what you're doing:

- **Model and Integration Instance reads/writes** (list, get, create, save,
  backup, restore, delete — both for models and for instances) go directly
  from your browser to Platform's own REST API (`/integration-models`,
  `/integrations`), using your own logged-in session cookie. Nothing is
  proxied through this app's backend, and no separate Platform credential is
  required for these operations — you're acting as yourself, with your own
  permissions, exactly as if you'd used Admin Essentials directly.
- **Validation and the Test panel's request execution** run server-side, in
  this app's own cog process, so they aren't subject to browser CORS
  restrictions and can reach targets your browser can't. This is also where
  `platformProps`/`mongoProps` (see below) come in, for the small number of
  legacy/optional code paths that still need a standing credential rather
  than your session.

Practically: most day-to-day use needs **no Service Instance properties
configured at all** beyond an empty `{}` — you'll only need to fill in
`platformProps`/`mongoProps` if you use the Test panel's advanced auth
options or hit one of the legacy fallback paths called out below.

## 3. Installation

### Option A — RPM (recommended for production)

A self-contained ("fat") RPM ships for this app: its production `npm`
dependencies are already installed and bundled inside it, and its UI is
already built. Installing it requires **no network access and no `npm
install`/build step** on the target host.

```bash
rpm -ivh itential-openapi-editor-1.0.0-1.noarch.rpm
systemctl restart pronghorn
```

Confirms it landed in the right place:

```bash
ls /opt/itential/platform/services/app-openapi_editor
```

If you only have the source tarball and spec file (not a prebuilt `.rpm`),
build it yourself on any host with `rpmbuild`, `node` (>=18), and `npm`
using the shared `build_rpm.sh` (builds RPMs for both apps in one pass):

```bash
./build_rpm.sh /path/to/app-openapi_editor /path/to/app-integration_health_monitor
# RPMs land in ./dist/
```

### Option B — Manual install from source

1. Copy the app folder into Platform's services directory, **as
   `app-openapi_editor`**:
   ```bash
   cd /opt/itential/platform/services
   # unzip/untar/git clone into a folder literally named app-openapi_editor
   cd app-openapi_editor
   npm install --omit=dev
   ```
2. Restart the platform:
   ```bash
   systemctl restart pronghorn
   ```
3. In **Admin Essentials → Applications**, confirm `app-openapi_editor` is
   listed and create a **Service Instance** for it.
4. Configure its properties (see [Configuration reference](#4-configuration-reference)
   below) — an empty `{}` is a valid starting point.
5. **Authorize** a group (e.g. `admin`) for the app's roles
   (`admin`, `openapi_editor_user`) so it shows up in the left-hand
   navigation as **OpenAPI Editor**.

`[SCREENSHOT: Admin Essentials Applications page with app-openapi_editor
listed and its Service Instance configuration panel open]`

## 4. Configuration reference

All properties are **optional**. Everything under "Using the app" below
works with no properties configured at all, because model/instance
operations use your own browser session against Platform's REST API rather
than a stored credential.

| Property | Type | Required for | Notes |
|---|---|---|---|
| `mongoProps.host` / `.port` / `.database` | string/number | Legacy fallback reads only | Defaults to `127.0.0.1:27017` / `itential-master` if omitted |
| `mongoProps.username` / `.password` | string | Only if your Mongo requires auth | See [Security](#6-security) — encrypt this |
| `platformProps.baseUrl` | string | Test panel calls that resolve relative paths | Defaults to `http://127.0.0.1:3000` |
| `platformProps.authMode` | `"none"` \| `"query"` \| `"header"` \| `"oauth2"` | Test panel auth overrides only | Has no effect on the direct-to-Platform model/instance operations |
| `platformProps.username` / `.password` | string | `authMode` = username/password login | See [Security](#6-security) — encrypt this |
| `platformProps.oauth.tokenUrl` / `.clientId` / `.clientSecret` / `.scope` / `.audience` | string | `authMode` = `"oauth2"` | See [Security](#6-security) — encrypt `clientSecret` |

A starting template ships as `sampleProperties.json` inside
`app-openapi_editor/` — copy it into the **inner** ("second") `properties`
box in Admin Essentials' Service Instance configuration screen, then fill in
only what you actually need.

`[SCREENSHOT: Admin Essentials Service Instance properties form for
app-openapi_editor, showing the mongoProps/platformProps fields]`

## 5. Using the app

### Browsing and opening a model

Open **OpenAPI Editor** from the left nav. The sidebar lists every
Integration Model on the platform by name and version — search to narrow it
down, then click one to load it into the editor.

### Editing

The right-hand pane is a real JSON editor (CodeMirror) with syntax
highlighting. Panels are resizable — drag the divider between the sidebar,
editor, and any open tab (Test, Operations, Integration Instances) to give
yourself more room to work.

`[SCREENSHOT: Resizable split-pane layout, mid-drag, showing the divider
handle]`

### Validating

Click **Validate**. Each problem found is listed individually with its
severity (blocking vs. minor vs. unknown) and, where locatable, the exact
line — click an error to jump the editor to that line. Read the caveat
banner: a failed validation is a strong signal, not a guarantee either way —
test the actual behavior (via the Test panel or a real workflow run) before
trusting or discarding the result.

`[SCREENSHOT: Validation results panel with an expanded error showing
severity badge, line number, and message text]`

### Saving

Click **Save**. Because Platform 6 has no supported in-place update for a
model that already has Integration Instances attached, this runs a
multi-step sequence — delete the affected instances, delete the model,
re-create the model from your edited spec, re-create the instances — and
shows you each step as it completes. You'll be offered a full backup
download before this starts; take it.

`[SCREENSHOT: Save confirmation modal showing the step-by-step plan and the
"Download backup first" option]`

### Backup / Restore / Delete (whole model)

The toolbar buttons appear in this order deliberately — **Validate, Backup,
Restore, Save, Delete** — least to most consequential, left to right.
Hovering any of them shows a tooltip explaining exactly what it does.
Restore and Delete both require you to retype the model's name to confirm.

`[SCREENSHOT: Delete confirmation modal with the retype-to-confirm text field]`

### Creating or importing a new model

Use **New Model** to start from a blank template, or **Import** to load a
`.json` file (an OpenAPI document, or a backup this app produced earlier).
Either way, you'll see an authorization reminder afterward — a new model on
its own doesn't grant anyone access to it; go authorize the appropriate
group/role in Admin Essentials.

`[SCREENSHOT: Post-import authorization reminder banner]`

### Integration Instances tab

Next to the Test tab. Lists every Integration Instance built from the
currently open model. From here you can create a new instance, open one to
edit its JSON directly, back it up, restore it from a prior backup, or
delete it — each individually, independent of the whole-model operations
above.

`[SCREENSHOT: Integration Instances tab showing the instance list and one
instance's JSON open for editing]`

### Test panel

Pick an operation from the searchable list, fill in parameters, choose an
auth override if the target needs something different from what's in the
spec (Basic, Bearer, OAuth2, or a two-step login flow with custom headers),
and run it. Requests execute from this app's own server, so they aren't
subject to your browser's CORS restrictions. Enable "Use curl" if you
suspect axios and curl behave differently against a particular target
(proxying, keep-alive, TLS defaults) — useful for diagnosis, not something
you'll need day-to-day.

`[SCREENSHOT: Test panel with an operation selected, parameters filled in,
and a successful response shown below]`

### Operations tab

Browse every operation a model defines, and mark one as the **default
health check call** — a small `x-health-monitor-default: true` extension
written into the spec itself, which survives Platform's own model
import/export. The companion Integration Health Monitor app (Part 2, below)
reads this marker automatically when you set up a check against this
model's integrations, so you don't have to pick an operation twice.

## 6. Security

Treat this section as a checklist, not background reading.

- **Encrypt every credential you configure.** `mongoProps.password`,
  `platformProps.password`, `platformProps.authToken`, and
  `platformProps.oauth.clientSecret` should never sit in Admin Essentials as
  plaintext. Two supported paths, and you can mix them per field (but never
  apply both to the *same* field — Platform will not double-encrypt):
  - **Preferred, if HashiCorp Vault is configured on your Platform
    instance**: just type the plaintext value into the field and save —
    Vault encrypts it automatically, and this app never sees it in
    plaintext outside of the single request that uses it.
  - **Fallback, no Vault required**: the companion Health Monitor app
    (Part 2) ships an `encryptValue` admin utility
    (`POST /health-monitor/encrypt-value`) that returns an
    `$ENC...`-prefixed string using IAP's own `PropertyEncryption` module —
    paste that into the property instead of the plaintext.
- **Model/instance operations run as you, not as a shared service
  account.** Because this app calls Platform's REST API with your own
  session cookie, whatever a user can see and change here is exactly what
  they can see and change through Admin Essentials directly — this app adds
  no privilege beyond what's already authorized. Scope the
  `openapi_editor_user` role deliberately; don't hand it out more broadly
  than you'd hand out direct Integration Model edit access.
- **The Test panel can reach anything this app's server can reach.** If
  you enable "skip TLS certificate verification" for a target, understand
  that's a real reduction in transport security for that one call — use it
  for internal/self-signed test targets only, never as a blanket setting for
  production traffic.
- **Backups contain full model/instance JSON**, which may include
  non-secret but still sensitive configuration (internal URLs, service
  names, structure). Treat downloaded backup files with the same handling
  care as any other configuration export.
- **This RPM ships with an npm-audit-clean dependency tree** at time of
  packaging (`npm audit` reports 0 vulnerabilities against the bundled
  production `node_modules`, both the cog and the built UI's runtime
  dependencies). The one flagged item in the *development* toolchain
  (`webpack-dev-server`, used only by `npm start` for local UI development)
  is a devDependency that is never bundled into the built UI or this RPM —
  it has no runtime exposure in a deployed instance. Re-run `npm audit` for
  yourself before every release; dependency trees drift.

## 7. Troubleshooting

**"Couldn't load model... did not include a full OpenAPI document
(openapi/paths)"** — Platform's plain `GET /integration-models/:id` only
returns a summary shape, not the full spec; this app tries the `/export`
variant first. If you see this, the export endpoint may have returned an
unexpected shape on your Platform version — check the browser console for
the raw response logged there and compare against what this app expects in
`ui/src/api.js`'s `extractSpec()`.

**Save fails with a Mongo connection error
(`MongoServerSelectionError`)** — Save uses Platform's own REST API, not a
direct database write; a Mongo error here means something is still falling
back to a legacy path. Confirm you're on the current build of this app (the
rearchitected version removed the direct-Mongo save path entirely).

**Recreating an Integration Instance fails with "Currently this feature is
not supported for services of type..."** — the entire instance payload must
be wrapped one level deeper, under a `properties` key, when calling
Platform's `POST /integrations`. This app does this correctly as shipped; if
you've modified `ui/src/api.js`, check that wrapping is still intact.

**Validation says there's an error but nothing is highlighted in the
editor** — this was a real, fixed bug: `$ref`-style errors reference a
pointer string (like `#/components/schemas/Foo`) that never appears
standalone-quoted in the document, so a naive quoted-string search for the
error's "segment" would silently find nothing. Confirm you're on a build
where `ui/src/util/validateHints.js` does a plain substring search, not a
quoted one.

**Integration Instances tab loads data (network tab shows a 200) but shows
a blank panel** — also a real, fixed bug: a missing `flex: 1 1 auto` /
`min-height: 0` down the `.integration-instances-*` container chain
collapsed the CodeMirror instance to zero height. Data was never the
problem; layout was.

**A model import or restore "succeeded" but nobody can see the new
model/instance** — expected, not a bug: creating something doesn't
automatically authorize anyone to use it. Go to Admin Essentials and
authorize the relevant group for the model/instance, same as you would for
one created directly in Admin Essentials.

## 8. Uninstalling

```bash
rpm -e itential-openapi-editor
systemctl restart pronghorn
```

Uninstalling this app does **not** touch the Integration Models or
Integration Instances it created or edited — those live in Platform's own
storage, managed through Platform's own sanctioned APIs, exactly as if
they'd been created through Admin Essentials. Only the
`app-openapi_editor` service directory is removed.

---

# Part 2 — Integration Health Monitor

**Installed directory: `app-integration_health_monitor`**
(e.g. `/opt/itential/platform/services/app-integration_health_monitor`)

A custom Itential Platform 6 application that periodically calls a
user-configured operation against an adapter, app, or **Integration
Instance**, and tracks whether it's responding correctly — a lightweight,
purpose-built health dashboard for the things you've built on top of
Itential's **Integration Models**.

`[SCREENSHOT: Dashboard view showing a sortable/filterable table of checks
with health state badges (healthy/unhealthy/unknown) per row]`

## 1. What it does

- **Scheduled health checks** against adapters, custom apps, or Integration
  Instances — each check has its own interval, independent of the others.
- **Sortable, filterable dashboard** across every column (target, type,
  state, last checked, last status code, response time).
- **Auto-discovery of targets** — pulls candidate adapters/apps/integrations
  from Platform's own configuration so you're picking from a real list, not
  typing target names by hand.
- **Operation picker for Integration targets** — reads the target's own
  OpenAPI model (via the companion OpenAPI Editor app's model data, Part 1)
  and offers its operations directly, including whichever one was marked as
  the "default health check call" in that model's Operations tab.
- **Restart action** for unresponsive adapters/apps, directly from the
  dashboard (not offered for Integrations — restarting a process isn't a
  concept that applies to them).
- **Run Now** — trigger any check on demand, outside its schedule.
- **Flexible per-check auth** — none, Basic, static Bearer token, or its own
  independent OAuth2 client-credentials grant, entirely separate from the
  auth this app itself uses to reach Platform.
- **Encrypted storage for every secret this app holds** — both the
  credentials it uses to reach Platform, and the target-auth secrets stored
  on a check itself. See [Security](#5-security-1).

`[SCREENSHOT: Add/Edit Check form showing target picker, operation picker,
interval field, and auth mode selector]`

## 2. Installation

### Option A — RPM (recommended for production)

A self-contained ("fat") RPM ships for this app: its production `npm`
dependencies are already installed and bundled inside it, and its UI is
already built. Installing it requires **no network access and no `npm
install`/build step** on the target host.

```bash
rpm -ivh itential-health-monitor-1.0.0-1.noarch.rpm
systemctl restart pronghorn
```

Confirms it landed in the right place:

```bash
ls /opt/itential/platform/services/app-integration_health_monitor
```

If you only have the source tarball and spec file (not a prebuilt `.rpm`),
build it yourself on any host with `rpmbuild`, `node` (>=18), and `npm`
using the shared `build_rpm.sh` (builds RPMs for both apps in one pass):

```bash
./build_rpm.sh /path/to/app-openapi_editor /path/to/app-integration_health_monitor
# RPMs land in ./dist/
```

### Option B — Manual install from source

1. Copy the app folder into Platform's services directory, **as
   `app-integration_health_monitor`**:
   ```bash
   cd /opt/itential/platform/services
   # unzip/untar/git clone into a folder literally named app-integration_health_monitor
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
   [Configuration reference](#3-configuration-reference-1) below) — unlike
   the Editor app, this app **does** need both, since it runs unattended on
   a schedule with no logged-in user to borrow a session from.
5. **Authorize** a group (e.g. `admin`) for the app's roles
   (`admin`, `health_monitor_user`) so it shows up in the left-hand
   navigation as **Health Monitor**.

`[SCREENSHOT: Admin Essentials Applications page with
app-integration_health_monitor listed and its Service Instance
configuration panel open]`

## 3. Configuration reference

Unlike the Editor app, this app runs unattended on a schedule — there's no
logged-in user to borrow a session token from — so `mongoProps` (where it
stores its own check configuration and results) and `platformProps` (how it
authenticates when calling an adapter/app's status endpoint) are both
**required**.

| Property | Type | Required | Notes |
|---|---|---|---|
| `mongoProps.host` / `.port` / `.database` | string/number | Yes | This app's own `health_checks` collection lives here |
| `mongoProps.username` / `.password` | string | If your Mongo requires auth | **Encrypt this** — see [Security](#5-security-1) |
| `platformProps.baseUrl` | string | Yes | Where Platform's own web server is reachable, e.g. `http://127.0.0.1:3000` |
| `platformProps.authMode` | `"none"` \| `"query"` \| `"header"` \| `"oauth2"` | Yes | How to authenticate calls to an **adapter/app** target's status endpoint. Has no effect on Integration targets, which use their own independent auth below |
| `platformProps.username` / `.password` | string | If `authMode` uses username/password login | **Encrypt `.password`** |
| `platformProps.authToken` | string | If using a static token instead of login | **Encrypt this** |
| `platformProps.oauth.tokenUrl` / `.clientId` / `.clientSecret` / `.scope` / `.audience` | string | If `authMode` = `"oauth2"` | **Encrypt `.clientSecret`** |

Per-check settings (target, operation, interval, auth mode, and — for
Integration targets — their own independent `authUsername`/`authPassword`/
`authToken`/`oauth.{...}`/`credentialPaths.{...}`) are configured entirely
through the app's own UI, not through Service Instance properties — see
[Using the app](#4-using-the-app-1) below.

`[SCREENSHOT: Admin Essentials Service Instance properties form for
app-integration_health_monitor, showing mongoProps/platformProps fields]`

## 4. Using the app

### Adding a check

Click **Add Check**. Pick a target from the auto-discovered list (adapters,
apps, and Integration Instances are all offered, labeled by type). For an
Integration target, the operation picker reads that model's own OpenAPI
document and highlights whichever operation was marked as the default
health check call in the OpenAPI Editor app's Operations tab (Part 1) — pick
that one unless you have a specific reason not to. Set an interval (checks
run independently of each other; a shared internal scheduler just wakes up
every 15 seconds to see which ones are due).

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

## 5. Security

Treat this section as a checklist, not background reading. This app is the
more security-sensitive of the two covered in this guide, because unlike
the Editor app, it **must** hold a standing credential — it runs unattended
on a schedule, with no logged-in user to act on behalf of.

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

## 6. Troubleshooting

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

## 7. Uninstalling

```bash
rpm -e itential-health-monitor
systemctl restart pronghorn
```

Uninstalling this app removes only the `app-integration_health_monitor`
service directory. Its configured checks and their history live in this
app's own `health_checks` Mongo collection and are **not** removed
automatically — back that collection up first if you might reinstall later,
or drop it by hand if you're done with it for good.
