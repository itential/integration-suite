'use strict';

const { parseName, resolveBody } = require('./nunjucksLoader');

// {% block name %} ... {% endblock %} (name only needed here, not the body)
const BLOCK_RE = /{%-?\s*block\s+([A-Za-z0-9_]+)/g;
// {% extends "x" %} - only ever one per template, used to walk the chain
const EXTENDS_RE = /{%-?\s*extends\s+["']([^"']+)["']/;
// {% macro name(args) %} - captures the raw argument-list text
const MACRO_RE = /{%-?\s*macro\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;

/**
 * Extracts {% block %} names from a single template body (does not walk the
 * extends chain - callers combine per-level results themselves so each
 * block can be tagged with which template in the chain defined it).
 */
function extractBlockNames(body) {
  const names = [];
  if (!body) return names;
  let m;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(body)) !== null) {
    names.push(m[1]);
  }
  return names;
}

/**
 * Parses a `{% macro name(a, b=1, **kwargs) %}` argument list into a
 * lightweight signature description via string splitting rather than a real
 * AST (Jinja2/nunjucks doesn't expose one cheaply from JS) - good enough for
 * "what does this macro expect," not a full expression parser, so unusual
 * default-value expressions containing commas (e.g. a dict literal default)
 * may split incorrectly. Flagged in the README as a known limitation.
 */
function parseMacroArgs(rawArgs) {
  const trimmed = (rawArgs || '').trim();
  if (!trimmed) return { args: [], hasKwargs: false };
  const hasKwargs = /\*\*\s*kwargs\s*$/.test(trimmed);
  const withoutKwargs = trimmed.replace(/,?\s*\*\*\s*kwargs\s*$/, '');
  const args = withoutKwargs.split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return { name: part, default: null };
    return { name: part.slice(0, eq).trim(), default: part.slice(eq + 1).trim() };
  });
  return { args, hasKwargs };
}

/** Extracts `{% macro %}` signatures from a single template body. */
function extractMacros(body) {
  const macros = [];
  if (!body) return macros;
  let m;
  MACRO_RE.lastIndex = 0;
  while ((m = MACRO_RE.exec(body)) !== null) {
    const { args, hasKwargs } = parseMacroArgs(m[2]);
    macros.push({ name: m[1], args, hasKwargs });
  }
  return macros;
}

/**
 * Walks the `extends` chain (child -> parent -> grandparent ...) up to a
 * safety limit, returning the ordered list of { name, body } levels, and
 * building the block outline: every block name seen anywhere in the chain,
 * tagged with which level first defines it and whether a more-specific
 * (closer to the starting template) level overrides it.
 */
async function buildOutline(store, startName) {
  const levels = [];
  let currentName = startName;
  const seen = new Set();
  const MAX_DEPTH = 25;

  while (currentName && levels.length < MAX_DEPTH) {
    const { baseName, version } = parseName(currentName);
    if (seen.has(baseName)) break; // let the real render-time cycle check report this properly
    seen.add(baseName);
    // eslint-disable-next-line no-await-in-loop
    const doc = await store.findByName(baseName);
    if (!doc) break;
    const body = resolveBody(doc, version);
    levels.push({ name: baseName, body });
    const extendsMatch = EXTENDS_RE.exec(body || '');
    currentName = extendsMatch ? extendsMatch[1] : null;
  }

  // Walk root-to-leaf (reverse of the child-to-parent `levels` order) so the
  // FIRST time a block name is seen is credited to the ancestor that
  // actually originated it, and every subsequent (more-specific, closer to
  // the starting template) occurrence is recorded as an override of it -
  // not the other way around.
  const blockOccurrences = [];
  levels.slice().reverse().forEach((level) => {
    extractBlockNames(level.body).forEach((name) => {
      blockOccurrences.push({ name, definedIn: level.name });
    });
  });

  const blocksByName = new Map();
  blockOccurrences.forEach((occ) => {
    if (!blocksByName.has(occ.name)) {
      blocksByName.set(occ.name, { name: occ.name, definedIn: occ.definedIn, overriddenBy: [] });
    } else {
      blocksByName.get(occ.name).overriddenBy.push(occ.definedIn);
    }
  });

  const blocks = Array.from(blocksByName.values()).map((b) => ({
    name: b.name,
    definedIn: b.definedIn,
    overridden: b.overriddenBy.length > 0,
    overriddenBy: b.overriddenBy,
  }));

  const macros = levels.length ? extractMacros(levels[0].body) : [];

  return { chain: levels.map((l) => l.name), blocks, macros };
}

module.exports = { extractBlockNames, extractMacros, parseMacroArgs, buildOutline };
