// Thin wrapper around the cog's REST routes. Base path matches the app's
// title in pronghorn.json ("health-monitor"), so in production these calls
// resolve to <host>:<port>/health-monitor/... automatically.
const BASE = '/health-monitor';

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

export const listTargets = () => request('/targets');

// Lists the operations an Integration's own OpenAPI model defines, for the
// Add/Edit Check form's operation picker - see src.js#getIntegrationOperations.
// Not meaningful for adapters/apps yet; comes back with an empty
// operations array for those rather than an error.
export const getIntegrationOperations = (serviceName) => request(`/targets/${encodeURIComponent(serviceName)}/operations`);

export const listChecks = () => request('/checks');

export const getCheck = (checkId) => request(`/checks/${checkId}`);

export const createCheck = (config) => request('/checks', {
  method: 'POST',
  body: JSON.stringify({ config }),
});

export const updateCheck = (checkId, config) => request(`/checks/${checkId}`, {
  method: 'PUT',
  body: JSON.stringify({ config }),
});

export const deleteCheck = (checkId) => request(`/checks/${checkId}`, {
  method: 'DELETE',
});

export const runCheckNow = (checkId) => request(`/checks/${checkId}/run`, {
  method: 'POST',
});

// Restarts the adapter/app a check targets (stop then start) - not offered
// for Integration targets, which have no separate running process of their
// own to restart. See src.js#restartTarget for the underlying platform API
// calls and auth caveats.
export const restartTarget = (checkId) => request(`/checks/${checkId}/restart`, {
  method: 'POST',
});
