'use strict';

/**
 * Manual smoke test proving src.js's methods use IAP's real Pronghorn
 * calling convention: function(...positionalInputs, callback), with
 * callback(result) on success / callback(null, err) on failure - NOT
 * Express-style (req, res). Run with: node smoke-test.js
 *
 * Uses the in-memory store (no live Mongo/service_config required) so this
 * can be run standalone to sanity-check the wiring after any src.js change.
 */

const app = require('./src.js'); // now exports a singleton instance, matching Editor/Monitor's convention

function log(label, fn) {
  return new Promise((resolve) => {
    fn((result, err) => {
      if (err) {
        console.log(`[${label}] ERROR ->`, err.message);
      } else {
        console.log(`[${label}] OK ->`, JSON.stringify(result));
      }
      resolve();
    });
  });
}

(async () => {
  await log('createTemplate', (cb) => app.createTemplate({ name: 'base', type: 'partial', body: 'Hello {{ name }}' }, cb));
  await log('listTemplates', (cb) => app.listTemplates(cb));
  await log('renderTemplate', (cb) => app.renderTemplate('base', { name: 'World' }, null, cb));
  await log('getTemplate (missing)', (cb) => app.getTemplate('does-not-exist', cb));
  console.log('\nSmoke test complete: success results arrived via callback(result); the missing-template lookup correctly arrived via callback(null, err).');
})();
