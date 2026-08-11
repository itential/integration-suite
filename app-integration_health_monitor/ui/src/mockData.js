// Used only when the app can't reach a live IAP backend (e.g. when running
// `npm start` for pure UI development, or previewing this app outside of
// IAP). Mirrors the real health_checks document shape returned by the cog.
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

export const MOCK_TARGETS = [
  { name: 'slack-adapter', type: 'Adapter' },
  { name: 'meraki-adapter', type: 'Adapter' },
  { name: 'servicenow-integration', type: 'Integration' },
  { name: 'openapi-editor', type: 'Application' },
];

export const MOCK_CHECKS = [
  {
    id: 'mock-1',
    name: 'Slack Adapter - Ping',
    targetType: 'adapter',
    serviceName: 'slack-adapter',
    method: 'GET',
    path: '/offlinePing',
    intervalSeconds: 300,
    timeoutMs: 5000,
    enabled: true,
    status: {
      state: 'healthy', lastCheckedAt: minutesAgo(2), lastResponseTimeMs: 84, lastStatusCode: 200, lastError: null,
    },
  },
  {
    id: 'mock-2',
    name: 'ServiceNow Integration - Get Incident',
    targetType: 'integration',
    serviceName: 'servicenow-integration',
    method: 'GET',
    path: '/api/now/table/incident?sysparm_limit=1',
    intervalSeconds: 600,
    timeoutMs: 8000,
    enabled: true,
    status: {
      state: 'unhealthy', lastCheckedAt: minutesAgo(6), lastResponseTimeMs: 8001, lastStatusCode: null, lastError: 'timeout of 8000ms exceeded',
    },
  },
  {
    id: 'mock-3',
    name: 'Meraki Adapter - Get Organizations',
    targetType: 'adapter',
    serviceName: 'meraki-adapter',
    method: 'GET',
    path: '/organizations',
    intervalSeconds: 900,
    timeoutMs: 5000,
    enabled: false,
    status: {
      state: 'unknown', lastCheckedAt: null, lastResponseTimeMs: null, lastStatusCode: null, lastError: null,
    },
  },
];
