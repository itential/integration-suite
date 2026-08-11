import React, { useState } from 'react';
import { downloadJson } from '../util/download';

function StepRow({ step }) {
  return (
    <div className={`save-step ${step.ok ? 'save-step-ok' : 'save-step-fail'}`}>
      <span className="save-step-icon">{step.ok ? '✓' : '✗'}</span>
      <span className="save-step-name">{step.name}</span>
      {step.detail && <span className="save-step-detail">{step.detail}</span>}
    </div>
  );
}

// Big, deliberately hard-to-click-through-by-accident confirmation for
// deleting a model AND every integration instance built from it. Requires
// retyping the model's own versionId (e.g. "IAP:1.0.12", exactly as shown)
// before the actual Delete button is even enabled - modeled on the same
// pattern GitHub/similar tools use for "type the repo name to confirm"
// destructive actions, since this is the most destructive single action in
// this whole app.
export default function DeleteConfirmModal({ versionId, associatedIntegrations, backup, result, deleting, onConfirm, onCancel }) {
  const [confirmText, setConfirmText] = useState('');
  const integrations = associatedIntegrations || [];
  const matches = confirmText.trim() === versionId;

  const safeName = () => String(versionId).replace(/[^a-z0-9._-]+/gi, '_');

  const handleDownloadFullBackup = () => {
    if (!backup) return;
    downloadJson(`${safeName()}-FULL-backup-${Date.now()}.json`, backup);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal delete-confirm-modal">
        <h2>{result ? 'Delete result' : 'Delete integration model'}</h2>

        {!result && (
          <>
            <div className="status-banner status-error delete-warning">
              <strong>This permanently deletes the model &quot;{versionId}&quot;</strong>
              {integrations.length > 0 && (
                <>
                  {' '}and <strong>all {integrations.length} associated integration instance{integrations.length === 1 ? '' : 's'}</strong> built from it
                </>
              )}. This is not the same as Save - there is no automatic reapply/recreate afterward.
              Download the full backup below before continuing; it&apos;s the only way to restore
              {integrations.length > 0 ? ' the model and these instances' : ' the model'} afterward (via the Restore button).
            </div>

            {integrations.length > 0 && (
              <div className="save-affected-list">
                <div className="save-affected-title">Integration instances that will be deleted</div>
                <ul>
                  {integrations.map((i) => (
                    <li key={i.name}>
                      <span className="save-affected-name">{i.name}</span>
                      {i.description && <span className="save-affected-desc"> — {i.description}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="save-download-group">
              <button type="button" className="btn btn-secondary save-download-btn" onClick={handleDownloadFullBackup}>
                Download full backup (model + instances) — recommended
              </button>
            </div>

            <label className="delete-confirm-label" htmlFor="delete-confirm-input">
              Type <code>{versionId}</code> to confirm:
            </label>
            <input
              id="delete-confirm-input"
              type="text"
              className="delete-confirm-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={versionId}
              autoComplete="off"
              disabled={deleting}
            />

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={deleting}>Cancel</button>
              <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={deleting || !matches}>
                {deleting ? 'Deleting…' : 'Permanently Delete'}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div className={`status-banner ${result.success ? 'status-success' : 'status-error'}`}>
              {result.success
                ? 'Model and its integration instances were deleted.'
                : 'Something failed partway through - see steps below. A backup is available so nothing is lost.'}
            </div>
            <div className="save-steps">
              {result.steps.map((step, idx) => <StepRow key={`${step.name}-${idx}`} step={step} />)}
            </div>
            <div className="save-download-group">
              <button type="button" className="btn btn-secondary save-download-btn" onClick={handleDownloadFullBackup}>
                Download full backup (model + instances)
              </button>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onCancel}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
