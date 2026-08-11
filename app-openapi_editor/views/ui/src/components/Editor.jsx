import React, { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';

// A real JSON code editor (CodeMirror 6) instead of a plain <textarea>:
// - Syntax highlighting for JSON.
// - Live syntax checking via jsonParseLinter() - a red squiggly + gutter
//   marker appears at the exact spot a document stops being valid JSON,
//   in addition to the existing parse-error banner in the toolbar above.
// - Code folding (the small triangles in the left gutter) so a user can
//   collapse any object or array - "paths", a single operation, a deeply
//   nested schema, etc. - down to one line, which the previous plain-text
//   editor had no way to do at all.
export default function Editor({ value, onChange, error }) {
  const extensions = useMemo(() => [
    json(),
    linter(jsonParseLinter()),
    lintGutter(),
  ], []);

  return (
    <div className="editor-pane">
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
