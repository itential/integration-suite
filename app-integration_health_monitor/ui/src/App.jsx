import React, { useCallback, useEffect, useMemo, useState } from 'react';
import CheckTable from './components/CheckTable';
import CheckForm from './components/CheckForm';
import * as api from './api';
import { MOCK_CHECKS, MOCK_TARGETS } from './mockData';
import itentialMark from './assets/itential-icon.png';

const POLL_MS = 10000;

// Where the Itential logo should navigate back to - the platform's main
// landing page/dashboard. "/" resolves to the platform's own default
// landing route for the logged-in user on the same origin this app is
// served from, matching how the rest of IAP's own top-nav branding behaves.
const PLATFORM_HOME_URL = '/';

export default function App() {
  const [checks, setChecks] = useState([]);
  const [targets, setTargets] = useState([]);
  const [demoMode, setDemoMode] = useState(false);
  const [status, setStatus] = useState(null);
  const [editingCheck, setEditingCheck] = useState(null); // null = closed, {} = new, {...} = editing
  const [runningId, setRunningId] = useState(null);
  const [restartingId, setRestartingId] = useState(null);

  const refresh = useCallback(() => {
    api.listChecks()
      .then((result) => {
        setChecks(result);
        setDemoMode(false);
      })
      .catch(() => {
        setDemoMode(true);
        setChecks(MOCK_CHECKS);
      });
  }, []);

  useEffect(() => {
    // Best-effort - see src.js listTargets() caveats. Falls back to an
    // empty list (manual entry only) rather than demo targets if this
    // fails while the rest of the app is otherwise live.
    api.listTargets()
      .then(setTargets)
      .catch(() => setTargets(MOCK_TARGETS));
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const summary = useMemo(() => {
    const healthy = checks.filter((c) => c.status && c.status.state === 'healthy').length;
    const unhealthy = checks.filter((c) => c.status && c.status.state === 'unhealthy').length;
    const unknown = checks.length - healthy - unhealthy;
    return { total: checks.length, healthy, unhealthy, unknown };
  }, [checks]);

  const handleSave = async (config) => {
    try {
      if (demoMode) {
        setStatus({ type: 'info', message: 'Demo mode: changes are not persisted without a live IAP backend.' });
        setEditingCheck(null);
        return;
      }
      if (editingCheck && editingCheck.id) {
        await api.updateCheck(editingCheck.id, config);
        setStatus({ type: 'success', message: `Updated "${config.name}".` });
      } else {
        await api.createCheck(config);
        setStatus({ type: 'success', message: `Added "${config.name}".` });
      }
      setEditingCheck(null);
      refresh();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  const handleDelete = async (check) => {
    if (!window.confirm(`Delete health check "${check.name}"?`)) return;
    if (demoMode) {
      setStatus({ type: 'info', message: 'Demo mode: changes are not persisted without a live IAP backend.' });
      return;
    }
    try {
      await api.deleteCheck(check.id);
      setStatus({ type: 'success', message: `Deleted "${check.name}".` });
      refresh();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  const handleToggleEnabled = async (check) => {
    if (demoMode) {
      setStatus({ type: 'info', message: 'Demo mode: changes are not persisted without a live IAP backend.' });
      return;
    }
    try {
      await api.updateCheck(check.id, { ...check, enabled: !check.enabled });
      refresh();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  const handleRunNow = async (check) => {
    if (demoMode) {
      setStatus({ type: 'info', message: 'Demo mode: cannot run a live check without a live IAP backend.' });
      return;
    }
    setRunningId(check.id);
    try {
      await api.runCheckNow(check.id);
      refresh();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setRunningId(null);
    }
  };

  // Restarting only ever applies to adapters/apps (see src.js#restartTarget) -
  // CheckTable itself hides the button for Integration checks, but this is
  // a second guard in case it's ever called some other way.
  const handleRestart = async (check) => {
    if (check.targetType === 'integration') {
      setStatus({ type: 'error', message: 'Restart does not apply to Integrations.' });
      return;
    }
    if (demoMode) {
      setStatus({ type: 'info', message: 'Demo mode: cannot restart a live service without a live IAP backend.' });
      return;
    }
    if (!window.confirm(`Restart "${check.serviceName}"? This will briefly interrupt anything using it.`)) return;
    setRestartingId(check.id);
    try {
      const result = await api.restartTarget(check.id);
      setStatus({
        type: result.success ? 'success' : 'error',
        message: result.message || (result.success ? 'Restarted.' : 'Restart failed.'),
      });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setRestartingId(null);
    }
  };

  return (
    <div className="app-shell hm-shell">
      <header className="topbar">
        <div className="topbar-title">
          <a href={PLATFORM_HOME_URL} className="topbar-logo-link" title="Back to Itential Platform">
            <img src={itentialMark} alt="Itential" className="topbar-logo" />
          </a>
          <div>
            <h1>Integration &amp; Adapter Health Monitor</h1>
            <span className="topbar-subtitle">Configurable checks, run on a schedule</span>
          </div>
        </div>
        <div className="topbar-actions">
          {demoMode && <span className="pill pill-demo">Demo data</span>}
          <button type="button" className="btn btn-primary" onClick={() => setEditingCheck({})}>
            + Add Check
          </button>
        </div>
      </header>

      {status && (
        <div className={`status-banner status-${status.type}`}>{status.message}</div>
      )}

      <div className="summary-bar">
        <div className="summary-card">
          <span className="summary-value">{summary.total}</span>
          <span className="summary-label">Total Checks</span>
        </div>
        <div className="summary-card summary-healthy">
          <span className="summary-value">{summary.healthy}</span>
          <span className="summary-label">Healthy</span>
        </div>
        <div className="summary-card summary-unhealthy">
          <span className="summary-value">{summary.unhealthy}</span>
          <span className="summary-label">Unhealthy</span>
        </div>
        <div className="summary-card summary-unknown">
          <span className="summary-value">{summary.unknown}</span>
          <span className="summary-label">Not Yet Checked</span>
        </div>
      </div>

      <div className="hm-content">
        <CheckTable
          checks={checks}
          onEdit={setEditingCheck}
          onDelete={handleDelete}
          onRunNow={handleRunNow}
          onRestart={handleRestart}
          onToggleEnabled={handleToggleEnabled}
          runningId={runningId}
          restartingId={restartingId}
        />
      </div>

      {editingCheck !== null && (
        <CheckForm
          initial={editingCheck}
          targets={targets}
          onSave={handleSave}
          onCancel={() => setEditingCheck(null)}
        />
      )}
    </div>
  );
}
