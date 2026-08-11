import React, { useMemo, useState, useEffect } from 'react';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// Groups every operation in the spec by its first tag (falling back to
// "untagged"), mirroring how swagger-ui-react's own Preview pane groups
// operations into collapsible categories - this list is meant to feel like
// a checkbox-enabled version of that same view, not a different structure.
function groupOperations(spec) {
  const groups = [];
  const byTag = {};
  if (!spec || !spec.paths) return groups;

  Object.keys(spec.paths).forEach((path) => {
    const pathItem = spec.paths[path] || {};
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      const tag = (op.tags && op.tags[0]) || 'untagged';
      if (!byTag[tag]) {
        byTag[tag] = { tag, operations: [] };
        groups.push(byTag[tag]);
      }
      byTag[tag].operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method,
        path,
        summary: op.summary || op.operationId || '',
      });
    });
  });

  return groups;
}

/**
 * Removes the selected operations from a spec (by "METHOD path" key),
 * then prunes any path entry left with no HTTP methods at all, and any
 * top-level spec.tags entry no longer referenced by a remaining operation.
 * Returns a new spec object - does not mutate the input.
 */
export function applyRemovals(spec, removedKeys) {
  const next = JSON.parse(JSON.stringify(spec));
  const removedSet = new Set(removedKeys);
  const stillUsedTags = new Set();

  Object.keys(next.paths || {}).forEach((path) => {
    const pathItem = next.paths[path];
    HTTP_METHODS.forEach((method) => {
      const op = pathItem[method];
      if (!op) return;
      if (removedSet.has(`${method.toUpperCase()} ${path}`)) {
        delete pathItem[method];
      } else if (op.tags && op.tags[0]) {
        stillUsedTags.add(op.tags[0]);
      }
    });
    const hasAnyMethod = HTTP_METHODS.some((m) => pathItem[m]);
    if (!hasAnyMethod) delete next.paths[path];
  });

  if (Array.isArray(next.tags)) {
    next.tags = next.tags.filter((t) => stillUsedTags.has(t.name));
  }

  return next;
}

export default function Cleanup({ spec, onApply, disabled }) {
  const groups = useMemo(() => groupOperations(spec), [spec]);
  const [selected, setSelected] = useState(() => new Set());
  // Which category tags are collapsed (hiding their operation rows) - empty
  // by default, i.e. every category starts expanded.
  const [collapsed, setCollapsed] = useState(() => new Set());

  // Clear selections whenever the underlying spec changes shape (switching
  // models, or a previous Apply already ran) - stale keys from a spec that
  // no longer exists would otherwise silently do nothing on the next Apply.
  useEffect(() => {
    setSelected(new Set());
  }, [spec]);

  const toggleCollapsed = (tag) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  if (!spec) {
    return <div className="preview-pane"><div className="preview-empty">Select a model to clean it up</div></div>;
  }

  const toggleOp = (key) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const groupKeys = (group) => group.operations.map((o) => o.key);
  const groupState = (group) => {
    const keys = groupKeys(group);
    const selectedCount = keys.filter((k) => selected.has(k)).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === keys.length) return 'all';
    return 'some';
  };

  const toggleGroup = (group) => {
    const keys = groupKeys(group);
    const state = groupState(group);
    setSelected((prev) => {
      const next = new Set(prev);
      if (state === 'all') {
        keys.forEach((k) => next.delete(k));
      } else {
        keys.forEach((k) => next.add(k));
      }
      return next;
    });
  };

  const handleApply = () => {
    if (selected.size === 0) return;
    onApply(Array.from(selected));
    setSelected(new Set());
  };

  const totalOps = groups.reduce((sum, g) => sum + g.operations.length, 0);

  return (
    <div className="preview-pane cleanup-panel">
      {/* Everything below is wrapped in a single scrollable child, rather
          than left as several direct children of this flex-column pane -
          a flex container with multiple direct children can refuse to
          shrink/scroll and instead grow past its bounds (the same root
          cause the CodeMirror editor's scroll wheel issue had) - a single
          bounded, overflow:auto child sidesteps that entirely. */}
      <div className="cleanup-scroll">
        <p className="test-panel-note">
          Select operations (individually or by whole category) to remove from the spec, then
          apply. This edits the editor&apos;s JSON directly - it&apos;s still just a draft until
          you click <strong>Save</strong>, same as any other manual edit.
        </p>

        <div className="cleanup-toolbar">
          <span className="cleanup-count">
            {selected.size} of {totalOps} operation{totalOps === 1 ? '' : 's'} selected for removal
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleApply}
            disabled={disabled || selected.size === 0}
          >
            Apply removals to editor
          </button>
        </div>

        {groups.length === 0 && (
          <div className="preview-empty">This spec has no operations to clean up yet.</div>
        )}

        {groups.map((group) => {
          const state = groupState(group);
          const isCollapsed = collapsed.has(group.tag);
          return (
            <div className="cleanup-group" key={group.tag}>
              <div className="cleanup-group-header">
                <input
                  type="checkbox"
                  checked={state === 'all'}
                  ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
                  onChange={() => toggleGroup(group)}
                  title="Select/deselect every operation in this category"
                />
                <button
                  type="button"
                  className="cleanup-group-toggle"
                  onClick={() => toggleCollapsed(group.tag)}
                  aria-expanded={!isCollapsed}
                >
                  <span className={`cleanup-group-caret ${isCollapsed ? 'collapsed' : ''}`}>▾</span>
                  <span className="cleanup-group-name">{group.tag}</span>
                  <span className="cleanup-group-sub">{group.operations.length} operation{group.operations.length === 1 ? '' : 's'}</span>
                </button>
              </div>
              {!isCollapsed && (
                <div className="cleanup-ops">
                  {group.operations.map((op) => (
                    <label className="cleanup-op-row" key={op.key}>
                      <input
                        type="checkbox"
                        checked={selected.has(op.key)}
                        onChange={() => toggleOp(op.key)}
                      />
                      <span className={`method-badge method-${op.method}`}>{op.method}</span>
                      <span className="cleanup-op-path">{op.path}</span>
                      {op.summary && <span className="cleanup-op-summary">{op.summary}</span>}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
