'use strict';

/**
 * The vetted catalog of custom filter/test/global implementations available
 * to the registry (see src.js's createRegistryEntry / pronghorn.json). This
 * is intentionally the ONLY way a registry entry can get real behavior:
 * there is no free-form eval/Function-constructor path anywhere in this app,
 * because rendering runs in the same Node process as the rest of the
 * platform - arbitrary template-author-supplied code would be a real
 * privilege-escalation risk, not just a template author "shooting themselves
 * in the foot." Extending capability means adding a new named entry here
 * (a real code review), not exposing an eval box in the UI.
 *
 * Each catalog entry has: kind ('filter'|'test'|'global'), a human label,
 * and `fn`. Filters/globals are plain functions; tests must return a
 * boolean.
 */
const CATALOG = {
  // --- filters ---
  ipv4_network: {
    kind: 'filter',
    label: 'ipv4_network(value, prefixLen) - e.g. "10.0.0.5" | ipv4_network(24) -> "10.0.0.0/24"',
    fn: (value, prefixLen) => {
      const parts = String(value).split('.').map(Number);
      if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return value;
      const bits = parts.reduce((acc, octet) => (acc << 8) | octet, 0) >>> 0;
      const mask = prefixLen >= 32 ? 0xffffffff : (~(2 ** (32 - prefixLen) - 1)) >>> 0;
      const net = (bits & mask) >>> 0;
      const octets = [24, 16, 8, 0].map((shift) => (net >>> shift) & 0xff);
      return `${octets.join('.')}/${prefixLen}`;
    },
  },
  vlan_range_expand: {
    kind: 'filter',
    label: 'vlan_range_expand(value) - "10,20-22" -> [10,20,21,22]',
    fn: (value) => {
      const out = [];
      String(value).split(',').forEach((part) => {
        const trimmed = part.trim();
        const range = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
        if (range) {
          const start = parseInt(range[1], 10);
          const end = parseInt(range[2], 10);
          for (let i = start; i <= end; i += 1) out.push(i);
        } else if (trimmed) {
          out.push(parseInt(trimmed, 10));
        }
      });
      return out;
    },
  },
  to_snake_case: {
    kind: 'filter',
    label: 'to_snake_case(value) - "MyVlanName" -> "my_vlan_name"',
    fn: (value) => String(value)
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase(),
  },
  indent_lines: {
    kind: 'filter',
    label: 'indent_lines(value, spaces=2) - indents every line of a multi-line string, useful for nested config blocks',
    fn: (value, spaces) => {
      const pad = ' '.repeat(typeof spaces === 'number' ? spaces : 2);
      return String(value).split('\n').map((line) => (line ? pad + line : line)).join('\n');
    },
  },
  // --- tests ---
  is_valid_ipv4: {
    kind: 'test',
    label: 'value is is_valid_ipv4 - true if value looks like a dotted-quad IPv4 address',
    fn: (value) => /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value))
      && String(value).split('.').every((o) => Number(o) >= 0 && Number(o) <= 255),
  },
  is_even_vlan: {
    kind: 'test',
    label: 'value is is_even_vlan - true if value is an even integer VLAN id',
    fn: (value) => Number.isInteger(Number(value)) && Number(value) % 2 === 0,
  },
  // --- globals ---
  now_iso: {
    kind: 'global',
    label: 'now_iso() - current timestamp as an ISO string, useful for config-generation banners',
    fn: () => new Date().toISOString(),
  },
  range_list: {
    kind: 'global',
    label: 'range_list(start, end) - inclusive integer list, e.g. range_list(1, 5) -> [1,2,3,4,5]',
    fn: (start, end) => {
      const out = [];
      for (let i = start; i <= end; i += 1) out.push(i);
      return out;
    },
  },
};

function listCatalog() {
  return Object.keys(CATALOG).map((key) => ({
    key,
    kind: CATALOG[key].kind,
    label: CATALOG[key].label,
  }));
}

function getCatalogEntry(key) {
  return CATALOG[key] || null;
}

/**
 * Applies every given registry entry (as stored in Mongo: { name, kind,
 * catalogKey }) onto a nunjucks Environment, using the entry's own `name` as
 * the filter/test/global name exposed to template authors (which may differ
 * from the catalog key - e.g. an author can register the `to_snake_case`
 * catalog implementation under the name `snake_case` if they prefer).
 */
function applyRegistryEntries(env, entries) {
  (entries || []).forEach((entry) => {
    const catalogEntry = getCatalogEntry(entry.catalogKey);
    if (!catalogEntry || catalogEntry.kind !== entry.kind) return;
    if (entry.kind === 'filter') env.addFilter(entry.name, catalogEntry.fn);
    else if (entry.kind === 'test') env.addTest(entry.name, catalogEntry.fn);
    else if (entry.kind === 'global') env.addGlobal(entry.name, catalogEntry.fn);
  });
}

module.exports = { CATALOG, listCatalog, getCatalogEntry, applyRegistryEntries };
