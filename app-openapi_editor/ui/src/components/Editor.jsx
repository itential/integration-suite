import React, { useEffect, useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter, forceLinting } from '@codemirror/lint';

// A real JSON code editor (CodeMirror 6) instead of a plain <textarea>:
// - Syntax highlighting for JSON.
// - Live syntax checking via jsonParseLinter() - a red squiggly + gutter
//   marker appears at the exact spot a document stops being valid JSON,
//   in addition to the existing parse-error banner in the toolbar above.
// - Code folding (the small triangles in the left gutter) so a user can
//   collapse any object or array - "paths", a single operation, a deeply
//   nested schema, etc. - down to one line, which the previous plain-text
//   editor had no way to do at all.
// - Optional `validationDiagnostics` (from the Validate button, via
//   util/validateHints.js) shown as additional gutter markers - best-effort
//   line locating, since swagger-parser only gives plain message strings.
export default function Editor({ value, onChange, error, validationDiagnostics, style }) {
  const viewRef = useRef(null);

  // The FIRST attempt at this recreated the `linter()` extension itself on
  // every Validate click (via a useMemo keyed on validationDiagnostics),
  // relying on CodeMirror re-running lint after that reconfigure. It didn't
  // reliably do so. Fix: the linter extension below is created exactly
  // once (empty useMemo deps) and its source function reads from a ref
  // that's updated on every render - forceLinting() then just re-invokes
  // this SAME persistent linter, which reads the current ref value. This
  // sidesteps reconfigure timing entirely.
  const diagnosticsRef = useRef(validationDiagnostics);
  diagnosticsRef.current = validationDiagnostics;

  const extensions = useMemo(() => [
    json(),
    linter(jsonParseLinter()),
    linter((view) => {
      const diagnostics = diagnosticsRef.current;
      if (!diagnostics || !diagnostics.length) return [];
      const { doc } = view.state;
      const out = [];
      diagnostics.forEach((d) => {
        if (!d.line || d.line < 1 || d.line > doc.lines) return;
        const lineInfo = doc.line(d.line);
        out.push({
          from: lineInfo.from,
          to: lineInfo.to,
          severity: d.severity === 'minor' ? 'warning' : d.severity === 'blocking' ? 'error' : 'info',
          message: d.message,
        });
      });
      return out;
    }),
    lintGutter(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], []);

  useEffect(() => {
    if (viewRef.current) {
      forceLinting(viewRef.current);
    }
  }, [validationDiagnostics]);

  return (
    <div className="editor-pane" style={style}>
      <div className="editor-toolbar">
        <span className="editor-toolbar-label">spec.json</span>
        {error && <span className="editor-toolbar-error">{error}</span>}
      </div>
      <div className="editor-cm-wrapper">
        <CodeMirror
          value={value}
          height="100%"
          theme="dark"
          extensions={extensions}
          onChange={(val) => onChange(val)}
          onCreateEditor={(view) => { viewRef.current = view; }}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            bracketMatching: true,
            autocompletion: false,
          }}
        />
      </div>
    </div>
  );
}
