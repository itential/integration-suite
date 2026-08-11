import React, { useEffect, useMemo, useState } from 'react';
import * as api from '../api';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const METHODS_WITH_BODY = ['post', 'put', 'patch'];
const EMPTY_OAUTH = { tokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '' };
const EMPTY_LOGIN = {
  url: '', method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '',
  tokenPath: '', applyAs: 'header', headerName: 'Authorization', prefix: 'Bearer ', queryParam: 'token',
};

/**
 * Groups every operation in the spec by its first tag (falling back to
 * "untagged"), mirroring how swagger-ui-react's own Preview pane groups
 * operations into collapsible categories - this list is meant to feel like
 * a checkbox-and-test-enabled version of that same view, not a different
 * structure. Keeps the raw operation object too (parameters/responses),
 * unlike the original Cleanup-only version of this helper, since this tab
 * also shows per-operation detail and drives the test form.
 */
function groupOperations(spec) {
  const groups = [];
  const byTag = {};
  if (!spec || !spec.paths) return groups;

  Object.keys(spec.paths).forEach((path) => {
    const pathItem = spec.paths[path] || {};
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      const tag = (op.tags && op.tags[0]) || 'untagged';
      if (!byTag[tag]) {
        byTag[tag] = { tag, operations: [] };
        groups.push(byTag[tag]);
      }
      byTag[tag].operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary || op.operationId || '',
        parameters: op.parameters || [],
        responses: op.responses || {},
        // Whether this operation is marked as the one Health Monitor should
        // default to when it looks up this model to build a check against
        // it - see setDefaultOperation below. A plain vendor extension
        // field, so it round-trips through Save/Mongo like any other part
        // of the spec, and is invisible to anything that doesn't know to
        // look for it.
        isDefault: !!op['x-health-monitor-default'],
      });
    });
  });

  return groups;
}

/**
 * Removes the selected operations from a spec (by "METHOD path" key),
 * then prunes any path entry left with no HTTP methods at all, and any
 * top-level spec.tags entry no longer referenced by a remaining operation.
 * Returns a new spec object - does not mutate the input.
 */
export function applyRemovals(spec, removedKeys) {
  const next = JSON.parse(JSON.stringify(spec));
  const removedSet = new Set(removedKeys);
  const stillUsedTags = new Set();

  Object.keys(next.paths || {}).forEach((path) => {
    const pathItem = next.paths[path];
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      if (removedSet.has(`${method.toUpperCase()} ${path}`)) {
        delete pathItem[method];
      } else if (op.tags && op.tags[0]) {
        stillUsedTags.add(op.tags[0]);
      }
    });
    const hasAnyMethod = HTTP_METHODS.some((m) => pathItem[m]);
    if (!hasAnyMethod) delete next.paths[path];
  });

  if (Array.isArray(next.tags)) {
    next.tags = next.tags.filter((t) => stillUsedTags.has(t.name));
  }

  return next;
}

/**
 * Marks exactly one operation in the spec as the default health-check call
 * (x-health-monitor-default: true) - clearing the flag from every other
 * operation first, so there's only ever one active default per model.
 * Passing null/undefined for key just clears the flag everywhere (unmark).
 * This is a plain OpenAPI vendor extension field (the "x-" prefix is
 * reserved by the spec for exactly this kind of custom metadata), so it
 * persists through Save/Mongo like any other part of the document and
 * doesn't require any schema change - app-integration_health_monitor reads
 * it back out when building an Integration check's operation picker.
 */
export function setDefaultOperation(spec, key) {
  const next = JSON.parse(JSON.stringify(spec));
  Object.keys(next.paths || {}).forEach((path) => {
    const pathItem = next.paths[path];
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      const opKey = `${method.toUpperCase()} ${path}`;
      if (key && opKey === key) {
        op['x-health-monitor-default'] = true;
      } else if (op['x-health-monitor-default'] !== undefined) {
        delete op['x-health-monitor-default'];
      }
    });
  });
  return next;
}

function fillPathParams(pathTemplate, pathParams) {
  return pathTemplate.replace(/\{([^}]+)\}/g, (match, name) => {
    const value = pathParams[name];
    return value !== undefined && value !== '' ? encodeURIComponent(value) : match;
  });
}

function extractPathParamNames(pathTemplate) {
  const names = [];
  pathTemplate.replace(/\{([^}]+)\}/g, (match, name) => {
    names.push(name);
    return match;
  });
  return names;
}

