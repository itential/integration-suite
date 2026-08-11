import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from './Editor';
import CreateInstanceModal from './CreateInstanceModal';
import InstanceDeleteConfirmModal from './InstanceDeleteConfirmModal';
import Splitter from './Splitter';
import * as api from '../api';
import { downloadJson, readJsonFile } from '../util/download';

const LIST_WIDTH_KEY = 'oe:instancesListWidthPx';
const LIST_WIDTH_MIN = 160;
const LIST_WIDTH_MAX = 480;

// Lists every Integration instance built from the current model (via
// api.listIntegrationInstances -> the same direct-to-Platform GET
// /integrations call saveModel/getUpdateImpact already use), lets you
// create a new one, open one in a JSON editor below the list, back it up,
// restore one from a local backup file, and save edits back via
// api.updateIntegrationInstance - all browser -> Platform REST, no cog/
// Mongo involved. See api.js for the caveats on updateIntegrationInstance's
// request shape (not yet confirmed live the way create/delete were).
export default function IntegrationInstances({ versionId, disabled }) {
  const [instances, setInstances] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [selectedName, setSelectedName] = useState(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // instance object | null
  const [deleting, setDeleting] = useState(false);
  const restoreInputRef = useRef(null);
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem(LIST_WIDTH_KEY));
    return saved >= LIST_WIDTH_MIN && saved <= LIST_WIDTH_MAX ? saved : 260;
  });
  const resizeList = (deltaPx) => {
    setListWidth((prev) => {
      const next = Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, prev + deltaPx));
      window.localStorage.setItem(LIST_WIDTH_KEY, String(next));
      return next;
    });
  };

  const loadInstances = () => {
    if (!versionId) return;
    setLoading(true);
    setLoadError(null);
    api.listIntegrationInstances(versionId)
      .then((list) => setInstances(list))
      .catch((err) => setLoadError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setSelectedName(null);
    setText('');
    setDirty(false);
    setStatus(null);
    loadInstances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  const selected = useMemo(
    () => instances.find((i) => i.name === selectedName) || null,
    [instances, selectedName],
  );

  const parsed = useMemo(() => {
    try {
      return { doc: text ? JSON.parse(text) : null, error: null };
    } catch (err) {
      return { doc: null, error: err.message };
    }
  }, [text]);

  const handleSelect = (instance) => {
    if (dirty && !window.confirm('Discard unsaved changes to this instance?')) return;
    setSelectedName(instance.name);
    setText(JSON.stringify(instance, null, 2));
    setDirty(false);
    setStatus(null);
  };

  const handleChange = (value) => {
    setText(value);
    setDirty(true);
    setStatus(null);
  };

  const handleDownloadBackup = () => {
    if (!selected) return;
    const safeName = selected.name.replace(/[^a-z0-9._-]+/gi, '_');
    downloadJson(`${safeName}-instance-backup-${Date.now()}.json`, selected);
  };

  const handleCreate = async (name) => {
    setCreating(true);
    try {
      await api.createIntegrationInstance(name, versionId);
      setShowCreate(false);
      setStatus({ type: 'success', message: `Created "${name}". Fill in its connection details below, then Save Instance.` });
      await new Promise((resolve) => { loadInstances(); resolve(); });
      setSelectedName(name);
    } catch (err) {
      setStatus({ type: 'error', message: `Create failed: ${err.message}` });
    } finally {
      setCreating(false);
    }
  };

  const handleRestoreFileChosen = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    setSaving(true);
    setStatus(null);
    try {
      const backup = await readJsonFile(file);
      if (!backup || !backup.name) {
        throw new Error('This file doesn\'t look like an instance backup (expected a "name" field).');
      }
      await api.restoreIntegrationInstance(backup);
      setStatus({ type: 'success', message: `Restored "${backup.name}".` });
      loadInstances();
    } catch (err) {
      setStatus({ type: 'error', message: `Restore failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    if (parsed.error || !parsed.doc) {
      setStatus({ type: 'error', message: `Invalid JSON: ${parsed.error || 'empty document'}` });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      await api.updateIntegrationInstance(selected.name, parsed.doc);
      setStatus({ type: 'success', message: `Saved "${selected.name}".` });
      setDirty(false);
      loadInstances();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteIntegrationInstance(deleteTarget.name);
      setStatus({ type: 'success', message: `Deleted "${deleteTarget.name}".` });
      setDeleteTarget(null);
      setSelectedName(null);
      setText('');
      setDirty(false);
      loadInstances();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="integration-instances-pane">
      <div className="integration-instances-list" style={{ width: `${listWidth}px` }}>
        <div className="integration-instances-list-header">
          <span>Integration Instances{instances.length > 0 ? ` (${instances.length})` : ''}</span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              type="button"
              className="btn btn-primary btn-small"
              onClick={() => setShowCreate(true)}
              disabled={disabled || !versionId}
              title="Create a new integration instance"
            >
              + Create
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={loadInstances} disabled={loading || disabled}>
              Refresh
            </button>
          </div>
        </div>
        {loading && <div className="integration-instances-empty">Loading…</div>}
        {loadError && <div className="status-banner status-error">{loadError}</div>}
        {!loading && !loadError && instances.length === 0 && (
          <div className="integration-instances-empty">No integration instances use this model.</div>
        )}
        <ul>
          {instances.map((instance) => (
            <li key={instance.name}>
              <button
                type="button"
                className={`integration-instance-item ${selectedName === instance.name ? 'active' : ''}`}
                onClick={() => handleSelect(instance)}
                disabled={disabled}
              >
                <span className="integration-instance-name">{instance.name}</span>
                {instance.description && <span className="integration-instance-desc">{instance.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <Splitter onResize={resizeList} />

      <div className="integration-instances-detail">
        {!selected && <div className="integration-instances-empty">Select an integration instance to view and edit it, or Create a new one.</div>}
        {selected && (
          <>
            <div className="integration-instances-detail-toolbar">
              <span className="topbar-subtitle">{selected.name}</span>
              {dirty && <span className="pill pill-dirty">Unsaved changes</span>}
              <div className="topbar-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleDownloadBackup}
                  disabled={saving}
                  title="Backup individual instance properties"
                >
                  Backup
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => restoreInputRef.current && restoreInputRef.current.click()}
                  disabled={saving}
                  title="Restore from backed up instance properties file"
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
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !dirty}
                  title="Save changes made to the instance"
                >
                  {saving ? 'Saving…' : 'Save Instance'}
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setDeleteTarget(selected)}
                  disabled={saving}
                  title="Delete integration instance"
                >
                  Delete
                </button>
              </div>
            </div>
            {status && <div className={`status-banner status-${status.type}`}>{status.message}</div>}
            <div className="integration-instances-editor">
              <Editor value={text} onChange={handleChange} error={parsed.error} />
            </div>
          </>
        )}
        {!selected && status && <div className={`status-banner status-${status.type}`}>{status.message}</div>}
      </div>

      {showCreate && (
        <CreateInstanceModal
          versionId={versionId}
          existingNames={instances.map((i) => i.name)}
          creating={creating}
          onConfirm={handleCreate}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {deleteTarget && (
        <InstanceDeleteConfirmModal
          instance={deleteTarget}
          deleting={deleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
