import React, { useEffect, useState } from 'react';
import * as api from '../api';

const EMPTY = {
  name: '',
  targetType: 'adapter',
  serviceName: '',
  method: 'GET',
  path: '/',
  intervalSeconds: 300,
  timeoutMs: 5000,
  enabled: true,
  useCurl: false,
  insecureTLS: false,
  targetAuthMode: 'none',
  authUsername: '',
  authPassword: '',
  authToken: '',
  oauth: { tokenUrl: '', clientId: '', clientSecret: '', scope: '', audience: '' },
  credentialPaths: { username: '', password: '', authToken: '', clientId: '', clientSecret: '', tokenUrl: '' },
};

const INTERVAL_PRESETS = [
  { label: 'Every 1 minute', value: 60 },
  { label: 'Every 5 minutes', value: 300 },
  { label: 'Every 15 minutes', value: 900 },
  { label: 'Every 30 minutes', value: 1800 },
  { label: 'Every hour', value: 3600 },
  { label: 'Every 6 hours', value: 21600 },
];
const PRESET_VALUES = INTERVAL_PRESETS.map((preset) => preset.value);
const CUSTOM_INTERVAL = '__custom_interval__';

const CUSTOM_OPTION = '__custom__';

function normalizeTargetType(rawType) {
  const t = String(rawType || '').toLowerCase();
  if (t.startsWith('adapt')) return 'adapter';
  if (t.startsWith('integ')) return 'integration';
  if (t.startsWith('app')) return 'app';
  return 'adapter';
}

