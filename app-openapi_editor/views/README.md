# app-openapi_editor

A custom Itential Platform application for viewing and editing the OpenAPI
documents IAP stores for Integration Models, in the `integration_models`
MongoDB collection. The UI is a Swagger-Editor-style split view: raw JSON on
the left, and the same live-updating rendered API documentation you'd see on
editor.swagger.io on the right (via `swagger-ui-react`), inside an Itential-
styled shell (navy/teal sidebar and topbar).

Supports both OpenAPI 3.0.x and 3.1.0 documents.

## Structure

```
app-openapi_editor/
├── package.json          # cog's npm package manifest
├── pronghorn.json        # tells IAP this is an app: methods, routes, view
├── src.js                # the cog - server-side logic, Mongo access
├── sampleProperties.json # example service instance configuration
├── img/icon.png          # app icon shown in the IAP nav (Itential mark)
├── views/                # live template copy (see "Known deployment quirk" below)
└── ui/                    # React presentation layer
    ├── package.json
    ├── webpack.config.js
    ├── src/
    │   ├── index.html / index.jsx / App.jsx / styles.css / mockData.js
    │   ├── api.js               # fetch wrapper for the cog's REST routes
    │   ├── assets/itential-icon.png
    │   └── components/
    │       ├── Sidebar.jsx      # model list + search, Itential brand mark
    │       ├── Editor.jsx       # raw JSON editor pane
    │       └── Preview.jsx      # swagger-ui-react live rendered preview
    └── dist/              # pre-built production bundle (already built)
```

## What it does

- **List** (`GET /openapi-editor/models`) — sidebar of every OpenAPI document
  in `integration_models`, showing title + version.
- **View** (`GET /openapi-editor/models/:modelId`) — loads one document,
  split into `{ spec, meta }` (see "Spec vs. meta fields" below).
- **Validate** (`POST /openapi-editor/models/validate`) — runs the in-progress
  edit through `@apidevtools/swagger-parser` without saving, so a user can
  check for errors before committing. Works for OpenAPI 3.0.x and 3.1.0.
- **Test** (`POST /openapi-editor/test-request`) — runs an ad hoc request
  against a real target server, server-side (from the cog process, not the
  browser) — see "Testing operations without CORS" below.
- **Save** (`GET /openapi-editor/models/:modelId/update-impact` then
  `PUT /openapi-editor/models/:modelId`) — updates the model via Itential
  Platform's own sanctioned process (delete/reapply/recreate), not a direct
  Mongo write — see "Updating a model — the sanctioned process" below.

## Spec vs. meta fields

The real `integration_models` documents carry fields that are **not** part of
the OpenAPI spec itself: `_id` (Mongo's document id) and `versionId` (an
Itential-derived string like `"MockServer API:1.0.0"`). This app keeps both
out of the editable JSON entirely:

- `getModel` returns `{ spec, meta }` — `spec` is the pure OpenAPI document
  (safe to feed straight to the JSON editor, a validator, or `swagger-ui-react`);
  `meta` is `{ id, versionId, model }`.
- The editor/preview panes only ever see `spec`. The topbar displays
  `meta.versionId` read-only next to the title.
- `saveModel` takes only the edited `spec` and recomputes `versionId` from
  `spec.info.title` + `spec.info.version` so it can never drift out of sync
  with an edited title/version — but see below, it no longer writes this
  straight to Mongo.

## Updating a model — the sanctioned process

**This app used to `updateOne` the Mongo document directly on Save.** That
writes the document correctly, but Itential Platform has **no supported
in-place update** for an integration model that has existing Integration
instances built on it — calling Itential's own `PUT /integration-models`
against such a model returns an error like:

```
Cannot update model IAP REST API2:1.0.3 due to 1 existing integration instance(s).
```

