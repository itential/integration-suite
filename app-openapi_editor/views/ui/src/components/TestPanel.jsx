import React, { useEffect, useMemo, useState } from 'react';
import * as api from '../api';

const METHODS_WITH_BODY = ['post', 'put', 'patch'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// Builds a flat list of { key, method, path, summary } from spec.paths, so
// the operation dropdown mirrors what the Preview pane already shows.
function extractOperations(spec) {
  if (!spec || !spec.paths) return [];
  const ops = [];
  Object.keys(spec.paths).forEach((path) => {
    const pathItem = spec.paths[path] || {};
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      ops.push({
        key: `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary || op.operationId || '',
      });
    });
  });
  return ops;
}

// Substitutes {paramName} placeholders in a path template using the
// pathParams object, and returns the remaining path (query params are
// appended separately).
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

const EMPTY_OAUTH = { tokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '' };
const EMPTY_LOGIN = {
  url: '', method: 'POST', headers: [{ key: 'Content-Type', value: 'application/json' }], body: '',
  tokenPath: '', applyAs: 'header', headerName: 'Authorization', prefix: 'Bearer ', queryParam: 'token',
};

// Small repeatable key/value list editor, shared by the custom-headers row
// and the login sub-request's own headers - Add/remove rows, no fixed count.
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
          <input
            type="text"
            placeholder={keyPlaceholder || 'Header name'}
            value={row.key}
            onChange={(e) => update(idx, 'key', e.target.value)}
          />
          <input
            type="text"
            placeholder={valuePlaceholder || 'Value'}
            value={row.value}
            onChange={(e) => update(idx, 'value', e.target.value)}
          />
          <button type="button" className="btn btn-tiny btn-tiny-danger" onClick={() => remove(idx)}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn-tiny btn-tiny-secondary kv-add-btn" onClick={add}>+ Add header</button>
    </div>
  );
}

export default function TestPanel({ spec }) {
  const operations = useMemo(() => extractOperations(spec), [spec]);
  const [selectedKey, setSelectedKey] = useState('');
  const [opSearch, setOpSearch] = useState('');
  const [opListOpen, setOpListOpen] = useState(false);
  const [server, setServer] = useState('');
  const [pathParams, setPathParams] = useState({});
  const [queryParams, setQueryParams] = useState('');
  const [body, setBody] = useState('');
  const [authMode, setAuthMode] = useState('none');
  const [authUsername, setAuthUsername] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [oauth, setOauth] = useState(EMPTY_OAUTH);
  const [login, setLogin] = useState(EMPTY_LOGIN);
  const [customHeaders, setCustomHeaders] = useState([]);
  const [useCurl, setUseCurl] = useState(false);
  const [insecureTLS, setInsecureTLS] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (spec && spec.servers && spec.servers.length && !server) {
      setServer(spec.servers[0].url);
    }
    if (operations.length && !selectedKey) {
      setSelectedKey(operations[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  const selectedOp = operations.find((o) => o.key === selectedKey);
  const pathParamNames = selectedOp ? extractPathParamNames(selectedOp.path) : [];
  const showBody = selectedOp && METHODS_WITH_BODY.includes(selectedOp.method);

  const updatePathParam = (name, value) => setPathParams((prev) => ({ ...prev, [name]: value }));
  const updateOauth = (field, value) => setOauth((prev) => ({ ...prev, [field]: value }));
  const updateLogin = (field, value) => setLogin((prev) => ({ ...prev, [field]: value }));

  // Flattens a repeatable key/value list to a plain object for the request
  // config, dropping blank rows (an empty key with no value is just an
  // unfinished row, not a header the user actually wants sent).
  const flattenHeaders = (rows) => rows.reduce((acc, row) => {
    if (row.key) acc[row.key] = row.value;
    return acc;
  }, {});

  // Filters the operation list against the search box - matches on method,
  // path, summary, or operationId, so typing e.g. "whoami" narrows straight
  // down to "GET /whoami - Get the authorization data for the logged in
  // user" even though "whoami" only appears in the path, not the summary.
  const filteredOperations = useMemo(() => {
    const q = opSearch.trim().toLowerCase();
    if (!q) return operations;
    return operations.filter((op) => (
      op.key.toLowerCase().includes(q)
      || op.summary.toLowerCase().includes(q)
      || op.path.toLowerCase().includes(q)
      || op.method.toLowerCase().includes(q)
    ));
  }, [operations, opSearch]);

  const chooseOperation = (op) => {
    setSelectedKey(op.key);
    setOpSearch('');
    setOpListOpen(false);
    setPathParams({});
  };

  const handleSend = async () => {
    if (!selectedOp) return;
    setSending(true);
    setResult(null);
    try {
      const base = String(server || '').replace(/\/+$/, '');
      const filledPath = fillPathParams(selectedOp.path, pathParams);
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
        ...flattenHeaders(customHeaders),
      };

      const config = {
        url,
        method: selectedOp.method.toUpperCase(),
        headers,
        body: parsedBody,
        authMode,
        authUsername,
        authPassword,
        authToken,
        oauth,
        // login.headers is passed through as-is (an array of { key, value }
        // rows) - src.js#performLoginRequest reads it in that same shape.
        login,
        useCurl,
        insecureTLS,
      };

      const response = await api.testRequest(config);
      setResult(response);
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setSending(false);
    }
  };

  if (!spec) {
    return <div className="preview-pane"><div className="preview-empty">Select a model to test it</div></div>;
  }

  return (
    <div className="preview-pane test-panel">
      <p className="test-panel-note">
        Requests here run from the Itential Platform server itself (via the app&apos;s own
        cog), not from your browser - this is what avoids the browser CORS errors seen
        with Swagger UI&apos;s built-in &quot;Try it out&quot;.
      </p>

      <div className="test-field-row test-op-combobox">
        <label htmlFor="test-op-search">Operation</label>
        {selectedOp && !opListOpen && (
          <button
            type="button"
            className="test-op-selected"
            onClick={() => { setOpListOpen(true); setOpSearch(''); }}
          >
            <span className={`method-badge method-${selectedOp.method}`}>{selectedOp.method}</span>
            <span className="test-op-selected-path">{selectedOp.path}</span>
            {selectedOp.summary && <span className="test-op-selected-summary">{selectedOp.summary}</span>}
            <span className="test-op-change">Change</span>
          </button>
        )}
        {(!selectedOp || opListOpen) && (
          <>
            <input
              id="test-op-search"
              type="text"
              autoFocus={opListOpen}
              placeholder="Search operations (e.g. whoami, /users, POST)…"
              value={opSearch}
              onChange={(e) => setOpSearch(e.target.value)}
              onFocus={() => setOpListOpen(true)}
            />
            <div className="test-op-list">
              {filteredOperations.length === 0 && (
                <div className="test-op-empty">No operations match &quot;{opSearch}&quot;</div>
              )}
              {filteredOperations.map((op) => (
                <button
                  key={op.key}
                  type="button"
                  className="test-op-row"
                  onClick={() => chooseOperation(op)}
                >
                  <span className={`method-badge method-${op.method}`}>{op.method}</span>
                  <span className="test-op-row-path">{op.path}</span>
                  {op.summary && <span className="test-op-row-summary">{op.summary}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="test-field-row">
        <label htmlFor="test-server">Server base URL</label>
        <input
          id="test-server"
          type="text"
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="http://192.168.0.181:8000"
        />
      </div>

      {pathParamNames.length > 0 && (
        <div className="test-field-row test-path-params">
          <label>Path parameters</label>
          {pathParamNames.map((name) => (
            <div key={name} className="test-path-param">
              <span>{name}</span>
              <input
                type="text"
                value={pathParams[name] || ''}
                onChange={(e) => updatePathParam(name, e.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      <div className="test-field-row">
        <label htmlFor="test-query">Query params (JSON object, optional)</label>
        <textarea
          id="test-query"
          rows={2}
          value={queryParams}
          onChange={(e) => setQueryParams(e.target.value)}
          placeholder='{ "limit": 10 }'
        />
      </div>

      <div className="test-field-row">
        <label>Custom headers (optional)</label>
        <KeyValueList
          rows={customHeaders}
          onChange={setCustomHeaders}
          keyPlaceholder="Header name (e.g. X-Api-Key)"
          valuePlaceholder="Value"
        />
      </div>

      {showBody && (
        <div className="test-field-row">
          <label htmlFor="test-body">Request body (JSON, optional)</label>
          <textarea
            id="test-body"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="{ ... }"
          />
        </div>
      )}

      <div className="test-auth-block">
        <div className="test-field-row">
          <label htmlFor="test-auth-mode">Auth type</label>
          <select id="test-auth-mode" value={authMode} onChange={(e) => setAuthMode(e.target.value)}>
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
              that token to the real request however this API expects it - a header (any name/prefix,
              not just <code>Authorization: Bearer</code>) or a query parameter.
            </p>
            <div className="test-field-row-pair">
              <select value={login.method} onChange={(e) => updateLogin('method', e.target.value)}>
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </select>
              <input
                type="text"
                placeholder="Login URL (e.g. https://api.example.com/auth/login)"
                value={login.url}
                onChange={(e) => updateLogin('url', e.target.value)}
              />
            </div>
            <label>Login request headers</label>
            <KeyValueList
              rows={login.headers}
              onChange={(rows) => updateLogin('headers', rows)}
            />
            <label htmlFor="test-login-body">Login request body (e.g. username/password JSON)</label>
            <textarea
              id="test-login-body"
              rows={4}
              value={login.body}
              onChange={(e) => updateLogin('body', e.target.value)}
              placeholder={'{\n  "username": "...",\n  "password": "..."\n}'}
            />
            <label htmlFor="test-login-token-path">
              Token path in the login response (dot-path, e.g. <code>data.access_token</code>)
            </label>
            <input
              id="test-login-token-path"
              type="text"
              value={login.tokenPath}
              onChange={(e) => updateLogin('tokenPath', e.target.value)}
              placeholder="access_token"
            />
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
                Header value prefix (e.g. <code>Bearer </code> - include the trailing space; leave blank for none)
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

      <button type="button" className="btn btn-primary test-send-btn" onClick={handleSend} disabled={sending || !selectedOp}>
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
  );
}
