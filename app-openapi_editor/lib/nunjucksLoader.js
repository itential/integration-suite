'use strict';

const nunjucks = require('nunjucks');
const { applyRegistryEntries } = require('./registryCatalog');

/**
 * Parses "name@version" syntax used for pinning a specific saved version of
 * a template. If no "@vN" suffix is present, resolves to the latest body.
 *
 *   "base"        -> { baseName: "base", version: null }
 *   "base@v2"     -> { baseName: "base", version: 2 }
 *   "team/lib@v1" -> { baseName: "team/lib", version: 1 }
 */
function parseName(name) {
  const match = /^(.*)@v(\d+)$/.exec(name);
  if (match) {
    return { baseName: match[1], version: parseInt(match[2], 10) };
  }
  return { baseName: name, version: null };
}

/**
 * Resolves the source body for a template doc, honoring an optional pinned
 * version. Falls back to the current `body` field (latest) when no version
 * is requested or the requested version cannot be found.
 */
function resolveBody(doc, version) {
  if (version != null && Array.isArray(doc.versions)) {
    const match = doc.versions.find((v) => v.version === version);
    if (match) return match.body;
  }
  return doc.body;
}

// Matches {% extends "x" %}, {% include 'x' %}, {% import "x" as y %},
// {% from "x" import y %} - single or double quoted names.
const REFERENCE_TAG_RE = /{%-?\s*(extends|include|import|from)\s+["']([^"']+)["']/g;

/** Extracts the raw referenced names (still possibly "name@vN") from a body. */
function extractReferences(body) {
  const names = [];
  if (!body) return names;
  let m;
  REFERENCE_TAG_RE.lastIndex = 0;
  while ((m = REFERENCE_TAG_RE.exec(body)) !== null) {
    names.push(m[2]);
  }
  return names;
}

/**
 * Pre-flight cycle check: performs a DFS across the extends/include/import
 * graph (resolved by name against the store) starting at `startName`, and
 * throws a clear "circular reference: A -> B -> A" style error if a name
 * reappears on the current path. Doing this as an explicit pre-pass (rather
 * than relying on nunjucks' internal, loosely-specified getSource call
 * ordering) means legitimate diamond dependencies - e.g. a partial included
 * by two different templates in the same render - are never mistaken for a
 * cycle, since we only flag a repeat when it is on the *current DFS path*,
 * not merely visited anywhere in the graph.
 */
async function checkForCycles(store, startName) {
  const startBase = parseName(startName).baseName;

  async function visit(baseName, path) {
    if (path.includes(baseName)) {
      const chainDescription = path.concat([baseName]).join(' -> ');
      throw new Error(`circular reference: ${chainDescription}`);
    }
    const doc = await store.findByName(baseName);
    if (!doc) {
      // Missing templates are reported at actual render time by the loader;
      // the cycle pre-check only cares about graph structure it can see.
      return;
    }
    const nextPath = path.concat([baseName]);
    const refs = extractReferences(doc.body);
    for (const ref of refs) {
      const refBase = parseName(ref).baseName;
      await visit(refBase, nextPath);
    }
  }

  await visit(startBase, []);
}

/**
 * Custom Nunjucks Loader backed by a pluggable template store (anything that
 * implements an async `findByName(name)` method - see lib/mongoStore.js).
 *
 * Nunjucks loaders are synchronous by default unless `async = true` is set,
 * in which case `getSource(name, callback)` must call back asynchronously,
 * which is what this loader does since the store is Promise-based (Mongo
 * I/O in production, in-memory Map lookups in tests/dev).
 */
class StoreLoader extends nunjucks.Loader {
  constructor(store) {
    super();
    this.store = store;
    this.async = true;
  }

  getSource(name, callback) {
    const { baseName, version } = parseName(name);

    this.store
      .findByName(baseName)
      .then((doc) => {
        if (!doc) {
          callback(new Error(`template not found in store: "${baseName}"`));
          return;
        }
        const src = resolveBody(doc, version);
        callback(null, {
          src,
          path: baseName,
          noCache: true
        });
      })
      .catch((err) => callback(err));
  }
}

/**
 * Builds a real nunjucks.Environment wired to the given store, with the
 * per-template `environment` options (trimBlocks/lstripBlocks/autoescape)
 * applied. Extensions listed in doc.environment.extensions are expected to
 * be nunjucks extension instances registered by the caller if needed; this
 * scaffold wires the flags but leaves custom extension registration to
 * calling code since extensions are arbitrary user-supplied classes.
 */
function createEnvironment(store, options, registryEntries) {
  const opts = options || {};
  const loader = new StoreLoader(store);
  const env = new nunjucks.Environment(loader, {
    autoescape: !!opts.autoescape,
    trimBlocks: !!opts.trimBlocks,
    lstripBlocks: !!opts.lstripBlocks
  });
  // The vetted filter/test/global registry (see lib/registryCatalog.js) is
  // the ONLY extension point beyond nunjucks' own built-ins - there is no
  // free-form eval anywhere in this app, since rendering runs in-process
  // with the rest of the platform.
  applyRegistryEntries(env, registryEntries);
  return { env, loader };
}

/**
 * Nunjucks formats render errors as a message string like:
 *   "Template render error: (base@v2) [Line 4, Column 3]\n  unknown block tag: endif"
 * This pulls the template name and line/column back out so error surfacing
 * can point at the specific template in the chain that raised, not just a
 * generic "render failed" - important once a render walks a multi-level
 * extends/include/import chain and the failure could be several levels deep.
 */
function describeRenderError(err) {
  const message = (err && err.message) || String(err);
  const match = /\(([^)]+)\)\s*\[Line (\d+), Column (\d+)\]\s*\n?\s*(.*)$/s.exec(message);
  if (match) {
    return {
      template: match[1],
      line: parseInt(match[2], 10),
      column: parseInt(match[3], 10),
      detail: match[4] || message,
      message,
    };
  }
  return { template: null, line: null, column: null, detail: message, message };
}

/**
 * Renders `name` (optionally "name@vN") against the store, doing full-chain
 * resolution of extends/include/import. Runs a pre-flight cycle check first
 * so a cyclic extends/include/import chain fails fast with a clear
 * "circular reference: A -> B -> A" error instead of stack-overflowing or
 * hanging inside nunjucks' own recursive resolution.
 */
async function render(store, name, context, envOptions, registryEntries) {
  await checkForCycles(store, name);
  const { env } = createEnvironment(store, envOptions, registryEntries);
  return new Promise((resolve, reject) => {
    env.render(name, context || {}, (err, res) => {
      if (err) {
        reject(Object.assign(err, { renderErrorDetail: describeRenderError(err) }));
        return;
      }
      resolve(res);
    });
  });
}

module.exports = {
  StoreLoader,
  createEnvironment,
  render,
  parseName,
  resolveBody,
  extractReferences,
  checkForCycles,
  describeRenderError
};
