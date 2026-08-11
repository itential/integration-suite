import React, { useState } from 'react';

// Small modal collecting just the new instance's name - everything else in
// the generic create payload (type: "Adapter", properties.id, properties.
// type) is derived automatically from that name and the current model's
// versionId (see api.js#createIntegrationInstance).
export default function CreateInstanceModal({ versionId, existingNames, creating, onConfirm, onCancel }) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const isDuplicate = existingNames.includes(trimmed);
  const isValid = trimmed.length > 0 && !isDuplicate;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Create integration instance</h2>
        <p>
          Creates a new, minimal integration instance against <code>{versionId}</code>.
          You can fill in its connection details afterward in the instance editor, then Save Instance.
        </p>
        <label className="delete-confirm-label" htmlFor="create-instance-name">Instance name</label>
        <input
          id="create-instance-name"
          type="text"
          className="delete-confirm-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. my_new_instance"
          autoComplete="off"
          disabled={creating}
        />
        {isDuplicate && <div className="status-banner status-error">An instance named &quot;{trimmed}&quot; already exists.</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={creating}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onConfirm(trimmed)} disabled={creating || !isValid}>
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
