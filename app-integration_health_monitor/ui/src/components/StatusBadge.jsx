import React from 'react';

const LABELS = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  unknown: 'Not yet checked',
};

export default function StatusBadge({ state }) {
  const cls = `status-badge status-badge-${state || 'unknown'}`;
  return <span className={cls}>{LABELS[state] || 'Unknown'}</span>;
}
