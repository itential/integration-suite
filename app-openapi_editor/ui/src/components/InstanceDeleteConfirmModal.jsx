import React, { useState } from 'react';
import { downloadJson } from '../util/download';

// Same "retype the name to confirm" pattern as the model-level
// DeleteConfirmModal, scaled down to a single integration instance -
// requires retyping the instance's own name before Delete enables, and
// offers a one-click backup download of its current properties first.
export default function InstanceDeleteConfirmModal({ instance, deleting, onConfirm, onCancel }) {
  const [confirmText, setConfirmText] = useState('');
  const matches = confirmText.trim() === instance.name;

  const handleDownload = () => {
    const safeName = instance.name.replace(/[^a-z0-9._-]+/gi, '_');
    downloadJson(`${safeName}-instance-backup-${Date.now()}.json`, instance);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal delete-confirm-modal">
        <h2>Delete integration instance</h2>
        <div className="status-banner status-error delete-warning">
          <strong>This permanently deletes the integration instance &quot;{instance.name}&quot;.</strong>{' '}
          Download a backup below before continuing if you haven&apos;t already - it&apos;s the only way to restore it afterward (via Restore).
        </div>
        <div className="save-download-group">
          <button type="button" className="btn btn-secondary save-download-btn" onClick={handleDownload}>
            Download backup
          </button>
        </div>
        <label className="delete-confirm-label" htmlFor="instance-delete-confirm-input">
          Type <code>{instance.name}</code> to confirm:
        </label>
        <input
          id="instance-delete-confirm-input"
          type="text"
          className="delete-confirm-input"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={instance.name}
          autoComplete="off"
          disabled={deleting}
        />
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleting}>Cancel</button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleting || !matches}>
            {deleting ? 'Deleting…' : 'Permanently Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
