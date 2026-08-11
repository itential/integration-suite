import React, { useMemo, useState } from 'react';
import itentialMark from '../assets/itential-icon.png';

export default function Sidebar({ models, activeId, onSelect, onNewModel }) {
  const [query, setQuery] = useState('');

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

      <button type="button" className="btn btn-primary sidebar-new-model-btn" onClick={onNewModel}>
        + New Model
      </button>

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
