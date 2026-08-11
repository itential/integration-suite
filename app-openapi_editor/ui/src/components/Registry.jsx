import React, { useEffect, useState } from 'react';
import * as api from '../api';

/**
 * Admin screen to register custom filters/tests/globals (solution design
 * §4 "Filter/test/global registry UI"). Deliberately offers no free-form
 * code entry - only a name plus a pick from the vetted implementation
 * catalog (lib/registryCatalog.js on the server), since rendering runs
 * in-process with the rest of the platform and arbitrary template-author
 * code would be a real privilege-escalation risk, not just a footgun.
 */
export default function Registry({ onClose }) {
  const [entries, setEntries] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [name, setName] = useState('');
  const [catalogKey, setCatalogKey] = useState('');
  const [error, setError] = useState(null);

  function refresh() {
    Promise.all([api.listRegistryEntries(), api.getRegistryCatalog()])
      .then(([e, c]) => { setEntries(e); setCatalog(c); if (!catalogKey && c.length) setCatalogKey(c[0].key); })
      .catch((err) => setError(err.message));
  }

  useEffect(() => { refresh(); }, []);

  function handleAdd() {
    const chosen = catalog.find((c) => c.key === catalogKey);
    if (!name.trim() || !chosen) return;
    api.createRegistryEntry({ name: name.trim(), kind: chosen.kind, catalogKey })
      .then(() => { setName(''); refresh(); })
      .catch((err) => setError(err.message));
  }

  function handleDelete(id) {
    api.deleteRegistryEntry(id).then(refresh).catch((err) => setError(err.message));
  }

  return (
    <div className="registry-panel">
      <div className="registry-header">
        <h2>Filter / Test / Global Registry</h2>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Back to templates</button>
      </div>
      <p className="form-hint">
        Register a name for one of the vetted, admin-curated implementations below - there is no free-form code
        entry, by design.
      </p>
      {error && <div className="status-banner status-error">{error}</div>}

      <div className="registry-add-row">
        <input
          type="text"
          placeholder="Name template authors will use (e.g. snake_case)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select value={catalogKey} onChange={(e) => setCatalogKey(e.target.value)}>
          {catalog.map((c) => (
            <option key={c.key} value={c.key}>{`[${c.kind}] ${c.label}`}</option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={handleAdd}>Register</button>
      </div>

      <table className="registry-table">
        <thead>
          <tr><th>Name</th><th>Kind</th><th>Implementation</th><th /></tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const catalogEntry = catalog.find((c) => c.key === e.catalogKey);
            return (
              <tr key={e._id}>
                <td><code>{e.name}</code></td>
                <td>{e.kind}</td>
                <td>{catalogEntry ? catalogEntry.label : e.catalogKey}</td>
                <td><button type="button" className="link-button" onClick={() => handleDelete(e._id)}>Remove</button></td>
              </tr>
            );
          })}
          {entries.length === 0 && (
            <tr><td colSpan={4} className="form-hint">No registry entries yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
