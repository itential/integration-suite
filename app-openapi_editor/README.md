# OpenAPI Editor for Itential Platform 6

A custom Itential Platform 6 application for viewing, editing, validating,
testing, and safely updating the OpenAPI documents behind Itential's
**Integration Models**, and for managing the **Integration Instances** built
from them — all from one screen, without hand-editing JSON in Mongo or
juggling multiple Admin Essentials pages.

> **Why this exists.** Itential Platform's Integration Models and Integration
> Instances are powerful, but working with them day-to-day — tweaking an
> operation, testing a call against a real target, safely re-publishing a
> model that already has instances attached, or backing one up before a risky
> change — normally means moving between Admin Essentials screens and raw API
> calls with no safety net. This app is a purpose-built productivity layer on
> top of Itential's own sanctioned APIs, aimed at the people who work with
> Integration Models and Instances regularly and want fewer chances to make an
> unrecoverable mistake.

`[SCREENSHOT: Full app screen showing the model list sidebar on the left and
the JSON editor open on the right, with the toolbar (Validate / Backup /
Restore / Save / Delete) visible at the top]`

---

## Table of contents

1. [What it does](#what-it-does)
2. [Architecture, in brief](#architecture-in-brief)
3. [Installation](#installation)
4. [Configuration reference](#configuration-reference)
5. [Using the app](#using-the-app)
6. [Security](#security)
7. [Troubleshooting](#troubleshooting)
8. [Uninstalling](#uninstalling)

---

## What it does

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
  Monitor app reads automatically), and clean up/preview an operation before
  testing it.

`[SCREENSHOT: Operations tab showing an operation selected as the default
health check call, with the marker/badge visible]`

## Architecture, in brief

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

## Installation

### Option A — RPM (recommended for production)

A self-contained ("fat") RPM ships with this release: the app's production
`npm` dependencies are already installed and bundled inside it, and its UI is
already built. Installing it requires **no network access and no `npm
install`/build step** on the target host.

```bash
rpm -ivh itential-openapi-editor-1.0.0-1.noarch.rpm
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
   # unzip/untar/git clone app-openapi_editor here
   cd app-openapi_editor
   npm install --omit=dev
   ```
2. Restart the platform:
   ```bash
   systemctl restart pronghorn
   ```
3. In **Admin Essentials → Applications**, confirm `app-openapi_editor` is
   listed and create a **Service Instance** for it.
4. Configure its properties (see [Configuration reference](#configuration-reference)
   below) — an empty `{}` is a valid starting point.
5. **Authorize** a group (e.g. `admin`) for the app's roles
   (`admin`, `openapi_editor_user`) so it shows up in the left-hand
   navigation as **OpenAPI Editor**.

`[SCREENSHOT: Admin Essentials Applications page with app-openapi_editor
listed and its Service Instance configuration panel open]`

## Configuration reference

All properties are **optional**. Everything under "Using the app" below
works with no properties configured at all, because model/instance
operations use your own browser session against Platform's REST API rather
than a stored credential.

| Property | Type | Required for | Notes |
|---|---|---|---|
| `mongoProps.host` / `.port` / `.database` | string/number | Legacy fallback reads only | Defaults to `127.0.0.1:27017` / `itential-master` if omitted |
| `mongoProps.username` / `.password` | string | Only if your Mongo requires auth | See [Security](#security) — encrypt this |
| `platformProps.baseUrl` | string | Test panel calls that resolve relative paths | Defaults to `http://127.0.0.1:3000` |
| `platformProps.authMode` | `"none"` \| `"query"` \| `"header"` \| `"oauth2"` | Test panel auth overrides only | Has no effect on the direct-to-Platform model/instance operations |
| `platformProps.username` / `.password` | string | `authMode` = username/password login | See [Security](#security) — encrypt this |
| `platformProps.oauth.tokenUrl` / `.clientId` / `.clientSecret` / `.scope` / `.audience` | string | `authMode` = `"oauth2"` | See [Security](#security) — encrypt `clientSecret` |

A starting template ships as `sampleProperties.json` in the app folder —
copy it into the **inner** ("second") `properties` box in Admin Essentials'
Service Instance configuration screen, then fill in only what you actually
need.

`[SCREENSHOT: Admin Essentials Service Instance properties form for
app-openapi_editor, showing the mongoProps/platformProps fields]`

## Using the app

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
import/export. The companion Integration Health Monitor app reads this
marker automatically when you set up a check against this model's
integrations, so you don't have to pick an operation twice.

## Security

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
  - **Fallback, no Vault required**: the companion Health Monitor app ships
    an `encryptValue` admin utility (`POST /health-monitor/encrypt-value`)
    that returns an `$ENC...`-prefixed string using IAP's own
    `PropertyEncryption` module — paste that into the property instead of
    the plaintext.
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

## Troubleshooting

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

## Uninstalling

```bash
rpm -e itential-openapi-editor
systemctl restart pronghorn
```

Uninstalling this app does **not** touch the Integration Models or
Integration Instances it created or edited — those live in Platform's own
storage, managed through Platform's own sanctioned APIs, exactly as if
they'd been created through Admin Essentials. Only this app's own service
directory is removed.
