import React, { useMemo, useRef, useState } from 'react';
import itentialMark from '../assets/itential-icon.png';

export default function Sidebar({ models, activeId, onSelect, onNewModel, onImportModel }) {
  const [query, setQuery] = useState('');
  const importInputRef = useRef(null);

  const handleImportFileChosen = (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-choosing the same file later
    if (file) onImportModel(file);
  };

  const filtered = useMemo(() => {
    if (!query.trim()) return models;
    const q = query.toLowerCase();
    return models.filter((m) => (m.title || '').toLowerCase().includes(q));
  }, [models, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <a href="/" className="sidebar-brand-mark-link" title="Back to Itential Platform">
          <img className="sidebar-brand-mark" src={itentialMark} alt="Itential" />
        </a>
        <div>
          <div className="sidebar-brand-title">OpenAPI Editor</div>
          <div className="sidebar-brand-sub">Integration Models</div>
        </div>
      </div>

      <div className="sidebar-new-model-row">
        <button type="button" className="btn btn-primary sidebar-new-model-btn" onClick={onNewModel}>
          + New Model
        </button>
        <button
          type="button"
          className="btn btn-secondary sidebar-new-model-btn"
          onClick={() => importInputRef.current && importInputRef.current.click()}
          title="Import an OpenAPI document from a local file into the editor as a new draft model"
        >
          Import
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={handleImportFileChosen}
        />
      </div>

      <div className="sidebar-search">
        <input
          type="text"
          placeholder="Search models..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <nav className="sidebar-list">
        {filtered.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`sidebar-item ${m.id === activeId ? 'active' : ''}`}
            onClick={() => onSelect(m.id)}
          >
            <span className="sidebar-item-title">{m.title || 'Untitled model'}</span>
            <span className="sidebar-item-version">v{m.version}</span>
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="sidebar-empty">No models match &quot;{query}&quot;</div>
        )}
      </nav>
    </aside>
  );
}
