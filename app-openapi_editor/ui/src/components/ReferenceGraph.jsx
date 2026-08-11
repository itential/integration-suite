import React, { useMemo } from 'react';

const REFERENCE_TAG_RE = /{%-?\s*(extends|include|import|from)\s+["']([^"']+)["']/g;

function extractReferences(body) {
  const refs = [];
  if (!body) return refs;
  let m;
  REFERENCE_TAG_RE.lastIndex = 0;
  while ((m = REFERENCE_TAG_RE.exec(body)) !== null) {
    refs.push({ tag: m[1], name: m[2].replace(/@v\d+$/, '') });
  }
  return refs;
}

/**
 * Computes forward references (what `focusName` extends/includes/imports)
 * and reverse dependents (what else references `focusName`) by regex
 * scanning every fetched template's body - mirrors the same tag grammar the
 * server-side loader understands. Styled after the reference app's
 * Operations tab (bordered rows + colored edge-type badges).
 */
export default function ReferenceGraph({ templates, focusName }) {
  const { forward, reverse } = useMemo(() => {
    if (!focusName) return { forward: [], reverse: [] };

    const focusDoc = templates.find((t) => t.name === focusName);
    const fwd = focusDoc ? extractReferences(focusDoc.body) : [];

    const rev = [];
    templates.forEach((t) => {
      if (t.name === focusName) return;
      extractReferences(t.body).forEach((ref) => {
        if (ref.name === focusName) {
          rev.push({ tag: ref.tag, name: t.name });
        }
      });
    });

    return { forward: fwd, reverse: rev };
  }, [templates, focusName]);

  if (!focusName) {
    return (
      <div className="ref-graph-panel">
        <div className="ref-graph-empty">Select a template to see its reference graph.</div>
      </div>
    );
  }

  return (
    <div className="ref-graph-panel">
      <h2 className="ref-graph-focus">{focusName}</h2>

      <div className="ref-graph-group">
        <div className="preview-section-title">Depends on ({forward.length})</div>
        <ul className="ref-graph-list">
          {forward.map((r, i) => (
            <li className="ref-graph-row" key={i}>
              <span className={`ref-graph-edge ref-graph-edge-${r.tag}`}>{r.tag}</span>
              <span className="ref-graph-name">{r.name}</span>
            </li>
          ))}
          {forward.length === 0 && <li className="ref-graph-empty">(none)</li>}
        </ul>
      </div>

      <div className="ref-graph-group">
        <div className="preview-section-title">Depended on by ({reverse.length})</div>
        <ul className="ref-graph-list">
          {reverse.map((r, i) => (
            <li className="ref-graph-row" key={i}>
              <span className={`ref-graph-edge ref-graph-edge-${r.tag}`}>{r.tag}</span>
              <span className="ref-graph-name">{r.name}</span>
            </li>
          ))}
          {reverse.length === 0 && <li className="ref-graph-empty">(none)</li>}
        </ul>
      </div>
    </div>
  );
}
