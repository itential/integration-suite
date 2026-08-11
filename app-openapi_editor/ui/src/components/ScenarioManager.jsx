import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

/** Simple line-by-line diff: returns an array of { line, a, b, same }. */
function diffLines(outputA, outputB) {
  const linesA = (outputA || '').split('\n');
  const linesB = (outputB || '').split('\n');
  const max = Math.max(linesA.length, linesB.length);
  const rows = [];
  for (let i = 0; i < max; i++) {
    const a = linesA[i] ?? '';
    const b = linesB[i] ?? '';
    rows.push({ line: i + 1, a, b, same: a === b });
  }
  return rows;
}

/**
 * Saved test contexts for the active template, plus a two-way diff of
 * rendered output - modeled on the reference app's TestPanel (field rows,
 * a saved-item list, and a result/diff area).
 */
export default function ScenarioManager({ template }) {
  const [scenarios, setScenarios] = useState([]);
  const [newName, setNewName] = useState('');
  const [newContext, setNewContext] = useState('{}');
  const [diffA, setDiffA] = useState('');
  const [diffB, setDiffB] = useState('');
  const [error, setError] = useState(null);

  const refresh = useCallback(() => {
    api
      .listScenarios(template.name)
      .then(setScenarios)
      .catch((err) => setError(err.message));
  }, [template.name]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function handleSave() {
    let contextJson;
    try {
      contextJson = JSON.parse(newContext || '{}');
    } catch (e) {
      setError('Invalid JSON: ' + e.message);
      return;
    }
    api
      .saveScenario(template.name, newName, contextJson)
      .then((list) => {
        setScenarios(list);
        setNewName('');
        setError(null);
      })
      .catch((err) => setError(err.message));
  }

  function handleRun(scenarioName) {
    api
      .runScenario(template.name, scenarioName)
      .then(refresh)
      .catch((err) => setError(err.message));
  }

  const scenarioA = scenarios.find((s) => s.name === diffA);
  const scenarioB = scenarios.find((s) => s.name === diffB);
  const diffRows =
    scenarioA && scenarioB
      ? diffLines(scenarioA.lastRenderedOutput, scenarioB.lastRenderedOutput)
      : [];

  return (
    <div className="scenario-panel">
      <div className="scenario-panel-note">
        Save sample contexts for &quot;{template.name}&quot;, run them against the current
        template body, and diff any two saved runs.
      </div>
      {error && <div className="status-banner status-error" style={{ marginBottom: 12, borderRadius: 6 }}>{error}</div>}

      <div className="preview-section-title">Saved Scenarios</div>
      <div className="scenario-list">
        {scenarios.map((s) => (
          <div className="scenario-row" key={s.name}>
            <span className="scenario-row-name">{s.name}</span>
            <span className="scenario-row-meta">
              {s.lastRunAt ? `last run ${s.lastRunAt}` : 'never run'}
            </span>
            <button type="button" className="btn btn-secondary" onClick={() => handleRun(s.name)}>
              Run
            </button>
          </div>
        ))}
        {scenarios.length === 0 && <div className="scenario-empty">No scenarios saved yet.</div>}
      </div>

      <div className="scenario-new-form">
        <div className="preview-section-title">New Scenario</div>
        <div className="test-field-row">
          <label htmlFor="scenario-name">Name</label>
          <input
            id="scenario-name"
            placeholder="scenario name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
        </div>
        <div className="test-field-row">
          <label htmlFor="scenario-context">Context (JSON)</label>
          <textarea
            id="scenario-context"
            value={newContext}
            onChange={(e) => setNewContext(e.target.value)}
            style={{ minHeight: 90 }}
          />
        </div>
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!newName}>
          Save scenario
        </button>
      </div>

      <div className="scenario-diff-block">
        <div className="preview-section-title">Compare Two Scenarios</div>
        <div className="scenario-diff-selectors">
          <select value={diffA} onChange={(e) => setDiffA(e.target.value)}>
            <option value="">-- A --</option>
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <select value={diffB} onChange={(e) => setDiffB(e.target.value)}>
            <option value="">-- B --</option>
            {scenarios.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        {scenarioA && scenarioB ? (
          <table className="scenario-diff-table">
            <tbody>
              {diffRows.map((row) => (
                <tr key={row.line} className={row.same ? '' : ''}>
                  <td className="diff-line-no">{row.line}</td>
                  <td className={row.same ? '' : 'diff-removed'}>{row.a}</td>
                  <td className={row.same ? '' : 'diff-added'}>{row.b}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="scenario-empty">Pick two scenarios above to diff their rendered output.</div>
        )}
      </div>
    </div>
  );
}
