// Thin wrapper around the cog's REST routes. Base path matches the app's
// title in pronghorn.json ("openapi-editor"), so in production these calls
// resolve to <host>:<port>/openapi-editor/... automatically. During local
// UI development (webpack-dev-server) requests are proxied to a running IAP
// instance on :3000 - see webpack.config.js devServer.proxy.
const BASE = '/openapi-editor';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// --- Direct-to-Platform calls (no service-account credential) ------------
//
// listModels/getModel/createModel below call Itential Platform's OWN
// /integration-models REST API straight from the browser, instead of going
// through this app's cog (which previously needed either mongoProps, to
// read the integration_models collection directly, or platformProps, to
// make its own OAuth2/Basic-authenticated server-to-server call for
// create). Since this app's UI is served from the same origin as core
// Platform, a same-origin fetch automatically carries the browser's
// existing IAP session cookie - the request is authenticated and
// authorized as whichever user is actually logged in, with no separate
// credential configured anywhere in this app's Service Instance.
//
// This is new and NOT yet confirmed against every possible Platform 6
// build/version - the exact response shape of GET /integration-models in
// particular was not directly observable while building this (the public
// docs page for it renders client-side and couldn't be inspected here).
// Each function below tries the direct call first, logs a console.warn and
// falls back to this app's own (already-proven-working) cog route on any
// failure or unexpected shape, so the app keeps working today no matter
// what your build returns - watch the browser console while testing to see
// which path actually served each request.
async function platformRequest(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    throw new Error(`Platform API request failed: ${res.status} ${res.statusText} ${detail}`.trim());
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Normalizes an IAP integration-model document down to the same
// { id, title, version, openapiVersion, versionId } shape the sidebar
// already expects from the cog's own /models route. Handles a couple of
// plausible shapes (spec nested under `model`/`spec`, or flat) since the
// exact shape wasn't directly observable while building this - if neither
// guess matches your build, listModels() falls back to the cog route
// automatically (see the console.warn it logs when that happens).
// Confirmed live against a real Platform 6 instance: GET /integration-models
// returns { integrationModels: [ { model, versionId, description,
// properties: {...auth config...} }, ... ] } - NOT the raw OpenAPI document
// (no info/openapi/paths on this summary object; `versionId` is the same
// "title:version" string src.js's computeVersionId already produces, and
// `model` is the "@itential/adapter_<versionId>" identifier
// deriveModelIdentifier already produces). There is no separate numeric/
// Mongo-style id in this shape, so versionId itself is used as the id -
// it's unique per model and is exactly what getModel/saveModel/deleteModel
// need to address a specific model anyway.
function normalizePlatformModel(doc) {
  const versionId = doc.versionId || '';
  const lastColon = versionId.lastIndexOf(':');
  const title = lastColon === -1 ? versionId : versionId.slice(0, lastColon);
  const version = lastColon === -1 ? '' : versionId.slice(lastColon + 1);
  return {
    id: versionId,
    title,
    version,
    openapiVersion: undefined,
    versionId,
    model: doc.model,
    description: doc.description,
  };
}

export async function listModels() {
  try {
    const raw = await platformRequest('/integration-models');
    const docs = Array.isArray(raw) ? raw : (raw && (raw.integrationModels || raw.models || raw.data || raw.list));
    if (!Array.isArray(docs)) throw new Error('unexpected response shape from GET /integration-models');
    return docs.map(normalizePlatformModel);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openapi-editor] Direct Platform API list failed, falling back to cog/Mongo route:', err.message);
    return request('/models');
  }
}

// Pulls whatever looks like the actual OpenAPI document (openapi/paths) out
// of a Platform API response, checking every plausible nesting we've seen
// across these endpoints so far (flat, .spec, .openapiDocument, .model when
// model is an object rather than the "@itential/adapter_..." string).
function extractSpec(doc) {
  const candidates = [doc, doc && doc.spec, doc && doc.openapiDocument, doc && typeof doc.model === 'object' && doc.model];
  return candidates.find((c) => c && c.openapi && c.paths) || null;
}

