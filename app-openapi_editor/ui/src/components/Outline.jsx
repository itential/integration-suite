import React, { useEffect, useState } from 'react';
import * as api from '../api';

/**
 * Block outline + macro browser (solution design §4): shows the resolved
 * extends chain, which template originally defined each {% block %} and
 * which descendant(s) override it, and the signatures of {% macro %}s
 * defined directly in this template - so a page author importing a
 * macro-library gets a quick reference instead of opening the source.
 */
export default function Outline({ template }) {
  const [outline, setOutline] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setOutline(null);
    setError(null);
    api.getOutline(template.name)
      .then((result) => { if (!cancelled) setOutline(result); })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [template.name, template.body]);

  if (error) return <div className="status-banner status-error">{error}</div>;
  if (!outline) return <div className="form-hint">Loading outline...</div>;

  return (
    <div className="outline-pane">
      <div className="outline-section">
        <h3>Extends chain</h3>
        <div className="outline-chain">{outline.chain.join(' -> ') || '(none)'}</div>
      </div>

      <div className="outline-section">
        <h3>Blocks</h3>
        {outline.blocks.length === 0 && <div className="form-hint">No {'{% block %}'} tags found in this chain.</div>}
        {outline.blocks.map((b) => (
          <div key={b.name} className="outline-block-row">
            <span className="outline-block-name">{b.name}</span>
            <span className="outline-block-defined">defined in {b.definedIn}</span>
            {b.overridden && (
              <span className="outline-block-overridden">overridden by {b.overriddenBy.join(', ')}</span>
            )}
          </div>
        ))}
      </div>

      <div className="outline-section">
        <h3>Macros defined here</h3>
        {outline.macros.length === 0 && <div className="form-hint">No {'{% macro %}'} tags defined directly in this template.</div>}
        {outline.macros.map((m) => (
          <div key={m.name} className="outline-macro-row">
            <code>
              {m.name}(
              {m.args.map((a) => (a.default ? `${a.name}=${a.default}` : a.name)).join(', ')}
              {m.hasKwargs ? (m.args.length ? ', **kwargs' : '**kwargs') : ''}
              )
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}
