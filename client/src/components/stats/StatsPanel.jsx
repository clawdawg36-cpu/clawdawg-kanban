import { useState, useEffect, useCallback } from 'react';
import { useProjects } from '../../contexts/ProjectContext';
import styles from './StatsPanel.module.css';

const COL_ORDER = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];
const COL_LABELS = {
  idea: '\uD83D\uDCA1 Idea',
  backlog: '\uD83D\uDCCB Backlog',
  'in-progress': '\u26A1 In Progress',
  'in-review': '\uD83D\uDD0D In Review',
  done: '\u2705 Done',
};

function formatDuration(ms) {
  if (!ms || ms <= 0) return '\u2014';
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  const mins = Math.floor(ms / 60000);
  return `${mins}m`;
}

export default function StatsPanel({ open, onClose }) {
  const { activeProjectId, activeProject } = useProjects();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchStats = useCallback(async () => {
    if (!activeProjectId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/stats?projectId=${encodeURIComponent(activeProjectId)}`);
      if (!res.ok) throw new Error('Failed to load stats');
      const data = await res.json();
      setStats(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (open) fetchStats();
  }, [open, fetchStats]);

  if (!open) return null;

  const totalTasks = stats ? Object.values(stats.columnCounts || {}).reduce((a, b) => a + b, 0) : 0;
  const assignees = stats ? Object.entries(stats.totalByAssignee || {}).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>
          {stats?.projectName || activeProject?.name || 'Stats'}
        </h2>

        {loading && (
          <div className={styles.loadingMsg}>Loading...</div>
        )}

        {error && (
          <div className={styles.errorMsg}>Failed to load stats</div>
        )}

        {stats && !loading && (
          <>
            {/* Highlights */}
            <div className={styles.highlights}>
              <div className={styles.highlightCard}>
                <div className={styles.highlightValue}>{stats.completedThisWeek ?? 0}</div>
                <div className={styles.highlightLabel}>{'\u2705'} Done this week</div>
              </div>
              <div className={styles.highlightCard}>
                <div
                  className={styles.highlightValue}
                  style={{ color: (stats.overdueCount > 0) ? 'var(--red)' : 'var(--green)' }}
                >
                  {stats.overdueCount ?? 0}
                </div>
                <div className={styles.highlightLabel}>{'\u26A0\uFE0F'} Overdue</div>
              </div>
              <div className={styles.highlightCard}>
                <div className={styles.highlightValue} style={{ color: '#a29bfe' }}>
                  {formatDuration(stats.avgTimeToComplete)}
                </div>
                <div className={styles.highlightLabel}>{'\u23F1'} Avg time to done</div>
              </div>
            </div>

            {/* Column counts */}
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>
                Tasks by Column{' '}
                <span className={styles.totalLabel}>({totalTasks} total)</span>
              </h3>
              {COL_ORDER.map(col => (
                <div key={col} className={styles.row}>
                  <span className={styles.label}>{COL_LABELS[col]}</span>
                  <span className={styles.value}>{stats.columnCounts?.[col] || 0}</span>
                </div>
              ))}
            </div>

            {/* Assignee breakdown */}
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Tasks per Assignee</h3>
              {assignees.length > 0 ? assignees.map(([name, cnt]) => {
                const pct = totalTasks > 0 ? Math.round(cnt / totalTasks * 100) : 0;
                return (
                  <div key={name} className={styles.row}>
                    <span className={styles.label}>{'\uD83D\uDC64'} {name}</span>
                    <span className={styles.value}>
                      {cnt} <span className={styles.pct}>({pct}%)</span>
                    </span>
                  </div>
                );
              }) : (
                <div className={styles.row}>
                  <span className={styles.label} style={{ color: 'var(--text-dim)' }}>No tasks yet</span>
                </div>
              )}
            </div>
          </>
        )}

        <button className={styles.closeBtn} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
