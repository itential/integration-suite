import React, { useState, useEffect } from 'react';
import * as api from '../api';

/**
 * The template body editor - the left half of the split-view - plus this
 * library/template's Environment config (trimBlocks/lstripBlocks/autoescape),
 * the concrete subset of the solution design's "Environment config" section
 * that nunjucks actually exposes as flags. `do` and `i18n` extensions are
 * NOT implemented (nunjucks has no equivalent extension-registration API
 * like Python Jinja2's `env.add_extension`); `loopcontrols`-style behavior
 * (break/continue) doesn't need a flag here at all since nunjucks' `loop`
 * object (loop.first/last/index, and native for/if inside loops) already
 * covers the common cases without an extension - documented in the README
 * rather than faked with a checkbox that does nothing.
 */
export default function TemplateEditor({ template, onSaved, onDirtyChange, onBodyChange }) {
  const [body, setBody] = useState(template.body || '');
  const [env, setEnv] = useState(template.environment || { trimBlocks: false, lstripBlocks: false, autoescape: false });
  const [saveError, setSaveError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBody(template.body || '');
    setEnv(template.environment || { trimBlocks: false, lstripBlocks: false, autoescape: false });
    setSaveError(null);
    setDirty(false);
  }, [template._id]);

  useEffect(() => {
    if (onDirtyChange) onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (onBodyChange) onBodyChange(body);
  }, [body, onBodyChange]);

  function handleChange(e) {
    setBody(e.target.value);
    setDirty(true);
  }

  function toggleEnvFlag(flag) {
    setEnv((prev) => ({ ...prev, [flag]: !prev[flag] }));
    setDirty(true);
  }

  function handleSave() {
    setSaving(true);
    api
      .updateTemplate(template._id, { body, environment: env, updatedBy: 'ui-user' })
      .then(() => {
        setSaving(false);
        setDirty(false);
        onSaved && onSaved();
      })
      .catch((err) => {
        setSaving(false);
        setSaveError(err.message);
      });
  }

  return (
    <div className="editor-pane">
      <div className="editor-toolbar">
        <span className="editor-toolbar-label">{template.name}</span>
        {saveError && <span className="editor-toolbar-error">{saveError}</span>}
      </div>
      <div className="env-config-row">
        <label className="env-flag">
          <input type="checkbox" checked={!!env.trimBlocks} onChange={() => toggleEnvFlag('trimBlocks')} />
          trim_blocks
        </label>
        <label className="env-flag">
          <input type="checkbox" checked={!!env.lstripBlocks} onChange={() => toggleEnvFlag('lstripBlocks')} />
          lstrip_blocks
        </label>
        <label className="env-flag">
          <input type="checkbox" checked={!!env.autoescape} onChange={() => toggleEnvFlag('autoescape')} />
          autoescape
        </label>
      </div>
      <textarea
        className="editor-textarea"
        value={body}
        onChange={handleChange}
        spellCheck={false}
      />
      <div className="editor-footer">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