Itential's own tooling handles this by: deleting every dependent Integration
instance, deleting the model, re-importing (`PUT`) the updated model, then
recreating each deleted instance. A direct Mongo write skips all of that —
which is exactly why editing a model, wire structure aside, previously left
a "clean up function" undone. `saveModel` now performs this same sequence,
via Itential's own real REST API (all confirmed against
`docs.itential.com/itential-platform/6/api-reference/`, both the
`integration-models` and `integrations` categories):

1. Read the current model document (need its *old* `versionId`).
2. Find every Integration instance built from this model - a direct,
   read-only Mongo lookup matching each instance's own
   `service_configs.properties.type` against the model's `versionId`. This
   is the field that actually links an instance to its model (confirmed
   against a real document - `integration_models` itself carries no `model`
   field at all, an earlier assumption based on IAP's API reference example
   turned out wrong). An instance's own top-level `model` string is in turn
   always exactly `"@itential/adapter_" + versionId` (confirmed against
   several real examples), so it's derived (`deriveModelIdentifier()`)
   rather than trusted from a stored field.
3. `DELETE /integrations/{name}` for each dependent instance. **All-or-
   nothing**: if any of these fail, the process stops here without touching
   the model at all, and reports exactly which instance(s) blocked it.
4. `DELETE /integration-models/{versionId}` — deletes the model itself,
   identified by its *old* `versionId` (this is the same identifier IAP's
   own error message above uses).
5. `PUT /integration-models` with `{ model: <edited spec> }` — reapplies
   (recreates) the model. Note there's no `{id}` in this path; Itential
   matches/creates by the spec's own `info.title`/`info.version` internally.
6. Computes the **new** `versionId`/`model` identifier directly from the
   edited spec (its version suffix changes if `info.version` changed).
