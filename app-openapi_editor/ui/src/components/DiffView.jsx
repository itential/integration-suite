import React, { useState } from 'react';
import * as api from '../api';

/**
 * Diff view (solution design §5): compares two saved scenario outputs, or a
 * saved scenario against a fresh render of the current in-editor draft body
 * (pass 'current') - flags unintended whitespace/content changes when a
 * shared partial changes underneath a page.
 */
export default function DiffView({ template, scenarios, draftBody, draftContext }) {
  const options = ['current', ...scenarios.map((s) => s.name)];
  const [left, setLeft] = useState(options[1] || 'current');
  const [right, setRight] = useState('current');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);

  function runDiff() {
    setRunning(true);
    setError(null);
    api.diffScenarios(template.name, left, right, draftBody, draftContext)
      .then((result) => { setDiff(result); setRunning(false); })
      .catch((err) => { setError(err.message); setRunning(false); });
  }

  return (
    <div className="diff-pane">
      <div className="diff-controls">
        <select value={left} onChange={(e) => setLeft(e.target.value)}>
          {options.map((o) => <option key={o} value={o}>{o === 'current' ? 'Current draft' : o}</option>)}
        </select>
        <span>vs</span>
        <select value={right} onChange={(e) => setRight(e.target.value)}>
          {options.map((o) => <option key={o} value={o}>{o === 'current' ? 'Current draft' : o}</option>)}
        </select>
        <button type="button" className="btn btn-secondary" onClick={runDiff} disabled={running}>
          {running ? 'Diffing...' : 'Diff'}
        </button>
      </div>
      {error && <div className="status-banner status-error">{error}</div>}
      {diff && (
        <pre className="diff-output">
          {diff.map((chunk, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className={`diff-line diff-${chunk.type}`}>
              {chunk.type === 'add' ? '+ ' : chunk.type === 'remove' ? '- ' : '  '}
              {chunk.value}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