export default function CheckForm({ initial, targets = [], onSave, onCancel }) {
  const [form, setForm] = useState(
    initial ? {
      ...EMPTY,
      ...initial,
      oauth: { ...EMPTY.oauth, ...(initial.oauth || {}) },
      credentialPaths: { ...EMPTY.credentialPaths, ...(initial.credentialPaths || {}) },
    } : EMPTY,
  );
  const [useDecryptFromIap, setUseDecryptFromIap] = useState(
    !!(initial && initial.credentialPaths && Object.values(initial.credentialPaths).some(Boolean)),
  );
  const [bodyText, setBodyText] = useState(
    initial && initial.body ? JSON.stringify(initial.body, null, 2) : '',
  );
  const [bodyError, setBodyError] = useState(null);
  const [useManualEntry, setUseManualEntry] = useState(
    !targets.some((t) => t.name === (initial && initial.serviceName)),
  );
  // The interval preset dropdown offers common intervals plus a "Custom..."
  // option; if the existing check's intervalSeconds doesn't match any
  // preset (e.g. it was set to a custom value previously, or via the API
  // directly), start already in custom mode so the real value is visible
  // rather than silently snapping to the nearest preset.
  const [useCustomInterval, setUseCustomInterval] = useState(
    !PRESET_VALUES.includes(Number((initial && initial.intervalSeconds) || 300)),
  );
  const [customIntervalValue, setCustomIntervalValue] = useState(
    useCustomInterval ? String((initial && initial.intervalSeconds) || 300) : '',
  );
  const [customIntervalUnit, setCustomIntervalUnit] = useState('seconds');
  const [intervalError, setIntervalError] = useState(null);
  const isEdit = !!(initial && initial.id);

  // Operations available on the currently-selected Integration's own
  // OpenAPI model (see src.js#getIntegrationOperations) - lets the user
  // pick a method/path from that model directly instead of typing it in,
  // and pre-fills the one the model's own author marked as the default
  // health-check call (the star in the OpenAPI Editor's Operations tab),
  // if any. Not fetched/shown at all for adapter/app targets.
  const [integrationOps, setIntegrationOps] = useState([]);
  const [opsLoading, setOpsLoading] = useState(false);
  const [opsError, setOpsError] = useState(null);
  const [opSearch, setOpSearch] = useState('');
  const [opPickerOpen, setOpPickerOpen] = useState(false);
  const [autoFilledDefault, setAutoFilledDefault] = useState(false);

  useEffect(() => {
    if (form.targetType !== 'integration' || !form.serviceName) {
      setIntegrationOps([]);
      return undefined;
    }
    let cancelled = false;
    setOpsLoading(true);
    setOpsError(null);
    api.getIntegrationOperations(form.serviceName)
      .then((result) => {
        if (cancelled) return;
        // DELETE calls are deliberately excluded from the picker for now -
        // this form doesn't support DELETE as a health-check method (see
        // the Method dropdown below), so don't even offer one to pick.
        const ops = ((result && result.operations) || []).filter((op) => op.method !== 'DELETE');
        setIntegrationOps(ops);
        // Pre-fill from the model's own marked default, but only once per
        // form session and only for a brand-new check that's still at its
        // untouched starting method/path - never overwrite a value the
        // user (or an existing check being edited) already has. Skip the
        // auto-fill if the marked default happens to be a DELETE, for the
        // same reason it's excluded from the picker above.
        if (!isEdit && !autoFilledDefault && result && result.defaultOperation
          && result.defaultOperation.method !== 'DELETE'
          && form.method === 'GET' && form.path === '/') {
          setForm((prev) => ({ ...prev, method: result.defaultOperation.method, path: result.defaultOperation.path }));
          setAutoFilledDefault(true);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setIntegrationOps([]);
        // Surface the real failure (e.g. a 403 because this new method
        // hasn't been re-authorized in Admin Essentials yet, or a 404
        // because the deployed src.js/pronghorn.json is stale) instead of
        // silently falling through to "no model found," which would hide
        // exactly the kind of deployment issue that's bitten this app
        // before - see README "Known deployment quirks".
        setOpsError(err.message || 'Failed to load operations.');
      })
      .finally(() => { if (!cancelled) setOpsLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.targetType, form.serviceName]);

  const filteredIntegrationOps = (() => {
    const q = opSearch.trim().toLowerCase();
    if (!q) return integrationOps;
    return integrationOps.filter((op) => (
      `${op.method} ${op.path}`.toLowerCase().includes(q)
      || (op.summary || '').toLowerCase().includes(q)
    ));
  })();

  const chooseIntegrationOp = (op) => {
    setForm((prev) => ({ ...prev, method: op.method, path: op.path }));
    setOpSearch('');
    setOpPickerOpen(false);
  };
  const needsBody = form.method !== 'GET';

  const update = (field, value) => setForm((prev) => ({ ...prev, [field]: value }));
  const updateOauth = (field, value) => setForm((prev) => ({ ...prev, oauth: { ...prev.oauth, [field]: value } }));
  const updateCredentialPath = (field, value) => setForm((prev) => ({
    ...prev,
    credentialPaths: { ...prev.credentialPaths, [field]: value },
  }));

  const handleTargetSelect = (value) => {
    if (value === CUSTOM_OPTION) {
      setUseManualEntry(true);
      return;
    }
    const target = targets.find((t) => t.name === value);
    setForm((prev) => ({
      ...prev,
      serviceName: value,
      targetType: target ? normalizeTargetType(target.type) : prev.targetType,
    }));
  };

  // Only offer instances whose discovered type actually matches the
  // currently-selected Target type - so switching to "Integration" narrows
  // the dropdown to integrations only, "Adapter" to adapters only, etc.,
  // instead of showing every installed instance regardless of type.
  const targetsForType = targets.filter((t) => normalizeTargetType(t.type) === form.targetType);

  const handleTargetTypeChange = (value) => {
    setForm((prev) => ({ ...prev, targetType: value, serviceName: '' }));
  };

  const UNIT_MULTIPLIERS = { seconds: 1, minutes: 60, hours: 3600 };

  const handleSubmit = (e) => {
    e.preventDefault();

    let body;
    if (needsBody && bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
        setBodyError(null);
      } catch (err) {
        setBodyError(`Payload isn't valid JSON: ${err.message}`);
        return;
      }
    }

    let intervalSeconds;
    if (useCustomInterval) {
      const raw = Number(customIntervalValue);
      if (!raw || raw <= 0) {
        setIntervalError('Enter a custom interval greater than 0.');
        return;
      }
      intervalSeconds = Math.round(raw * UNIT_MULTIPLIERS[customIntervalUnit]);
      if (intervalSeconds < 5) {
        setIntervalError('Custom interval must be at least 5 seconds.');
        return;
      }
    } else {
      intervalSeconds = Number(form.intervalSeconds);
    }
    setIntervalError(null);

    onSave({
      name: form.name.trim(),
      targetType: form.targetType,
      serviceName: form.serviceName.trim(),
      method: form.method,
      path: form.path.trim() || '/',
      body,
      intervalSeconds,
      timeoutMs: Number(form.timeoutMs),
      enabled: !!form.enabled,
      useCurl: !!form.useCurl,
      targetAuthMode: form.targetType === 'integration' ? form.targetAuthMode : 'none',
      authUsername: form.authUsername.trim(),
      authPassword: form.authPassword,
      authToken: form.authToken.trim(),
      oauth: { ...form.oauth },
      insecureTLS: !!form.insecureTLS,
      credentialPaths: useDecryptFromIap ? { ...form.credentialPaths } : {},
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>{isEdit ? 'Edit Health Check' : 'Add Health Check'}</h2>
        <form onSubmit={handleSubmit}>
          <label>
            Name
            <input
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="e.g. Slack Adapter - Ping"
              required
            />
          </label>

          <div className="form-row">
            <label>
              Target type
              <select value={form.targetType} onChange={(e) => handleTargetTypeChange(e.target.value)}>
                <option value="adapter">Adapter</option>
                <option value="integration">Integration</option>
                <option value="app">App</option>
              </select>
            </label>
            <label>
              Target instance
              {useManualEntry || targets.length === 0 ? (
                <input
                  type="text"
                  value={form.serviceName}
                  onChange={(e) => update('serviceName', e.target.value)}
                  placeholder="e.g. slack-adapter"
                  required
                />
              ) : (
                <select value={form.serviceName} onChange={(e) => handleTargetSelect(e.target.value)} required>
                  <option value="" disabled>Select an installed instance…</option>
                  {targetsForType.map((t) => (
                    <option key={t.name} value={t.name}>{`${t.name} (${t.type})`}</option>
                  ))}
                  <option value={CUSTOM_OPTION}>Other (type manually)…</option>
                </select>
              )}
            </label>
          </div>
          {!useManualEntry && targets.length > 0 && targetsForType.length === 0 && (
            <p className="form-hint">
              No discovered {form.targetType === 'app' ? 'apps' : `${form.targetType}s`} found in
              service_configs - use
              {' '}
              <button type="button" className="link-button" onClick={() => setUseManualEntry(true)}>
                type manually
              </button>
              {' '}
              instead.
            </p>
          )}
          {targets.length > 0 && useManualEntry && (
            <p className="form-hint">
              Typing manually - this must exactly match the instance name IAP uses in its
              route, which may differ from the adapter package name.
              {' '}
              <button type="button" className="link-button" onClick={() => setUseManualEntry(false)}>
                Choose from installed instances instead
              </button>
            </p>
          )}

          <div className="form-row">
            <label>
              Method
              <select value={form.method} onChange={(e) => update('method', e.target.value)}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
              </select>
            </label>
            <label className="form-row-grow">
              Call / task path
              <input
                type="text"
                value={form.path}
                onChange={(e) => update('path', e.target.value)}
                placeholder="e.g. /getOrganizations"
                required
              />
            </label>
          </div>
          <p className="form-hint">
            The full request will be sent to
            {' '}
            <code>{`${form.serviceName || '<serviceName>'}${form.path.startsWith('/') ? form.path : `/${form.path}`}`}</code>
            {' '}
            on the platform&apos;s own web server - use whatever lightweight,
            side-effect-free task/route already exists on that adapter or
            integration (a &quot;ping&quot; or simple read-only call works
            best).
          </p>

          {form.targetType === 'integration' && form.serviceName && (
            <div className="op-picker-block">
              {opsLoading && <p className="form-hint">Looking up {form.serviceName}&apos;s own API…</p>}
              {!opsLoading && integrationOps.length > 0 && (
                <>
                  <label htmlFor="hm-op-search">
                    Pick from {form.serviceName}&apos;s own API (optional - fills Method/Call path above)
                  </label>
                  <input
                    id="hm-op-search"
                    type="text"
                    placeholder="Search this integration's operations…"
                    value={opSearch}
                    onFocus={() => setOpPickerOpen(true)}
                    onChange={(e) => { setOpSearch(e.target.value); setOpPickerOpen(true); }}
                  />
                  {opPickerOpen && (
                    <div className="op-picker-list">
                      {filteredIntegrationOps.length === 0 && (
                        <div className="op-picker-empty">No operations match &quot;{opSearch}&quot;</div>
                      )}
                      {filteredIntegrationOps.map((op) => (
                        <button
                          type="button"
                          key={`${op.method} ${op.path}`}
                          className="op-picker-row"
                          onClick={() => chooseIntegrationOp(op)}
                        >
                          <span className={`method-badge method-${op.method.toLowerCase()}`}>{op.method}</span>
                          <span className="op-picker-path">{op.path}</span>
                          {op.summary && <span className="op-picker-summary">{op.summary}</span>}
                          {op.isDefault && <span className="op-default-badge">Default</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
              {!opsLoading && opsError && (
                <p className="form-hint form-hint-error">
                  Couldn&apos;t load {form.serviceName}&apos;s operations: {opsError}
                  {' '}
                  (if this just started happening after adding this feature, check that the
                  health-monitor service was fully stopped and started - not just reloaded -
                  and that its getIntegrationOperations method is authorized for your role in
                  Admin Essentials). You can still type the method/call path above manually.
                </p>
              )}
              {!opsLoading && !opsError && integrationOps.length === 0 && (
                <p className="form-hint">
                  No OpenAPI model found for {form.serviceName} (or it has no documented operations) -
                  type the method/call path above manually.
                </p>
              )}
            </div>
          )}

          {form.targetType === 'integration' && (
            <>
              <label>
                Auth type (for this integration&apos;s own endpoint)
                <select value={form.targetAuthMode} onChange={(e) => update('targetAuthMode', e.target.value)}>
                  <option value="none">None</option>
                  <option value="basic">Basic (username/password)</option>
                  <option value="bearer">Bearer token (static)</option>
                  <option value="oauth2">OAuth2 (client credentials)</option>
                </select>
              </label>
              <p className="form-hint">
                This authenticates directly to the integration&apos;s own
                endpoint - separate from this app&apos;s own platform-level
                settings, and independent per check, since different
                integrations often need different auth.
              </p>

              {form.targetAuthMode !== 'none' && (
                <label className="form-checkbox">
                  <input
                    type="checkbox"
                    checked={useDecryptFromIap}
                    onChange={(e) => setUseDecryptFromIap(e.target.checked)}
                  />
                  Decrypt credentials from IAP instead of entering them here
                </label>
              )}
              {useDecryptFromIap && form.targetAuthMode !== 'none' && (
                <p className="form-hint">
                  Instead of storing a plaintext value on this check, give a
                  dot-path into <strong>{form.serviceName || 'this target'}</strong>&apos;s
                  own <code>service_configs</code> document (e.g.{' '}
                  <code>properties.properties.authentication.basicAuth.password</code>).
                  If that path resolves to a <code>$ENC...</code> value, it&apos;s
                  decrypted fresh on every check run using IAP&apos;s own
                  encryption key - nothing decrypted is ever stored. Leave a
                  path blank to fall back to the literal value field for that
                  one credential.
                </p>
              )}

              {form.targetAuthMode === 'basic' && (
                <div className="form-row">
                  <label>
                    Username{useDecryptFromIap ? ' path' : ''}
                    {useDecryptFromIap ? (
                      <input
                        type="text"
                        value={form.credentialPaths.username}
                        onChange={(e) => updateCredentialPath('username', e.target.value)}
                        placeholder="properties.properties.authentication.basicAuth.username"
                      />
                    ) : (
                      <input
                        type="text"
                        value={form.authUsername}
                        onChange={(e) => update('authUsername', e.target.value)}
                        placeholder="e.g. admin"
                        autoComplete="off"
                      />
                    )}
                  </label>
                  <label>
                    Password{useDecryptFromIap ? ' path' : ''}
                    {useDecryptFromIap ? (
                      <input
                        type="text"
                        value={form.credentialPaths.password}
                        onChange={(e) => updateCredentialPath('password', e.target.value)}
                        placeholder="properties.properties.authentication.basicAuth.password"
                      />
                    ) : (
                      <input
                        type="password"
                        value={form.authPassword}
                        onChange={(e) => update('authPassword', e.target.value)}
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    )}
                  </label>
                </div>
              )}

              {form.targetAuthMode === 'bearer' && (
                <label>
                  Bearer token{useDecryptFromIap ? ' path' : ''}
                  {useDecryptFromIap ? (
                    <input
                      type="text"
                      value={form.credentialPaths.authToken}
                      onChange={(e) => updateCredentialPath('authToken', e.target.value)}
                      placeholder="properties.properties.authentication.token.access_token"
                    />
                  ) : (
                    <input
                      type="password"
                      value={form.authToken}
                      onChange={(e) => update('authToken', e.target.value)}
                      placeholder="static token sent as Authorization: Bearer <token>"
                      autoComplete="off"
                    />
                  )}
                </label>
              )}

              {form.targetAuthMode === 'oauth2' && (
                <>
                  <label>
                    Token URL{useDecryptFromIap ? ' path (optional - rarely encrypted)' : ''}
                    {useDecryptFromIap ? (
                      <input
                        type="text"
                        value={form.credentialPaths.tokenUrl}
                        onChange={(e) => updateCredentialPath('tokenUrl', e.target.value)}
                        placeholder="leave blank to use the literal Token URL below"
                      />
                    ) : (
                      <input
                        type="text"
                        value={form.oauth.tokenUrl}
                        onChange={(e) => updateOauth('tokenUrl', e.target.value)}
                        placeholder="https://auth.example.com/oauth/token"
                      />
                    )}
                  </label>
                  {useDecryptFromIap && (
                    <label>
                      Token URL (literal fallback)
                      <input
                        type="text"
                        value={form.oauth.tokenUrl}
                        onChange={(e) => updateOauth('tokenUrl', e.target.value)}
                        placeholder="https://auth.example.com/oauth/token"
                      />
                    </label>
                  )}
                  <div className="form-row">
                    <label>
                      Client ID{useDecryptFromIap ? ' path' : ''}
                      {useDecryptFromIap ? (
                        <input
                          type="text"
                          value={form.credentialPaths.clientId}
                          onChange={(e) => updateCredentialPath('clientId', e.target.value)}
                          placeholder="properties.properties.authentication.ServiceAccount.client_id"
                        />
                      ) : (
                        <input
                          type="text"
                          value={form.oauth.clientId}
                          onChange={(e) => updateOauth('clientId', e.target.value)}
                        />
                      )}
                    </label>
                    <label>
                      Client secret{useDecryptFromIap ? ' path' : ''}
                      {useDecryptFromIap ? (
                        <input
                          type="text"
                          value={form.credentialPaths.clientSecret}
                          onChange={(e) => updateCredentialPath('clientSecret', e.target.value)}
                          placeholder="properties.properties.authentication.ServiceAccount.client_secret"
                        />
                      ) : (
                        <input
                          type="password"
                          value={form.oauth.clientSecret}
                          onChange={(e) => updateOauth('clientSecret', e.target.value)}
                          autoComplete="new-password"
                        />
                      )}
                    </label>
                  </div>
                  <div className="form-row">
                    <label>
                      Scope (optional)
                      <input
                        type="text"
                        value={form.oauth.scope}
                        onChange={(e) => updateOauth('scope', e.target.value)}
                      />
                    </label>
                    <label>
                      Audience (optional)
                      <input
                        type="text"
                        value={form.oauth.audience}
                        onChange={(e) => updateOauth('audience', e.target.value)}
                      />
                    </label>
                  </div>
                  <p className="form-hint">
                    Fetched independently for this check via the standard
                    OAuth2 client-credentials grant, cached until near
                    expiry - entirely separate from this app&apos;s own
                    platform-level OAuth2 settings.
                  </p>
                </>
              )}
            </>
          )}

          {needsBody && (
            <label>
              Request payload (JSON body)
              <textarea
                className="json-textarea"
                value={bodyText}
                onChange={(e) => { setBodyText(e.target.value); setBodyError(null); }}
                placeholder={'{\n  "example": "value"\n}'}
                rows={6}
              />
              {bodyError && <span className="field-error">{bodyError}</span>}
            </label>
          )}

          <div className="form-row">
            <label>
              Check interval
              <select
                value={useCustomInterval ? CUSTOM_INTERVAL : form.intervalSeconds}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_INTERVAL) {
                    setUseCustomInterval(true);
                    setIntervalError(null);
                    if (!customIntervalValue) setCustomIntervalValue(String(form.intervalSeconds || 300));
                    return;
                  }
                  setUseCustomInterval(false);
                  setIntervalError(null);
                  update('intervalSeconds', e.target.value);
                }}
              >
                {INTERVAL_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>{preset.label}</option>
                ))}
                <option value={CUSTOM_INTERVAL}>Custom…</option>
              </select>
            </label>
            <label>
              Timeout (ms)
              <input
                type="number"
                min="500"
                step="500"
                value={form.timeoutMs}
                onChange={(e) => update('timeoutMs', e.target.value)}
              />
            </label>
          </div>

          {useCustomInterval && (
            <div className="form-row">
              <label>
                Custom interval
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={customIntervalValue}
                  onChange={(e) => { setCustomIntervalValue(e.target.value); setIntervalError(null); }}
                  placeholder="e.g. 90"
                />
              </label>
              <label>
                Unit
                <select value={customIntervalUnit} onChange={(e) => setCustomIntervalUnit(e.target.value)}>
                  <option value="seconds">Seconds</option>
                  <option value="minutes">Minutes</option>
                  <option value="hours">Hours</option>
                </select>
              </label>
            </div>
          )}
          {intervalError && <span className="field-error">{intervalError}</span>}

          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update('enabled', e.target.checked)}
            />
            Enabled
          </label>

          <label className="form-checkbox">
            <input
              type="checkbox"
              checked={!!form.useCurl}
              onChange={(e) => update('useCurl', e.target.checked)}
            />
            Use curl instead of the built-in HTTP client
          </label>
          {form.useCurl && (
            <p className="form-hint">
              Runs this check by shelling out to the platform host&apos;s own
              <code>curl</code> binary rather than axios. Useful as a
              diagnostic - if a check fails through the normal path but a
              manual <code>curl</code> against the same URL succeeds, this
              option lets the check itself use that same working path.
              Requires <code>curl</code> to be installed and reachable on the
              platform host.
            </p>
          )}

          {form.targetType === 'integration' && (
            <>
              <label className="form-checkbox">
                <input
                  type="checkbox"
                  checked={!!form.insecureTLS}
                  onChange={(e) => update('insecureTLS', e.target.checked)}
                />
                Skip TLS certificate verification (self-signed/untrusted cert)
              </label>
              {form.insecureTLS && (
                <p className="form-hint">
                  Applies to both the OAuth2 token request and the check
                  request itself. Use this when the integration&apos;s own
                  config shows <code>tls.rejectUnauthorized: false</code>
                  (common for internal/self-signed HTTPS endpoints, including
                  IAP&apos;s own REST API over HTTPS) - without it, the
                  request will fail with a certificate error before auth is
                  even evaluated.
                </p>
              )}
            </>
          )}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEdit ? 'Save Changes' : 'Add Check'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