7. `POST /integrations` to recreate each deleted instance, using its backed-
   up `properties`/`type`/`isEncrypted`/`description`/`loggerProps`, but
   with **both** its top-level `model` string **and** its nested
   `properties.type` updated to the new versionId/model (that nested field
   is the real link, per step 2 above — both need to match the recreated
   model or the instance won't resolve to it). **Best-effort**: every
   instance is attempted even if one fails, since the model is already
   replaced by this point — getting instances back matters more than
   stopping on one error.

Every step's outcome is recorded and returned to the UI (`{ success, steps,
versionId, errors, backup }`), and the full `backup` (the original spec +
every dependent instance's raw config) is always included in the response —
even on failure — so nothing is unrecoverable.

**The UI surfaces all of this before anything happens.** Clicking Save first
calls `GET /openapi-editor/models/:modelId/update-impact` (read-only) and
shows a confirmation modal listing exactly which Integration instances would
be deleted/recreated, with a **"Download backup"** button that saves the
same payload as a JSON file to your machine before you confirm. After
confirming, the same modal shows a step-by-step result list (✓/✗ per step)
so a partial failure is immediately visible and diagnosable, with the backup
still downloadable from the result screen.

## Creating a new model

The **+ New Model** button in the sidebar opens a blank editor pre-filled
with a minimal valid OpenAPI skeleton (`openapi`, `info.title`/`version`,
an empty `servers`/`paths`) rather than loading an existing document.
Clicking **Create Model** (Save's label while in this mode) is a much
simpler motion than updating an existing model: there are no dependent
Integration instances to warn about, back up, delete, or recreate, so this
skips the confirmation modal entirely and calls `POST /openapi-editor/models`
directly, which:

1. Validates the spec (same `@apidevtools/swagger-parser` check as Validate).
2. Confirms no existing model already has the same `versionId`
   (`info.title` + `info.version` must be unique) - a clear error if so,
   rather than silently colliding.
3. Calls Itential's own `POST /integration-models` — the sanctioned create
   endpoint - with `{ model: spec }`. There is no delete/reapply/recreate
   dance here (2.4's whole reason for existing): a brand-new model has no
   instances yet, so plain creation is already the correct, sanctioned path.

**This intentionally does not create an Integration instance.** Creating a
model and creating an instance of that model are two separate, independently
-sanctioned actions in Itential Platform - this app's scope is the model
definition itself. After a successful create, the UI shows an explicit
message telling the user to create an instance for the new model using
Itential's own normal process (e.g. Admin Essentials → Integrations → Add),
the same way they would for any other existing model.

## Operations tab: browse, test, and clean up in one place

The **Operations** tab (next to Preview and Test) merges browsing/cleanup
into one unified view - a companion to the standalone Test tab below
(both remain available; Operations added a merged option, it didn't
replace Test). It lists every
operation grouped by category/tag, exactly the same grouping
`swagger-ui-react` uses in the Preview pane, but each category and
operation is interactive:

- A search box filters by method, path, summary, or category.
- Each category has a select-all checkbox, and collapses/expands via its
  own caret (independent of the checkbox, so browsing and selecting don't
  interfere with each other).
- Each operation row has its own removal checkbox, plus an expand toggle
  that reveals its parameters (name/in/required/description) and documented
  responses (status code + description) - the same information the Preview
  pane's per-operation detail view shows, without leaving this tab.
- That same expanded row also has a full test-and-send form: path
  parameters, a query-params JSON box, a request body box where
  applicable, and a Send button with the result (status/timing/body) shown
  right there.

This list is deliberately a separate, purpose-built component rather than
checkboxes/test controls injected directly into the Preview pane itself:
`swagger-ui-react` is a third-party rendering library with no supported way
to add interactive controls into its own rendered rows. Preview remains
the polished, read-only rendered view (and updates live as you type, same
as always); Operations is where you actually interact with individual
calls.

**Shared test settings.** A collapsible "Test settings" panel above the
operation list holds the server base URL, custom headers, and auth
mode (None/Basic/Bearer/OAuth2/Login request) - configured once and used
by every operation's Send button below, so you're not re-entering auth for
each call you want to try. The **Login request** mode is a two-step flow
for APIs that issue a token from a separate login call (e.g. POST
username/password, get a token back) rather than a standard OAuth2
client-credentials grant: you configure the login sub-request itself
(method, URL, headers, body), a dot-path into its JSON response for where
the token lives (e.g. `data.access_token`), and how the real request
should carry it - a header (any name/prefix, not just
`Authorization: Bearer`) or a query parameter. All test requests run
**server-side**, inside this app's own cog process
(`POST /openapi-editor/test-request`), not in the browser - the browser
only ever talks to this app's own same-origin route, so browser CORS never
applies, the same as the old Test tab.

**Removing operations.** Checking operations doesn't change anything by
itself - nothing happens until you click **Apply removals to editor**, at
which point the selected operations are removed from the spec's `paths`,
any path left with no HTTP methods at all is removed entirely, and any
`tags` entry no longer referenced by a remaining operation is pruned too.
This only rewrites the editor's in-memory JSON (marking it dirty, same as
any manual edit) - it does **not** touch Mongo or call the platform API.
You still need to click **Save** afterward to actually persist the change
via the sanctioned update process (2.4 above).

Because the operation list is derived from the same live-parsed spec as
everything else in the app, editing the JSON in the left-hand editor
updates the Operations list automatically on every keystroke (as soon as
the document is valid JSON again) - there's no separate refresh or re-sync
step.

## Backend (cog) notes

- Uses the plain `mongodb` Node.js driver against the `integration_models`
  collection for reads and for the read-only "find associated integrations"
  lookup — but no longer for writes; see "Updating a model" above.
- Uses `@apidevtools/swagger-parser` (not the older, less maintained
  `swagger-parser` package) specifically because it validates OpenAPI 3.1.0
  documents in addition to 3.0.x.
- Mongo connection details come from a process-wide implicit global named
  `service_config`, set by IAP's own `ServiceBootstrap.js` — specifically
  `service_config.properties.mongoProps`. This was confirmed against a live
  Platform 6 instance; **this is not documented anywhere and may differ
  across IAP versions** - if this app throws `ReferenceError: service_config
  is not defined` or a Mongo auth error on your build, check how a sibling
  adapter/app already installed on your box accesses its own properties and
  match that instead.
- **New requirement: `platformProps`.** Since `saveModel` now calls
  Itential's own REST API instead of writing to Mongo directly, this app's
  Service Instance properties must also include a `platformProps` block.
  Itential's own docs specify Basic auth for these routes, but on this
  environment Basic auth returned 401 even with valid credentials - use
  `authMode: "oauth2"` instead:
  ```json
  "platformProps": {
    "baseUrl": "http://127.0.0.1:3000",
    "authMode": "oauth2",
    "oauth": {
      "tokenUrl": "https://your-auth-provider.example.com/oauth/token",
      "clientId": "...",
      "clientSecret": "...",
      "scope": "",
      "audience": ""
    }
  }
  ```
  The OAuth2 token is fetched via the standard client-credentials grant,
  cached in memory until near expiry, and automatically retried once with a
  fresh token if a call comes back 401 (the token simply expiring mid-save
  shouldn't fail the whole process). `authMode: "basic"` (with
  `username`/`password`) is still supported and is what IAP's own API
  reference documents as the default - use it if your environment's account
  actually accepts Basic auth against `/integration-models`/`/integrations`,
  which was not the case here.
- **`oauth.clientId`/`oauth.clientSecret` (and `password`, for Basic mode)
  can be stored as `$ENC...`-encrypted values instead of plaintext** in this
  app's own Service Instance properties - decrypted fresh on every use via
  the same `@itential/itential-utils` `PropertyEncryption` mechanism (and
  `pronghornProps.encryptionKey`) already proven out for
  `app-integration_health_monitor`'s credential decryption feature. Nothing
  decrypted is ever persisted; a plain (non-`$ENC`) value passes through
  unchanged, so this is fully optional.

  To produce an `$ENC` value for one of these fields, run this on the
  Platform 6 host itself (same encryption key this app's own process
  already has access to via `pronghornProps`):
  ```bash
  node -e "
    const { PropertyEncryption } = require('/opt/itential/platform/server/node_modules/@itential/itential-utils');
    const enc = new PropertyEncryption({}, process.env.IAP_ENCRYPTION_KEY);
    console.log(enc.newEncryption('your-plaintext-secret-here'));
  "
  ```
  (substitute your platform's actual encryption key however your build
  exposes it - `pronghornProps.encryptionKey` isn't set as a plain env var
  by default; check how a working adapter/integration's own encrypted
  properties were generated on your instance for the exact incantation).
  Paste the resulting `$ENC...` string directly into `oauth.clientSecret`
  (etc.) in Admin Essentials in place of the plaintext value.
- Configure Mongo + platform credentials under Admin Essentials →
  Applications → openapi-editor → Service Instance → Properties, using
  `sampleProperties.json` as a starting shape (the actual nesting must match
  what your IAP build's `createServiceConfig()` produces — again, use a
  working sibling app's properties file as the template if in doubt).
- `saveModel` always re-validates server-side (never trusts the client),
  even though the UI also calls `/validate` proactively.

## Frontend notes

- React 18, bundled with Webpack.
- **Preview pane uses `swagger-ui-react`** — the same rendering engine
  editor.swagger.io uses — so the right-hand pane looks and behaves like the
  real Swagger Editor, updating live as you type in the left pane. Its own
  top bar is hidden via CSS (`.swagger-preview-pane .swagger-ui .topbar`)
  since our Itential topbar already sits above it.
- **Editor pane is a real JSON code editor** (CodeMirror 6, via
  `@uiw/react-codemirror` + `@codemirror/lang-json` + `@codemirror/lint`),
  not a plain `<textarea>`: JSON syntax highlighting, live syntax-error
  checking (a gutter marker + squiggly underline appears at the exact spot a
  document stops being valid JSON, in addition to the existing parse-error
  banner), and code folding — click the triangles in the left gutter to
  collapse any object or array (an entire `paths` block, one operation,
  a deeply nested schema, etc.) down to a single line.
- Colors/typography approximate Itential's navy (#0B1F3A) + teal/blue accent
  brand palette with Open Sans/Montserrat type, and the sidebar mark is
  Itential's actual public logo icon (pulled from itential.com). Confirm
  against your org's current design tokens before shipping broadly —
  Platform's own UI has been migrating to a newer design system ("Mosaic")
  and colors may have shifted since this was built.
- If no live IAP backend is reachable (e.g. running `npm start` for pure UI
  iteration), the app automatically falls back to bundled mock data
  (`mockData.js`) and shows a "Demo data" pill, so the UI remains fully
  explorable standalone.

## Research note: reducing/eliminating the platformProps requirement

Investigated whether this app could reuse Platform 6's own internal
service-to-service authentication instead of requiring its own
separately-configured `platformProps` (OAuth2 client or Basic credentials).
No confirmed, documented internal mechanism for a custom app to borrow the
platform's own system-level credentials was found via Itential's public API
reference or general documentation - `platformProps` (a dedicated service
account, OAuth2 or Basic) currently appears to be the supported way for a
custom app to call Platform 6's own REST API.

The one lower-lift alternative worth prototyping in a future session: since
every request into this app's own routes already carries the logged-in
user's own session (cookie/`Authorization` header, via
`credentials: 'include'` in `api.js`), it may be possible for the cog to
forward that same incoming credential on its outbound call to
`/integration-models`/`/integrations`, instead of maintaining a separate
service account. This depends on whether this app's pronghorn `task: true`
methods can access the raw incoming request/response objects (current
methods here only declare their business-logic input parameters) - that
needs to be confirmed against how this specific Platform 6 build's app
framework exposes `req`/`res` to a method, if at all, before it's worth
building out. Flagged as a next-step research item, not yet implemented.

## Known deployment quirk: view template path

IAP resolves a view's `template` relative to the app's `views/` directory,
not wherever `uiDirectories` points. This package's `pronghorn.json` sets
`"template": "index.html"`, and a **copy** of the built `index.html` +
`bundle.js` + icon PNG is kept in `views/` alongside the real build in
`ui/dist/` (which is what the browser actually loads its JS bundle from, per
the `publicPath` baked into `webpack.config.js`). If you rebuild the UI,
remember to copy the new `ui/dist/*` files into `views/` too, or IAP will
serve a stale `index.html` shell.

## Build & install

```bash
# 1. Build the UI (already built once into ui/dist/ in this delivery)
cd ui
npm install
npm run build
cp dist/* ../views/     # keep the views/ copy in sync - see quirk above

# 2. Place the whole app-openapi_editor/ folder in IAP's services directory
cd /opt/itential/platform/services
git clone <your-repo> app-openapi_editor   # or copy this folder directly
cd app-openapi_editor
npm install       # installs the cog's dependencies (mongodb, @apidevtools/swagger-parser)

# 3. Make sure ownership matches your other installed apps, e.g.:
chown -R itential:itential /opt/itential/platform/services/app-openapi_editor

# 4. Restart IAP
systemctl restart pronghorn

# 5. In Admin Essentials:
#    - Configure the app's Service Instance properties (mongoProps) - see
#      "Backend (cog) notes" above
#    - Authorize a group (e.g. admin) for the app's roles
```

The app will then appear in IAP's navigation as "OpenAPI Editor".

## Verification performed

- `npm run build` (Webpack, production mode) completes with no errors from a
  clean `npm install`, and produces a working `bundle.js` + `index.html`
  (large bundle-size warnings from `swagger-ui-react` are expected, not
  errors).
- `src.js` was syntax-checked with `node -c`.
- Confirmed working end-to-end against a live Platform 6 instance for
  list/get/validate/save, including the Mongo auth and view-template
  deployment issues documented above.
- The OpenAPI 3.1.0 validation path and the new `swagger-ui-react` preview
  have **not yet been tested against a live IAP instance** — only verified
  to build successfully. Test both in a dev environment (try saving a 3.1.0
  document, and confirm the live preview renders/updates as expected) before
  relying on them in production.
