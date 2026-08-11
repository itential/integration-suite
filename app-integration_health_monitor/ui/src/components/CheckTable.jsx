import React, { useMemo, useState } from 'react';
import StatusBadge from './StatusBadge';

function formatInterval(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function formatRelativeTime(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

// One entry per column: how to sort it (a comparable value) and how to
// filter it (either free-text substring match against a string, or a fixed
// dropdown of options when the values are effectively an enum).
const COLUMNS = [
  {
    key: 'name',
    label: 'Name',
    sortValue: (c) => (c.name || '').toLowerCase(),
    filterType: 'text',
    filterValue: (c) => c.name || '',
  },
  {
    key: 'target',
    label: 'Target',
    sortValue: (c) => `${c.targetType || ''} ${c.serviceName || ''}`.toLowerCase(),
    filterType: 'text',
    filterValue: (c) => `${c.targetType || ''} ${c.serviceName || ''}`,
  },
  {
    key: 'call',
    label: 'Call',
    sortValue: (c) => `${c.method || ''} ${c.path || ''}`.toLowerCase(),
    filterType: 'text',
    filterValue: (c) => `${c.method || ''} ${c.path || ''}`,
  },
  {
    key: 'interval',
    label: 'Interval',
    sortValue: (c) => c.intervalSeconds || 0,
    filterType: 'text',
    filterValue: (c) => formatInterval(c.intervalSeconds || 0),
  },
  {
    key: 'status',
    label: 'Status',
    sortValue: (c) => (c.status && c.status.state) || 'unknown',
    filterType: 'select',
    options: [
      { value: 'healthy', label: 'Healthy' },
      { value: 'unhealthy', label: 'Unhealthy' },
      { value: 'unknown', label: 'Not yet checked' },
    ],
    filterValue: (c) => (c.status && c.status.state) || 'unknown',
  },
  {
    key: 'lastChecked',
    label: 'Last Checked',
    sortValue: (c) => (c.status && c.status.lastCheckedAt ? new Date(c.status.lastCheckedAt).getTime() : 0),
    filterType: 'select',
    options: [
      { value: 'never', label: 'Never checked' },
      { value: '5m', label: 'Within 5 minutes' },
      { value: '1h', label: 'Within 1 hour' },
      { value: '24h', label: 'Within 24 hours' },
      { value: 'older', label: 'Older than 24 hours' },
    ],
    // Buckets rather than free text, since the displayed value ("5m ago")
    // is relative and constantly changing - a bucketed filter stays
    // meaningful across re-renders the way a substring match wouldn't.
    filterValue: (c) => {
      const iso = c.status && c.status.lastCheckedAt;
      if (!iso) return 'never';
      const diffMs = Date.now() - new Date(iso).getTime();
      if (diffMs <= 5 * 60 * 1000) return '5m';
      if (diffMs <= 60 * 60 * 1000) return '1h';
      if (diffMs <= 24 * 60 * 60 * 1000) return '24h';
      return 'older';
    },
  },
  {
    key: 'lastError',
    label: 'Last Error',
    sortValue: (c) => ((c.status && c.status.lastError) || '').toLowerCase(),
    filterType: 'text',
    filterValue: (c) => (c.status && c.status.lastError) || '',
  },
  {
    key: 'response',
    label: 'Response',
    sortValue: (c) => ((c.status && c.status.lastResponseBody) || '').toLowerCase(),
    filterType: 'text',
    filterValue: (c) => (c.status && c.status.lastResponseBody) || '',
  },
  {
    key: 'enabled',
    label: 'Enabled',
    sortValue: (c) => (c.enabled ? 1 : 0),
    filterType: 'select',
    options: [
      { value: 'enabled', label: 'Enabled' },
      { value: 'disabled', label: 'Disabled' },
    ],
    filterValue: (c) => (c.enabled ? 'enabled' : 'disabled'),
  },
];

export default function CheckTable({
  checks, onEdit, onDelete, onRunNow, onRestart, onToggleEnabled, runningId, restartingId,
}) {
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const [filters, setFilters] = useState({});

  const handleSortClick = (key) => {
    const col = COLUMNS.find((c) => c.key === key);
    if (!col) return;
    setSort((prev) => (prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
  };

  const updateFilter = (key, value) => setFilters((prev) => ({ ...prev, [key]: value }));

  const filteredSorted = useMemo(() => {
    let rows = checks;

    Object.keys(filters).forEach((key) => {
      const raw = filters[key];
      if (!raw) return;
      const col = COLUMNS.find((c) => c.key === key);
      if (!col || !col.filterValue) return;
      if (col.filterType === 'select') {
        rows = rows.filter((c) => col.filterValue(c) === raw);
      } else {
        const needle = raw.toLowerCase();
        rows = rows.filter((c) => col.filterValue(c).toLowerCase().includes(needle));
      }
    });

    if (sort.key) {
      const col = COLUMNS.find((c) => c.key === sort.key);
      if (col) {
        rows = [...rows].sort((a, b) => {
          const av = col.sortValue(a);
          const bv = col.sortValue(b);
          if (av < bv) return sort.dir === 'asc' ? -1 : 1;
          if (av > bv) return sort.dir === 'asc' ? 1 : -1;
          return 0;
        });
      }
    }

    return rows;
  }, [checks, filters, sort]);

  const anyFilterActive = Object.values(filters).some(Boolean);

  if (!checks.length) {
    return (
      <div className="empty-state">
        No health checks configured yet. Click <strong>+ Add Check</strong> to monitor your first
        adapter or integration.
      </div>
    );
  }

  return (
    <table className="check-table">
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th
              key={col.key}
              className={`sortable-th ${sort.key === col.key ? `sorted-${sort.dir}` : ''}`}
              onClick={() => handleSortClick(col.key)}
            >
              {col.label}
              {sort.key === col.key && <span className="sort-arrow">{sort.dir === 'asc' ? ' ▲' : ' ▼'}</span>}
            </th>
          ))}
          <th />
        </tr>
        <tr className="filter-row">
          {COLUMNS.map((col) => (
            <th key={col.key}>
              {col.filterType === 'text' && (
                <input
                  type="text"
                  className="filter-input"
                  placeholder="Filter…"
                  value={filters[col.key] || ''}
                  onChange={(e) => updateFilter(col.key, e.target.value)}
                />
              )}
              {col.filterType === 'select' && (
                <select
                  className="filter-input"
                  value={filters[col.key] || ''}
                  onChange={(e) => updateFilter(col.key, e.target.value)}
                >
                  <option value="">All</option>
                  {col.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              )}
            </th>
          ))}
          <th>
            {anyFilterActive && (
              <button type="button" className="link-button" onClick={() => setFilters({})}>Clear</button>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        {filteredSorted.length === 0 && (
          <tr>
            <td colSpan={COLUMNS.length + 1} className="empty-filtered-row">
              No checks match the current filters.
            </td>
          </tr>
        )}
        {filteredSorted.map((check) => (
          <tr key={check.id} className={check.enabled ? '' : 'row-disabled'}>
            <td className="cell-name">{check.name}</td>
            <td>
              <span className={`target-type target-type-${check.targetType}`}>{check.targetType}</span>
              <div className="cell-sub">{check.serviceName}</div>
            </td>
            <td className="cell-mono">{check.method} {check.path}</td>
            <td>{formatInterval(check.intervalSeconds)}</td>
            <td><StatusBadge state={check.status && check.status.state} /></td>
            <td>{formatRelativeTime(check.status && check.status.lastCheckedAt)}</td>
            <td className="cell-error" title={check.status && check.status.lastError}>
              {(check.status && check.status.lastError) || '—'}
            </td>
            <td className="cell-response" title={check.status && check.status.lastResponseBody}>
              {(check.status && check.status.lastResponseBody) || '—'}
            </td>
            <td>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={!!check.enabled}
                  onChange={() => onToggleEnabled(check)}
                />
                <span className="toggle-slider" />
              </label>
            </td>
            <td className="cell-actions">
              <button type="button" className="btn btn-tiny" onClick={() => onRunNow(check)} disabled={runningId === check.id}>
                {runningId === check.id ? 'Running…' : 'Run Now'}
              </button>
              {check.targetType !== 'integration' && (
                <button
                  type="button"
                  className="btn btn-tiny btn-tiny-secondary"
                  onClick={() => onRestart(check)}
                  disabled={restartingId === check.id}
                  title={`Restart the ${check.targetType} "${check.serviceName}" (stop, then start)`}
                >
                  {restartingId === check.id ? 'Restarting…' : 'Restart'}
                </button>
              )}
              <button type="button" className="btn btn-tiny btn-tiny-secondary" onClick={() => onEdit(check)}>Edit</button>
              <button type="button" className="btn btn-tiny btn-tiny-danger" onClick={() => onDelete(check)}>Delete</button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
