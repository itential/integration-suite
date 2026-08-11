import React, { useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import Preview from './components/Preview';
import Operations, { applyRemovals, setDefaultOperation } from './components/Operations';
import TestPanel from './components/TestPanel';
import SaveConfirmModal from './components/SaveConfirmModal';
import * as api from './api';
import { MOCK_MODELS, MOCK_SPEC, MOCK_META } from './mockData';

// Minimal, valid starting point for a brand-new model - just enough
// structure (openapi/info/paths) that it validates immediately and the
// user can build out from there, rather than starting from an empty object.
const BLANK_MODEL_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'New Integration Model',
    version: '1.0.0',
    description: '',
  },
  servers: [
    { url: 'https://example.com' },
  ],
  paths: {},
};

export default function App() {
  const [models, setModels] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [text, setText] = useState('');
  // Itential/Mongo bookkeeping fields (_id, versionId) - NOT part of the
  // OpenAPI spec, so they're kept out of the editable JSON entirely and
  // only re-attached server-side (see saveModel in src.js) when writing
  // back to Mongo.
  const [meta, setMeta] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'success'|'error'|'info', message }
  const [demoMode, setDemoMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rightTab, setRightTab] = useState('preview'); // 'preview' | 'operations' | 'test'
  const [saveModal, setSaveModal] = useState(null); // { impact, result, saving } | null
  // True while the editor holds a not-yet-created model. New models skip
  // the sanctioned update-impact/backup flow entirely (see handleSave) -
  // there's nothing to delete/reapply/recreate for a model that doesn't
  // exist yet, so Save just creates it directly.
  const [isNewModel, setIsNewModel] = useState(false);

  useEffect(() => {
    api.listModels()
      .then((result) => {
        setModels(result);
        if (result.length) setActiveId(result[0].id);
      })
      .catch(() => {
        // No live IAP backend reachable - fall back to demo data so the UI
        // remains fully explorable.
        setDemoMode(true);
        setModels(MOCK_MODELS);
        setActiveId(MOCK_MODELS[0].id);
      });
  }, []);

  useEffect(() => {
    if (!activeId) return;
    if (demoMode) {
      setText(JSON.stringify(MOCK_SPEC, null, 2));
      setMeta(MOCK_META);
      setDirty(false);
      return;
    }
    setBusy(true);
    api.getModel(activeId)
      .then(({ spec, meta: modelMeta }) => {
        setText(JSON.stringify(spec, null, 2));
        setMeta(modelMeta);
        setDirty(false);
      })
      .catch((err) => setStatus({ type: 'error', message: err.message }))
      .finally(() => setBusy(false));
  }, [activeId, demoMode]);

  const parsed = useMemo(() => {
    try {
      return { spec: JSON.parse(text), error: null };
    } catch (err) {
      return { spec: null, error: err.message };
    }
  }, [text]);

  const handleSelect = (id) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setIsNewModel(false);
    setActiveId(id);
    setStatus(null);
  };

  // Opens a blank editor for a brand-new model, instead of loading an
  // existing one. Nothing is created yet - that happens on Save (see
  // handleSave's isNewModel branch).
  const handleNewModel = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setIsNewModel(true);
    setActiveId(null);
    setMeta(null);
    setText(JSON.stringify(BLANK_MODEL_SPEC, null, 2));
    setDirty(false);
    setStatus(null);
  };

  const handleChange = (value) => {
    setText(value);
    setDirty(true);
    setStatus(null);
  };

  const handleValidate = async () => {
    if (parsed.error) {
      setStatus({ type: 'error', message: `Invalid JSON: ${parsed.error}` });
      return;
    }
    if (demoMode) {
      setStatus({ type: 'success', message: 'Demo mode: skipping server-side validation.' });
      return;
    }
    setBusy(true);
    try {
      const result = await api.validateModel(parsed.spec);
      setStatus(result.valid
        ? { type: 'success', message: 'Document is a valid OpenAPI spec.' }
        : { type: 'error', message: result.errors.join('; ') });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  // Save no longer writes to Mongo directly - it now opens a confirmation
  // modal showing exactly what will be affected (see src.js#saveModel /
  // getUpdateImpact for why: Itential Platform has no supported in-place
  // update for a model with existing Integration instances, so the real
  // process is delete-dependent-instances / delete-model / reapply-model /
  // recreate-instances, and the user should see and be able to back up
  // that before it happens, not just click Save and hope).
  // Creating a new model is a much simpler motion than updating one: there
  // are no existing Integration instances to warn about, back up, delete,
  // or recreate, so this skips the confirmation modal entirely and calls
  // createModel directly. See src.js#createModel for why - the sanctioned
  // "update" process (2.4 in the as-built) only exists because a model can
  // already have instances built on it; a brand-new model never does.
  const handleCreateNewModel = async () => {
    setBusy(true);
    try {
      const result = await api.createModel(parsed.spec);
      if (!result.success) {
        setStatus({ type: 'error', message: (result.errors || []).join('; ') || 'Create failed.' });
        return;
      }
      setDirty(false);
      setIsNewModel(false);
      setStatus({
        type: 'success',
        message: `Model "${result.versionId}" created. This only creates the model definition - to make it usable, `
          + 'create an Integration instance for it using Itential Platform\'s normal process '
          + '(e.g. Admin Essentials -> Integrations -> Add), the same way you would for any other model.',
      });
      const updated = await api.listModels();
      setModels(updated);
      if (result.modelId) setActiveId(result.modelId);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (parsed.error) {
      setStatus({ type: 'error', message: `Invalid JSON: ${parsed.error}` });
      return;
    }
    if (demoMode) {
      setStatus({ type: 'info', message: 'Demo mode: changes are not persisted without a live IAP backend.' });
      setDirty(false);
      return;
    }
    if (isNewModel) {
      handleCreateNewModel();
      return;
    }
    setBusy(true);
    try {
      const impact = await api.getUpdateImpact(activeId);
      setSaveModal({ impact, result: null, saving: false });
    } catch (err) {
      setStatus({ type: 'error', message: `Couldn't preview what this save would affect: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmSave = async () => {
    setSaveModal((prev) => ({ ...prev, saving: true }));
    try {
      const result = await api.saveModel(activeId, parsed.spec);
      setSaveModal((prev) => ({ ...prev, result, saving: false }));
      if (result.success) {
        setDirty(false);
        setMeta((prev) => (prev ? { ...prev, versionId: result.versionId } : prev));
        api.listModels().then(setModels).catch(() => {});
      }
    } catch (err) {
      setSaveModal((prev) => ({
        ...prev,
        saving: false,
        result: { success: false, steps: [], errors: [err.message], backup: prev.impact && prev.impact.backup },
      }));
    }
  };

  // Called by the Cleanup tab's "Apply removals to editor" button - removes
  // the selected operations (and prunes any now-empty path entries / no-
  // longer-referenced spec.tags) from the CURRENT editor text, exactly like
  // any other manual edit: it becomes dirty and still requires Save to
  // actually persist. Never touches Mongo/the platform API directly.
  const handleApplyCleanup = (removedKeys) => {
    if (parsed.error || !parsed.spec) return;
    const nextSpec = applyRemovals(parsed.spec, removedKeys);
    setText(JSON.stringify(nextSpec, null, 2));
    setDirty(true);
    setStatus({
      type: 'success',
      message: `Removed ${removedKeys.length} operation${removedKeys.length === 1 ? '' : 's'} from the spec. `
        + 'This is still just a draft - click Save to persist it via the sanctioned update process.',
    });
  };

  // Marks (or unmarks) one operation as the default health-check call for
  // this model - see Operations.jsx#setDefaultOperation. Same "draft until
  // Save" treatment as cleanup removals: this only rewrites the editor's
  // in-memory JSON, it doesn't call the platform API or touch Mongo by
  // itself.
  const handleSetDefault = (key) => {
    if (parsed.error || !parsed.spec) return;
    const nextSpec = setDefaultOperation(parsed.spec, key);
    setText(JSON.stringify(nextSpec, null, 2));
    setDirty(true);
    setStatus({
      type: 'success',
      message: key
        ? `Marked "${key}" as the default health-check call for this model. Save to persist it.`
        : 'Unmarked the default health-check call for this model. Save to persist it.',
    });
  };

  const handleCloseSaveModal = () => {
    const wasSuccess = saveModal && saveModal.result && saveModal.result.success;
    setSaveModal(null);
    setStatus(wasSuccess
      ? { type: 'success', message: 'Model updated via Itential\'s sanctioned process.' }
      : null);
  };

  const activeModel = models.find((m) => m.id === activeId);

  return (
    <div className="app-shell">
      <Sidebar models={models} activeId={isNewModel ? null : activeId} onSelect={handleSelect} onNewModel={handleNewModel} />

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{isNewModel ? 'New Integration Model' : (activeModel ? activeModel.title : 'OpenAPI Editor')}</h1>
            {isNewModel && <span className="pill pill-dirty">Not yet created</span>}
            {!isNewModel && meta && <span className="topbar-subtitle">{meta.versionId}</span>}
            {parsed.spec && parsed.spec.openapi && (
              <span className="pill pill-oas">OpenAPI {parsed.spec.openapi}</span>
            )}
          </div>
          <div className="topbar-actions">
            {demoMode && <span className="pill pill-demo">Demo data</span>}
            {dirty && <span className="pill pill-dirty">Unsaved changes</span>}
            <button type="button" className="btn btn-secondary" onClick={handleValidate} disabled={busy}>
              Validate
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={busy}>
              {isNewModel ? 'Create Model' : 'Save'}
            </button>
          </div>
        </header>

        {status && (
          <div className={`status-banner status-${status.type}`}>{status.message}</div>
        )}

        <div className="split-view">
          <Editor value={text} onChange={handleChange} error={parsed.error} />
          <div className="right-pane">
            <div className="right-pane-tabs">
              <button
                type="button"
                className={`right-pane-tab ${rightTab === 'preview' ? 'active' : ''}`}
                onClick={() => setRightTab('preview')}
              >
                Preview
              </button>
              <button
                type="button"
                className={`right-pane-tab ${rightTab === 'operations' ? 'active' : ''}`}
                onClick={() => setRightTab('operations')}
              >
                Operations
              </button>
              <button
                type="button"
                className={`right-pane-tab ${rightTab === 'test' ? 'active' : ''}`}
                onClick={() => setRightTab('test')}
              >
                Test
              </button>
            </div>
            {rightTab === 'preview' && <Preview spec={parsed.spec} parseError={parsed.error} />}
            {rightTab === 'operations' && (
              <Operations spec={parsed.spec} onApply={handleApplyCleanup} onSetDefault={handleSetDefault} disabled={busy} />
            )}
            {rightTab === 'test' && <TestPanel spec={parsed.spec} />}
          </div>
        </div>
      </div>

      {saveModal && (
        <SaveConfirmModal
          impact={saveModal.impact}
          result={saveModal.result}
          saving={saveModal.saving}
          onConfirm={handleConfirmSave}
          onCancel={handleCloseSaveModal}
        />
      )}
    </div>
  );
}
