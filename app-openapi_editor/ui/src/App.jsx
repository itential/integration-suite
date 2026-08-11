import React, { useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import Preview from './components/Preview';
import Operations, { applyRemovals, setDefaultOperation } from './components/Operations';
import TestPanel from './components/TestPanel';
import IntegrationInstances from './components/IntegrationInstances';
import Splitter from './components/Splitter';
import SaveConfirmModal from './components/SaveConfirmModal';
import DeleteConfirmModal from './components/DeleteConfirmModal';
import * as api from './api';
import { downloadJson, readJsonFile } from './util/download';
import { annotateValidationErrors } from './util/validateHints';
import { MOCK_MODELS, MOCK_SPEC, MOCK_META } from './mockData';

// A brand-new/imported/restored model has no roles/groups authorized to use
// it yet - that's a separate, deliberate admin step Platform requires
// (Admin Essentials -> Authorization), not something this app can or
// should do on the user's behalf. Shown after every action that creates a
// model Platform doesn't already know about.
const AUTH_REMINDER = 'To use this model, authorize the appropriate user(s)/group(s) under '
  + 'Admin Essentials → Authorization. Please speak with your Itential System Administrator.';

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

// Sizable panels: reads/writes a percentage (0-100) to localStorage so the
// split persists across reloads, clamped to keep both sides usable.
function useSplitPct(key, defaultPct, min = 15, max = 85) {
  const [pct, setPct] = useState(() => {
    const saved = Number(window.localStorage.getItem(key));
    return saved >= min && saved <= max ? saved : defaultPct;
  });
  const containerRef = useRef(null);
  const resizeBy = (deltaPx) => {
    setPct((prev) => {
      const containerWidth = (containerRef.current && containerRef.current.offsetWidth) || 1000;
      const next = Math.min(max, Math.max(min, prev + (deltaPx / containerWidth) * 100));
      window.localStorage.setItem(key, String(next));
      return next;
    });
  };
  return [pct, resizeBy, containerRef];
}

export default function App() {
  const [models, setModels] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [text, setText] = useState('');
  const [mainSplitPct, resizeMainSplit, mainSplitRef] = useSplitPct('oe:mainSplitPct', 50);
  // Itential/Mongo bookkeeping fields (_id, versionId) - NOT part of the
  // OpenAPI spec, so they're kept out of the editable JSON entirely and
  // only re-attached server-side (see saveModel in src.js) when writing
  // back to Mongo.
  const [meta, setMeta] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'success'|'error'|'info', message }
  const [demoMode, setDemoMode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rightTab, setRightTab] = useState('preview'); // 'preview' | 'operations' | 'test' | 'instances'
  const [saveModal, setSaveModal] = useState(null); // { impact, result, saving } | null
  const [deleteModal, setDeleteModal] = useState(null); // { impact, result, deleting } | null
  const [validationDiagnostics, setValidationDiagnostics] = useState(null);
  const restoreInputRef = useRef(null);
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

  // Reads a local OpenAPI JSON file and opens it as a new (not-yet-created)
  // draft model, the same way handleNewModel opens a blank one - nothing is
  // created on Platform until Save/Create Model is clicked. Only a shallow
  // sanity check (openapi + paths present) is done here; full validation
  // still happens via the Validate button, same as any hand-edited spec.
  const handleImportModel = async (file) => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    try {
      const imported = await readJsonFile(file);
      if (!imported || !imported.openapi || !imported.paths) {
        throw new Error('This file doesn\'t look like an OpenAPI document (expected "openapi" and "paths" fields).');
      }
      setIsNewModel(true);
      setActiveId(null);
      setMeta(null);
      setText(JSON.stringify(imported, null, 2));
      setDirty(true);
      setValidationDiagnostics(null);
      setStatus({ type: 'success', message: `Imported "${file.name}" into the editor as a new draft. Review it, then Create Model to save it to Platform.` });
    } catch (err) {
      setStatus({ type: 'error', message: `Import failed: ${err.message}` });
    }
  };

  const handleChange = (value) => {
    setText(value);
    setDirty(true);
    setStatus(null);
    setValidationDiagnostics(null);
  };

  const handleValidate = async () => {
    setValidationDiagnostics(null);
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
      if (result.valid) {
        setStatus({ type: 'success', message: 'Document is a valid OpenAPI spec.' });
        return;
      }
      // Best-effort: approximate line numbers + a blocking/minor/unknown
      // severity guess per error (see util/validateHints.js) - swagger-
      // parser only returns plain message strings, so this is a heuristic,
      // not an exact source map. Shown as gutter markers in the editor and
      // as a per-error breakdown in the status banner.
      const annotated = annotateValidationErrors(result.errors, text);
      setValidationDiagnostics(annotated);
      const blockingCount = annotated.filter((d) => d.severity === 'blocking').length;
      const minorCount = annotated.filter((d) => d.severity === 'minor').length;
      const summary = `${annotated.length} issue${annotated.length === 1 ? '' : 's'} found`
        + (blockingCount ? ` — ${blockingCount} likely blocking` : '')
        + (minorCount ? `, ${minorCount} likely minor (won't affect use)` : '')
        + '.';
      setStatus({ type: 'error', message: summary, validationErrors: annotated });
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setBusy(false);
    }
  };

  // --- Backup / Restore / Delete (toolbar) --------------------------------

  const handleBackup = async () => {
    if (!activeId || isNewModel) return;
    setBusy(true);
    try {
      const backup = await api.getFullBackup(activeId);
      const safeName = String(backup.meta.versionId).replace(/[^a-z0-9._-]+/gi, '_');
      downloadJson(`${safeName}-FULL-backup-${Date.now()}.json`, backup);
      setStatus({ type: 'success', message: `Downloaded full backup of "${backup.meta.versionId}" (model + ${backup.integrations.length} instance${backup.integrations.length === 1 ? '' : 's'}).` });
    } catch (err) {
      setStatus({ type: 'error', message: `Backup failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreFileChosen = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow choosing the same file again later
    if (!file) return;
    setBusy(true);
    setStatus(null);
    try {
      const backup = await readJsonFile(file);
      if (!backup || !backup.model || !backup.model.openapi) {
        throw new Error('This file doesn\'t look like a model backup produced by this app (expected a "model" key with an OpenAPI document).');
      }
      const result = await api.restoreFromBackup(backup);
      setStatus(result.success
        ? { type: 'success', message: `Restored "${result.versionId}" and its integration instances. ${AUTH_REMINDER}` }
        : { type: 'error', message: `Restore only partially completed for "${result.versionId}": ${result.errors.join('; ')}` });
      const updated = await api.listModels();
      setModels(updated);
      if (result.versionId) setActiveId(result.versionId);
    } catch (err) {
      setStatus({ type: 'error', message: `Restore failed: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!activeId || isNewModel) return;
    setBusy(true);
    try {
      const impact = await api.getUpdateImpact(activeId);
      setDeleteModal({ impact, result: null, deleting: false });
    } catch (err) {
      setStatus({ type: 'error', message: `Couldn't preview what deleting this model would affect: ${err.message}` });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleteModal((prev) => ({ ...prev, deleting: true }));
    try {
      const result = await api.deleteModelAndInstances(activeId);
      setDeleteModal((prev) => ({ ...prev, result, deleting: false }));
      if (result.success) {
        const updated = await api.listModels();
        setModels(updated);
        setActiveId(updated.length ? updated[0].id : null);
      }
    } catch (err) {
      setDeleteModal((prev) => ({
        ...prev,
        deleting: false,
        result: { success: false, steps: [], errors: [err.message] },
      }));
    }
  };

  const handleCloseDeleteModal = () => {
    setDeleteModal(null);
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
        message: `Model "${result.versionId}" created. Use the new Integration Instances tab (or Itential Platform's `
          + 'normal process, e.g. Admin Essentials -> Integrations -> Add) to create an instance against it. '
          + AUTH_REMINDER,
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
      <Sidebar
        models={models}
        activeId={isNewModel ? null : activeId}
        onSelect={handleSelect}
        onNewModel={handleNewModel}
        onImportModel={handleImportModel}
      />

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
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleValidate}
              disabled={busy}
              title="Cursory check of the validity of the open model"
            >
              Validate
            </button>
            {!isNewModel && !demoMode && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleBackup}
                  disabled={busy || !activeId}
                  title="Perform local backup of model and associated instances"
                >
                  Backup
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => restoreInputRef.current && restoreInputRef.current.click()}
                  disabled={busy}
                  title="Restore model and instances using local backup file"
                >
                  Restore
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json"
                  style={{ display: 'none' }}
                  onChange={handleRestoreFileChosen}
                />
              </>
            )}
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSave}
              disabled={busy}
              title="Save updates to model (perform model and instance updates)"
            >
              {isNewModel ? 'Create Model' : 'Save'}
            </button>
            {!isNewModel && !demoMode && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDelete}
                disabled={busy || !activeId}
                title="Delete model and associated instances"
              >
                Delete
              </button>
            )}
          </div>
        </header>

        {status && (
          <div className={`status-banner status-${status.type}`}>
            <div>{status.message}</div>
            {status.validationErrors && (
              <>
                <ul className="validation-error-list">
                  {status.validationErrors.map((d, idx) => (
                    <li key={idx} className={`validation-error-item validation-${d.severity}`}>
                      <span className="validation-error-badge">
                        {d.severity === 'blocking' ? 'Likely blocking' : d.severity === 'minor' ? 'Likely minor' : 'Unclear impact'}
                      </span>
                      {d.line && <span className="validation-error-line">Line {d.line}</span>}
                      <span className="validation-error-message">{d.message}</span>
                    </li>
                  ))}
                </ul>
                <div className="validation-caveat">
                  A failed validation does not necessarily mean the model or its integration instances won&apos;t
                  work - Itential Platform is often more lenient at runtime than strict OpenAPI validation.
                  Treat this as a signal to test the model&apos;s actual behavior (e.g. via an Integration
                  Instance) rather than a guarantee it&apos;s unusable, especially for issues marked
                  &quot;likely minor&quot; or &quot;unclear impact&quot; above.
                </div>
              </>
            )}
          </div>
        )}

        <div className="split-view" ref={mainSplitRef}>
          <Editor
            value={text}
            onChange={handleChange}
            error={parsed.error}
            validationDiagnostics={validationDiagnostics}
            style={{ flex: 'none', width: `${mainSplitPct}%` }}
          />
          <Splitter onResize={resizeMainSplit} />
          <div className="right-pane" style={{ flex: 'none', width: `${100 - mainSplitPct}%` }}>
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
              <button
                type="button"
                className={`right-pane-tab ${rightTab === 'instances' ? 'active' : ''}`}
                onClick={() => setRightTab('instances')}
                disabled={isNewModel}
              >
                Integration Instances
              </button>
            </div>
            {rightTab === 'preview' && <Preview spec={parsed.spec} parseError={parsed.error} />}
            {rightTab === 'operations' && (
              <Operations spec={parsed.spec} onApply={handleApplyCleanup} onSetDefault={handleSetDefault} disabled={busy} />
            )}
            {rightTab === 'test' && <TestPanel spec={parsed.spec} />}
            {rightTab === 'instances' && !isNewModel && (
              <IntegrationInstances versionId={meta && meta.versionId} disabled={busy} />
            )}
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

      {deleteModal && (
        <DeleteConfirmModal
          versionId={deleteModal.impact.versionId}
          associatedIntegrations={deleteModal.impact.associatedIntegrations}
          backup={deleteModal.impact.backup}
          result={deleteModal.result}
          deleting={deleteModal.deleting}
          onConfirm={handleConfirmDelete}
          onCancel={handleCloseDeleteModal}
        />
      )}
    </div>
  );
}