export async function getModel(modelId) {
  const encodedId = encodeURIComponent(modelId);
  // Plain GET /integration-models/:id returned only the same summary shape
  // listModels() gets (confirmed live) - no openapi/paths. "Export an
  // integration model" is a separate, documented endpoint
  // (docs.itential.com/itential-platform/6/api-reference/integration-models/
  // export-integration-model) that's the more likely source of the actual
  // re-importable OpenAPI document, so it's tried first here.
  const attempts = [
    { label: 'export', path: `/integration-models/${encodedId}/export` },
    { label: 'get', path: `/integration-models/${encodedId}` },
  ];

  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const doc = await platformRequest(attempt.path);
      const spec = extractSpec(doc);
      if (spec) {
        return {
          spec,
          meta: { id: modelId, versionId: (doc && doc.versionId) || modelId, model: doc && doc.model },
        };
      }
      // eslint-disable-next-line no-console
      console.warn(`[openapi-editor] GET ${attempt.path} succeeded but had no openapi/paths - raw response:`, doc);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[openapi-editor] GET ${attempt.path} failed:`, err.message);
    }
  }

  // NOTE: no automatic fallback to the cog's /models/:modelId route here,
  // deliberately - that route expects a Mongo _id, but modelId at this
  // point is a versionId string (since listModels() above is now sourced
  // from the direct Platform API, not Mongo). Falling back would look like
  // it worked but silently query the wrong id shape.
  throw new Error(`Couldn't load a full OpenAPI document for model "${modelId}" from Platform's own API - check the browser console for the raw response(s) from each attempted endpoint.`);
}

export const validateModel = (spec) => request('/models/validate', {
  method: 'POST',
  body: JSON.stringify({ spec }),
});

// Creates a brand-new integration model (no modelId yet - this IS the
// create call). Does not create an Integration instance; see src.js#createModel
// for why that's a deliberately separate, normal-process step. Tries a
// direct browser -> Platform POST /integration-models first (session-cookie
// auth, no platformProps credential involved); falls back to the cog's own
// route - which still performs this the sanctioned way via its own
// platformProps credential - if the direct call fails for any reason.
export async function createModel(spec) {
  try {
    await platformRequest('/integration-models', {
      method: 'POST',
      body: JSON.stringify({ model: spec }),
    });
    const versionId = `${spec.info && spec.info.title}:${spec.info && spec.info.version}`;
    const updated = await listModels();
    const created = updated.find((m) => m.versionId === versionId) || null;
    return {
      success: true,
      steps: [{ name: `Create integration model "${versionId}"`, ok: true, detail: null }],
      versionId,
      modelId: created && created.id,
      errors: [],
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openapi-editor] Direct Platform API create failed, falling back to cog route:', err.message);
    return request('/models', {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
  }
}

// --- Direct-to-Platform update flow (no mongoProps, no platformProps) ----
//
// The cog's original getUpdateImpact/saveModel read/wrote Mongo directly
// (service_configs / integration_models) via mongoProps, and separately
// called Itential's REST API server-side via platformProps for the actual
// delete/reapply/recreate steps. Confirmed live that Mongo is now
// unreachable from the cog's own host ("MongoServerSelectionError: connect
// ECONNREFUSED 127.0.0.2:27017") - which is exactly the kind of standing
// dependency this whole redesign is trying to remove. Below re-implements
// the same sanctioned delete-instances / delete-model / reapply-model /
// recreate-instances sequence (see src.js#saveModel's doc comment for the
// full rationale) entirely as browser -> Platform REST calls, using
// documented endpoints (docs.itential.com/itential-platform/6/api-reference
// /integrations/*) - GET/POST/DELETE /integrations - the same way
// listModels/getModel/createModel above already do for integration-models.
//
// Not yet confirmed live: the exact field Platform uses to identify an
// integration for DELETE /integrations/{name} (assumed to be `name`, per
// the docs page title "Delete an integration" and this app's own prior,
// working platformProps-based DELETE calls), and the exact shape of a GET
// /integrations list item (assumed to carry `properties.type` set to the
// model's versionId, matching the Mongo shape this app already relied on).
// If either assumption is wrong, this will surface clearly in the returned
// `steps`/`errors` rather than fail silently - check the browser console
// and the step list in the confirmation modal after a real test.

const deriveModelIdentifier = (versionId) => `@itential/adapter_${versionId}`;

async function fetchAssociatedIntegrations(versionId) {
  const raw = await platformRequest('/integrations');
  const list = Array.isArray(raw) ? raw : (raw && (raw.integrations || raw.data || raw.list)) || [];
  return list.filter((doc) => (doc.properties && doc.properties.type) === versionId || doc.model === deriveModelIdentifier(versionId));
}

export async function getUpdateImpact(modelId) {
  const { spec, meta } = await getModel(modelId);
  const versionId = meta.versionId || modelId;
  const integrations = await fetchAssociatedIntegrations(versionId);
  return {
    versionId,
    model: deriveModelIdentifier(versionId),
    associatedIntegrations: integrations.map((i) => ({ name: i.name, type: i.type, description: i.description })),
    backup: {
      model: spec,
      meta: { versionId, model: deriveModelIdentifier(versionId) },
      integrations,
    },
  };
}

// Runs the full delete-instances/delete-model/reapply-model/recreate-
// instances process directly from the browser against Itential's own REST
// API (session-cookie auth) - NOT a Mongo write, and NOT a server-side cog
// call requiring platformProps. Returns { success, steps, versionId,
// errors, backup } so the UI can show real step-by-step progress/results,
// same contract the cog's version returned.
export async function saveModel(modelId, spec) {
  const steps = [];
  const recordStep = (name, ok, detail) => steps.push({ name, ok, detail: detail || null });
  let backup = null;

  try {
    const impact = await getUpdateImpact(modelId);
    backup = impact.backup;
    const oldVersionId = impact.versionId;
    const integrations = impact.backup.integrations;

    // 1) Delete every dependent integration instance first - if any of
    // these fail, stop here without touching the model at all.
    for (const integration of integrations) {
      const name = integration.name;
      try {
        // eslint-disable-next-line no-await-in-loop
        await platformRequest(`/integrations/${encodeURIComponent(name)}`, { method: 'DELETE' });
        recordStep(`Delete integration "${name}"`, true);
      } catch (err) {
        recordStep(`Delete integration "${name}"`, false, err.message);
        return { success: false, steps, errors: [err.message], backup };
      }
    }

    // 2) Delete the model itself.
    try {
      await platformRequest(`/integration-models/${encodeURIComponent(oldVersionId)}`, { method: 'DELETE' });
      recordStep(`Delete integration model "${oldVersionId}"`, true);
    } catch (err) {
      recordStep(`Delete integration model "${oldVersionId}"`, false, err.message);
      return { success: false, steps, errors: [err.message], backup };
    }

    // 3) Reapply (re-create) the model with the edited spec.
    const newVersionId = `${spec.info && spec.info.title}:${spec.info && spec.info.version}`;
    try {
      await platformRequest('/integration-models', {
        method: 'POST',
        body: JSON.stringify({ model: spec }),
      });
      recordStep(`Create integration model "${newVersionId}"`, true);
    } catch (err) {
      recordStep(`Create integration model "${newVersionId}"`, false, err.message);
      return { success: false, steps, errors: [err.message], backup };
    }

    // 4) Recreate every previously-deleted instance against the NEW model
    // identifier - every instance is attempted even if one fails, since the
    // backup above already has everything needed to retry/recreate by hand.
    const newModel = deriveModelIdentifier(newVersionId);
    const errors = [];
    for (const integration of integrations) {
      const payload = {
        ...integration,
        model: newModel,
        properties: { ...integration.properties, type: newVersionId },
      };
      delete payload._id;
      try {
        // eslint-disable-next-line no-await-in-loop
        await platformRequest('/integrations', { method: 'POST', body: JSON.stringify(payload) });
        recordStep(`Recreate integration "${integration.name}"`, true);
      } catch (err) {
        recordStep(`Recreate integration "${integration.name}"`, false, err.message);
        errors.push(err.message);
      }
    }

    return { success: errors.length === 0, steps, versionId: newVersionId, errors, backup };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[openapi-editor] Direct Platform API saveModel failed:', err.message);
    return { success: false, steps, errors: [err.message], backup };
  }
}

// Executes an ad hoc HTTP call against a real target server from the cog
// process (not the browser) - see the Test panel / src.js#testRequest for
// why this is how "testing the spec" avoids browser CORS restrictions.
export const testRequest = (config) => request('/test-request', {
  method: 'POST',
  body: JSON.stringify({ config }),
});