// Repeatable key/value list editor, shared by custom headers and the login
// sub-request's own headers.
function KeyValueList({ rows, onChange, keyPlaceholder, valuePlaceholder }) {
  const update = (idx, field, value) => {
    const next = rows.slice();
    next[idx] = { ...next[idx], [field]: value };
    onChange(next);
  };
  const remove = (idx) => onChange(rows.filter((_, i) => i !== idx));
  const add = () => onChange([...rows, { key: '', value: '' }]);

  return (
    <div className="kv-list">
      {rows.map((row, idx) => (
        // eslint-disable-next-line react/no-array-index-key
        <div className="kv-row" key={idx}>
          <input type="text" placeholder={keyPlaceholder || 'Header name'} value={row.key} onChange={(e) => update(idx, 'key', e.target.value)} />
          <input type="text" placeholder={valuePlaceholder || 'Value'} value={row.value} onChange={(e) => update(idx, 'value', e.target.value)} />
          <button type="button" className="btn btn-tiny btn-tiny-danger" onClick={() => remove(idx)}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn-tiny btn-tiny-secondary kv-add-btn" onClick={add}>+ Add header</button>
    </div>
  );
}

// One operation row: removal checkbox, method/path/summary, an expand
// toggle that reveals parameter/response details AND a full test-and-send
// form using the shared auth/headers/login settings passed down from
// Operations. Each row keeps its OWN path-param/query/body/result state,
// since those are naturally per-operation - only auth/headers/server are
// shared across the whole tab.
function OperationRow({
  op, checked, onToggleChecked, expanded, onToggleExpanded, sharedSettings, onSetDefault,
}) {
  const [pathParams, setPathParams] = useState({});
  const [queryParams, setQueryParams] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const pathParamNames = extractPathParamNames(op.path);
  const showBody = METHODS_WITH_BODY.includes(op.method);
  const updatePathParam = (name, value) => setPathParams((prev) => ({ ...prev, [name]: value }));

  const responseEntries = Object.entries(op.responses || {});

  const handleSend = async () => {
    setSending(true);
    setResult(null);
    try {
      const base = String(sharedSettings.server || '').replace(/\/+$/, '');
      const filledPath = fillPathParams(op.path, pathParams);
      let query = '';
      if (queryParams.trim()) {
        try {
          const parsed = JSON.parse(queryParams);
          const usp = new URLSearchParams();
          Object.keys(parsed).forEach((k) => usp.set(k, parsed[k]));
          query = `?${usp.toString()}`;
        } catch (err) {
          setResult({ error: `Query params must be valid JSON: ${err.message}` });
          setSending(false);
          return;
        }
      }
      const url = `${base}${filledPath}${query}`;

      let parsedBody;
      if (showBody && body.trim()) {
        try {
          parsedBody = JSON.stringify(JSON.parse(body));
        } catch (err) {
          setResult({ error: `Request body must be valid JSON: ${err.message}` });
          setSending(false);
          return;
        }
      }

      const headers = {
        ...(parsedBody ? { 'Content-Type': 'application/json' } : {}),
        ...sharedSettings.flattenedHeaders,
      };

      const config = {
        url,
        method: op.method.toUpperCase(),
        headers,
        body: parsedBody,
        authMode: sharedSettings.authMode,
        authUsername: sharedSettings.authUsername,
        authPassword: sharedSettings.authPassword,
        authToken: sharedSettings.authToken,
        oauth: sharedSettings.oauth,
        login: sharedSettings.login,
        useCurl: sharedSettings.useCurl,
        insecureTLS: sharedSettings.insecureTLS,
      };

      const response = await api.testRequest(config);
      setResult(response);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="op-row-wrap">
      <div className="op-row-summary">
        <input type="checkbox" checked={checked} onChange={onToggleChecked} title="Select for removal" />
        <button
          type="button"
          className={`op-default-star ${op.isDefault ? 'is-default' : ''}`}
          onClick={() => onSetDefault(op.isDefault ? null : op.key)}
          title={op.isDefault
            ? 'This is the default health-check call for this model - click to unmark'
            : 'Mark as the default health-check call Health Monitor should use for this model'}
        >
          {op.isDefault ? '★' : '☆'}
        </button>
        <button type="button" className="op-row-expand-btn" onClick={onToggleExpanded} aria-expanded={expanded}>
          <span className={`cleanup-group-caret ${expanded ? '' : 'collapsed'}`}>▾</span>
          <span className={`method-badge method-${op.method}`}>{op.method}</span>
          <span className="cleanup-op-path">{op.path}</span>
          {op.summary && <span className="cleanup-op-summary">{op.summary}</span>}
          {op.isDefault && <span className="op-default-badge">Default health check</span>}
        </button>
      </div>

      {expanded && (
        <div className="op-row-detail">
          {(op.parameters.length > 0) && (
            <div className="op-detail-block">
              <div className="op-detail-title">Parameters</div>
              <table className="param-table">
                <thead>
                  <tr><th>Name</th><th>In</th><th>Required</th><th>Description</th></tr>
                </thead>
                <tbody>
                  {op.parameters.map((p) => (
                    <tr key={`${p.name}-${p.in}`}>
                      <td>{p.name}</td>
                      <td>{p.in}</td>
                      <td>{p.required ? 'Yes' : 'No'}</td>
                      <td>{p.description || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {responseEntries.length > 0 && (
            <div className="op-detail-block">
              <div className="op-detail-title">Responses</div>
              <ul className="response-list">
                {responseEntries.map(([code, def]) => (
                  <li key={code}>
                    <span className={`status-code ${code.startsWith('2') ? 'status-2xx' : (code.startsWith('4') ? 'status-4xx' : 'status-5xx')}`}>{code}</span>
                    <span>{(def && def.description) || ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="op-detail-title">Test this operation</div>
          {pathParamNames.length > 0 && (
            <div className="test-field-row test-path-params">
              <label>Path parameters</label>
              {pathParamNames.map((name) => (
                <div key={name} className="test-path-param">
                  <span>{name}</span>
                  <input type="text" value={pathParams[name] || ''} onChange={(e) => updatePathParam(name, e.target.value)} />
                </div>
              ))}
            </div>
          )}
          <div className="test-field-row">
            <label>Query params (JSON object, optional)</label>
            <textarea rows={2} value={queryParams} onChange={(e) => setQueryParams(e.target.value)} placeholder='{ "limit": 10 }' />
          </div>
          {showBody && (
            <div className="test-field-row">
              <label>Request body (JSON, optional)</label>
              <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="{ ... }" />
            </div>
          )}
          <button type="button" className="btn btn-primary test-send-btn" onClick={handleSend} disabled={sending}>
            {sending ? 'Sending…' : 'Send test request'}
          </button>

          {result && (
            <div className="test-result">
              {result.error && <div className="status-banner status-error">{result.error}</div>}
              {!result.error && (
                <>
                  <div className="test-result-summary">
                    <span className={`status-code ${result.status >= 200 && result.status < 300 ? 'status-2xx' : (result.status >= 400 && result.status < 500 ? 'status-4xx' : 'status-5xx')}`}>
                      {result.status || '—'}
                    </span>
                    <span className="test-result-time">{result.timeMs != null ? `${result.timeMs} ms` : ''}</span>
                  </div>
                  <pre className="test-result-body">{
                    (() => {
                      try {
                        const parsed = typeof result.data === 'string' ? JSON.parse(result.data) : result.data;
                        return JSON.stringify(parsed, null, 2);
                      } catch (err) {
                        return String(result.data);
                      }
                    })()
                  }</pre>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Operations({
  spec, onApply, onSetDefault, disabled,
}) {
  const groups = useMemo(() => groupOperations(spec), [spec]);
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [selected, setSelected] = useState(() => new Set());
  const [expandedOps, setExpandedOps] = useState(() => new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [server, setServer] = useState('');
  const [customHeaders, setCustomHeaders] = useState([]);
  const [authMode, setAuthMode] = useState('none');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [oauth, setOauth] = useState(EMPTY_OAUTH);
  const [login, setLogin] = useState(EMPTY_LOGIN);
  const [useCurl, setUseCurl] = useState(false);
  const [insecureTLS, setInsecureTLS] = useState(false);

  // Clear per-tab selection state whenever the spec's own shape changes
  // (switching models, or a previous Apply already ran) - stale keys from a
  // spec that no longer exists would otherwise silently do nothing.
  useEffect(() => {
    setSelected(new Set());
  }, [spec]);

  useEffect(() => {
    if (spec && spec.servers && spec.servers.length && !server) {
      setServer(spec.servers[0].url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  const updateOauth = (field, value) => setOauth((prev) => ({ ...prev, [field]: value }));
  const updateLogin = (field, value) => setLogin((prev) => ({ ...prev, [field]: value }));
  const flattenHeaders = (rows) => rows.reduce((acc, row) => {
    if (row.key) acc[row.key] = row.value;
    return acc;
  }, {});

  const sharedSettings = {
    server,
    flattenedHeaders: flattenHeaders(customHeaders),
    authMode,
    authUsername,
    authPassword,
    authToken,
    oauth,
    login,
    useCurl,
    insecureTLS,
  };

  if (!spec) {
    return <div className="preview-pane"><div className="preview-empty">Select a model to view its operations</div></div>;
  }

  const q = search.trim().toLowerCase();
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      operations: q
        ? group.operations.filter((op) => (
          op.key.toLowerCase().includes(q)
          || op.summary.toLowerCase().includes(q)
          || op.path.toLowerCase().includes(q)
          || group.tag.toLowerCase().includes(q)
        ))
        : group.operations,
    }))
    .filter((group) => group.operations.length > 0);

  const toggleOpChecked = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleOpExpanded = (key) => setExpandedOps((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleGroupCollapsed = (tag) => setCollapsedGroups((prev) => {
    const next = new Set(prev);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    return next;
  });

  const groupKeys = (group) => group.operations.map((o) => o.key);
  const groupCheckState = (group) => {
    const keys = groupKeys(group);
    const selectedCount = keys.filter((k) => selected.has(k)).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === keys.length) return 'all';
    return 'some';
  };
  const toggleGroupChecked = (group) => {
    const keys = groupKeys(group);
    const state = groupCheckState(group);
    setSelected((prev) => {
      const next = new Set(prev);
      if (state === 'all') keys.forEach((k) => next.delete(k));
      else keys.forEach((k) => next.add(k));
      return next;
    });
  };

  const totalOps = groups.reduce((sum, g) => sum + g.operations.length, 0);

  const handleApply = () => {
    if (selected.size === 0) return;
    onApply(Array.from(selected));
    setSelected(new Set());
  };

  return (
    <div className="preview-pane cleanup-panel">
      <div className="cleanup-scroll">
        <p className="test-panel-note">
          Browse operations by category, inspect parameters/responses, send a real test request,
          and select operations to remove - all in one place. Requests run server-side (from this
          app&apos;s own cog), the same as before, so browser CORS never applies. Removals only edit
          the editor&apos;s draft JSON - <strong>Save</strong> is still required to persist anything.
        </p>

        <div className="cleanup-toolbar">
          <input
            type="text"
            className="op-search-input"
            placeholder="Search operations (method, path, summary, category)…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="cleanup-count">
            {selected.size} of {totalOps} selected for removal
          </span>
          <button type="button" className="btn btn-primary" onClick={handleApply} disabled={disabled || selected.size === 0}>
            Apply removals to editor
          </button>
        </div>

        <div className="op-settings-block">
          <button type="button" className="op-settings-toggle" onClick={() => setSettingsOpen((v) => !v)}>
            <span className={`cleanup-group-caret ${settingsOpen ? '' : 'collapsed'}`}>▾</span>
            Test settings (server, headers, auth) - shared by every operation below
          </button>
          {settingsOpen && (
            <div className="op-settings-body">
              <div className="test-field-row">
                <label>Server base URL</label>
                <input type="text" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://192.168.0.181:8000" />
              </div>

              <div className="test-field-row">
                <label>Custom headers (optional)</label>
                <KeyValueList rows={customHeaders} onChange={setCustomHeaders} keyPlaceholder="Header name (e.g. X-Api-Key)" valuePlaceholder="Value" />
              </div>

              <div className="test-auth-block">
                <div className="test-field-row">
                  <label>Auth type</label>
                  <select value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
                    <option value="none">None (pass through only)</option>
                    <option value="basic">Basic</option>
                    <option value="bearer">Bearer token</option>
                    <option value="oauth2">OAuth2 (client credentials)</option>
                    <option value="login">Login request (2-step: get a token, then use it)</option>
                  </select>
                </div>

                {authMode === 'basic' && (
                  <div className="test-field-row-pair">
                    <input type="text" placeholder="Username" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} />
                    <input type="password" placeholder="Password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} />
                  </div>
                )}

                {authMode === 'bearer' && (
                  <div className="test-field-row">
                    <input type="text" placeholder="Bearer token" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
                  </div>
                )}

                {authMode === 'oauth2' && (
                  <div className="test-oauth-fields">
                    <input type="text" placeholder="Token URL" value={oauth.tokenUrl} onChange={(e) => updateOauth('tokenUrl', e.target.value)} />
                    <input type="text" placeholder="Client ID" value={oauth.clientId} onChange={(e) => updateOauth('clientId', e.target.value)} />
                    <input type="password" placeholder="Client secret" value={oauth.clientSecret} onChange={(e) => updateOauth('clientSecret', e.target.value)} />
                    <input type="text" placeholder="Scope (optional)" value={oauth.scope} onChange={(e) => updateOauth('scope', e.target.value)} />
                    <input type="text" placeholder="Audience (optional)" value={oauth.audience} onChange={(e) => updateOauth('audience', e.target.value)} />
                  </div>
                )}

                {authMode === 'login' && (
                  <div className="test-login-block">
                    <p className="test-panel-note">
                      Runs this sub-request first, pulls a token out of its JSON response, then applies
                      that token to every test request below however this API expects it.
                    </p>
                    <div className="test-field-row-pair">
                      <select value={login.method} onChange={(e) => updateLogin('method', e.target.value)}>
                        <option value="POST">POST</option>
                        <option value="GET">GET</option>
                        <option value="PUT">PUT</option>
                      </select>
                      <input type="text" placeholder="Login URL" value={login.url} onChange={(e) => updateLogin('url', e.target.value)} />
                    </div>
                    <label>Login request headers</label>
                    <KeyValueList rows={login.headers} onChange={(rows) => updateLogin('headers', rows)} />
                    <label>Login request body (e.g. username/password JSON)</label>
                    <textarea rows={4} value={login.body} onChange={(e) => updateLogin('body', e.target.value)} placeholder={'{\n  "username": "...",\n  "password": "..."\n}'} />
                    <label>Token path in the login response (dot-path, e.g. data.access_token)</label>
                    <input type="text" value={login.tokenPath} onChange={(e) => updateLogin('tokenPath', e.target.value)} placeholder="access_token" />
                    <div className="test-field-row-pair">
                      <label>
                        Apply token as
                        <select value={login.applyAs} onChange={(e) => updateLogin('applyAs', e.target.value)}>
                          <option value="header">Header</option>
                          <option value="query">Query parameter</option>
                        </select>
                      </label>
                      {login.applyAs === 'query' ? (
                        <label>
                          Query param name
                          <input type="text" value={login.queryParam} onChange={(e) => updateLogin('queryParam', e.target.value)} placeholder="token" />
                        </label>
                      ) : (
                        <label>
                          Header name
                          <input type="text" value={login.headerName} onChange={(e) => updateLogin('headerName', e.target.value)} placeholder="Authorization" />
                        </label>
                      )}
                    </div>
                    {login.applyAs !== 'query' && (
                      <label>
                        Header value prefix (include trailing space; blank for none)
                        <input type="text" value={login.prefix} onChange={(e) => updateLogin('prefix', e.target.value)} />
                      </label>
                    )}
                  </div>
                )}

                <div className="test-checkbox-row">
                  <label><input type="checkbox" checked={useCurl} onChange={(e) => setUseCurl(e.target.checked)} /> Use curl instead of the built-in HTTP client</label>
                  <label><input type="checkbox" checked={insecureTLS} onChange={(e) => setInsecureTLS(e.target.checked)} /> Skip TLS certificate verification</label>
                </div>
              </div>
            </div>
          )}
        </div>

        {visibleGroups.length === 0 && (
          <div className="preview-empty">
            {q ? `No operations match "${search}".` : 'This spec has no operations yet.'}
          </div>
        )}

        {visibleGroups.map((group) => {
          const state = groupCheckState(group);
          const isCollapsed = collapsedGroups.has(group.tag);
          return (
            <div className="cleanup-group" key={group.tag}>
              <div className="cleanup-group-header">
                <input
                  type="checkbox"
                  checked={state === 'all'}
                  ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
                  onChange={() => toggleGroupChecked(group)}
                  title="Select/deselect every operation in this category"
                />
                <button type="button" className="cleanup-group-toggle" onClick={() => toggleGroupCollapsed(group.tag)} aria-expanded={!isCollapsed}>
                  <span className={`cleanup-group-caret ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
                  <span className="cleanup-group-name">{group.tag}</span>
                  <span className="cleanup-group-sub">{group.operations.length} operation{group.operations.length === 1 ? '' : 's'}</span>
                </button>
              </div>
              {!isCollapsed && (
                <div className="cleanup-ops">
                  {group.operations.map((op) => (
                    <OperationRow
                      key={op.key}
                      op={op}
                      checked={selected.has(op.key)}
                      onToggleChecked={() => toggleOpChecked(op.key)}
                      expanded={expandedOps.has(op.key)}
                      onToggleExpanded={() => toggleOpExpanded(op.key)}
                      sharedSettings={sharedSettings}
                      onSetDefault={onSetDefault}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
