import React from 'react';

// Triggers a browser download of the given data as a JSON file - used for
// the "download a backup before saving" option. Everything needed to
// manually recreate the model and its integration instances (if the
// automated process below fails partway) is in this payload.
function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function StepRow({ step }) {
  return (
    <div className={`save-step ${step.ok ? 'save-step-ok' : 'save-step-fail'}`}>
      <span className="save-step-icon">{step.ok ? '✓' : '✗'}</span>
      <span className="save-step-name">{step.name}</span>
      {step.detail && <span className="save-step-detail">{step.detail}</span>}
    </div>
  );
}

export default function SaveConfirmModal({ impact, result, saving, onConfirm, onCancel }) {
  const integrations = (impact && impact.associatedIntegrations) || [];
  const backupData = result ? result.backup : (impact && impact.backup);
  const backupIntegrations = (backupData && backupData.integrations) || [];

  const safeName = () => {
    const versionId = (impact && impact.versionId) || (backupData && backupData.meta && backupData.meta.versionId) || 'integration-model';
    return String(versionId).replace(/[^a-z0-9._-]+/gi, '_');
  };

  const handleDownloadModel = () => {
    if (!backupData) return;
    downloadJson(`${safeName()}-model-backup-${Date.now()}.json`, {
      model: backupData.model,
      meta: backupData.meta,
    });
  };

  const handleDownloadInstances = () => {
    if (!backupData) return;
    downloadJson(`${safeName()}-instances-backup-${Date.now()}.json`, {
      meta: backupData.meta,
      integrations: backupIntegrations,
    });
  };

  return (
    <div className="modal-backdrop">
      <div className="modal save-confirm-modal">
        <h2>{result ? 'Save result' : 'Confirm model update'}</h2>

        {!result && (
          <>
            <p className="save-warning">
              Saving will <strong>delete the current model definition</strong>
              {integrations.length > 0 && (
                <>
                  {' '}and <strong>{integrations.length} associated integration instance{integrations.length === 1 ? '' : 's'}</strong>
                </>
              )}, then automatically reapply the updated model and recreate
              {integrations.length > 0 ? ' those instances' : ' it'} - this is
              Itential Platform&apos;s own sanctioned update process (a plain
              database write skips it entirely, which is what led to this).
            </p>

            {integrations.length > 0 && (
              <div className="save-affected-list">
                <div className="save-affected-title">Affected integration instances</div>
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
              <button type="button" className="btn btn-secondary save-download-btn" onClick={handleDownloadModel}>
                Download model backup (recommended)
              </button>
              <button
                type="button"
                className="btn btn-secondary save-download-btn"
                onClick={handleDownloadInstances}
                disabled={backupIntegrations.length === 0}
              >
                Download integration instance backup{backupIntegrations.length === 1 ? '' : 's'}
                {backupIntegrations.length > 0 ? ` (${backupIntegrations.length})` : ' (none)'}
              </button>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={saving}>
                {saving ? 'Saving…' : 'Confirm & Save'}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div className={`status-banner ${result.success ? 'status-success' : 'status-error'}`}>
              {result.success
                ? 'Model updated successfully via the sanctioned process.'
                : 'Something failed partway through - see steps below. A backup is available so nothing is lost.'}
            </div>

            <div className="save-steps">
              {result.steps.map((step, idx) => <StepRow key={`${step.name}-${idx}`} step={step} />)}
            </div>

            <div className="save-download-group">
              <button type="button" className="btn btn-secondary save-download-btn" onClick={handleDownloadModel}>
                Download model backup
              </button>
              <button
                type="button"
                className="btn btn-secondary save-download-btn"
                onClick={handleDownloadInstances}
                disabled={backupIntegrations.length === 0}
              >
                Download integration instance backup{backupIntegrations.length === 1 ? '' : 's'}
                {backupIntegrations.length > 0 ? ` (${backupIntegrations.length})` : ' (none)'}
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
