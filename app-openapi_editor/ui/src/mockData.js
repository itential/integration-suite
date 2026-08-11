// Used only when the app can't reach a live IAP backend (e.g. when running
// `npm start` for pure UI development, or previewing this app outside of
// IAP). Mirrors the real integration_models document shape.
export const MOCK_MODELS = [
  { id: '696136ca5c77fa09a2e0be4e', title: 'MockServer API', version: '1.0.0', versionId: 'MockServer API:1.0.0' },
  { id: '696136ca5c77fa09a2e0be5f', title: 'Device Inventory API', version: '2.1.0', versionId: 'Device Inventory API:2.1.0' },
  { id: '696136ca5c77fa09a2e0be70', title: 'ServiceNow CMDB', version: '1.3.2', versionId: 'ServiceNow CMDB:1.3.2' },
];

// Matches what getModel() now returns for a real model: meta (Itential/Mongo
// bookkeeping - not part of the OpenAPI spec) kept separate from the pure
// OpenAPI document below.
export const MOCK_META = {
  id: '696136ca5c77fa09a2e0be4e',
  versionId: 'MockServer API:1.0.0',
};

export const MOCK_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'MockServer API',
    description: 'Simple mock API no authentication.',
    version: '1.0.0',
  },
  servers: [{ url: 'http://192.168.0.181:8000', description: 'MOCKAPISERVER' }],
  paths: {
    '/MOCKPOST': {
      post: {
        summary: 'Mock POST endpoint',
        description: 'Returns a static message for a POST request.',
        responses: {
          200: {
            description: 'Success response for POST',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string', example: 'POST_MOCK_MESSAGE' } },
                },
              },
            },
          },
        },
      },
    },
    '/MOCKGET': {
      get: {
        summary: 'Mock GET endpoint',
        description: 'Returns a static message for a GET request.',
        responses: {
          200: {
            description: 'Success response for GET',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { message: { type: 'string', example: 'GET_MOCK_MESSAGE' } },
                },
              },
            },
          },
        },
      },
    },
    '/MOCKGETWITHPARAMETER/{param}': {
      get: {
        summary: 'Mock GET with path parameter',
        description: 'Returns a static message with a parameter included in the path.',
        parameters: [
          {
            name: 'param', in: 'path', required: true, schema: { type: 'string' }, description: 'A parameter included in the path',
          },
        ],
        responses: { 200: { description: 'Success response for parameterized GET' } },
      },
    },
  },
  components: {
    schemas: {
      NameField: {
        type: 'object',
        properties: { name: { type: 'string', example: 'smith' } },
        required: ['name'],
      },
      FirstNamesField: {
        type: 'object',
        properties: { firstnames: { type: 'array', items: { type: 'string' } } },
        required: ['firstnames'],
      },
    },
  },
};
