import { useState, useEffect, useCallback, useMemo } from 'react';
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

function VelocityChart({ projectId }) {
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/timeline?days=30`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setTimeline(data))
      .catch(() => setTimeline(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  const chartData = useMemo(() => {
    if (!timeline) return null;

    // Build a full 30-day array
    const days = [];
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      days.push({ date: dateStr, completed: 0, dayOfWeek: d.getDay() });
    }

    // Fill in actual data
    const dataMap = {};
    (timeline.items || []).forEach(item => { dataMap[item.date] = item.completed; });
    days.forEach(d => { d.completed = dataMap[d.date] || 0; });

    const maxVal = Math.max(1, ...days.map(d => d.completed));

    return { days, maxVal, todayStr };
  }, [timeline]);

  if (loading) return <div className={styles.loadingMsg}>Loading chart...</div>;
  if (!chartData || chartData.days.every(d => d.completed === 0)) {
    return <div className={styles.emptyChart}>No completed tasks in the last 30 days</div>;
  }

  const { days, maxVal, todayStr } = chartData;
  const W = 420;
  const H = 140;
  const padLeft = 30;
  const padBottom = 24;
  const padTop = 10;
  const padRight = 10;
  const chartW = W - padLeft - padRight;
  const chartH = H - padTop - padBottom;
  const barW = Math.max(4, (chartW / days.length) - 2);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.chart}>
      {/* Y-axis labels */}
      <text x={padLeft - 4} y={padTop + 4} className={styles.axisLabel} textAnchor="end">{maxVal}</text>
      <text x={padLeft - 4} y={padTop + chartH} className={styles.axisLabel} textAnchor="end">0</text>

      {/* Grid lines */}
      <line x1={padLeft} y1={padTop} x2={padLeft + chartW} y2={padTop} className={styles.gridLine} />
      <line x1={padLeft} y1={padTop + chartH} x2={padLeft + chartW} y2={padTop + chartH} className={styles.gridLine} />
      {maxVal > 2 && (
        <line
          x1={padLeft} y1={padTop + chartH / 2}
          x2={padLeft + chartW} y2={padTop + chartH / 2}
          className={styles.gridLine}
          strokeDasharray="4 4"
        />
      )}

      {/* Bars */}
      {days.map((d, i) => {
        const x = padLeft + (i / days.length) * chartW + 1;
        const barH = d.completed > 0 ? Math.max(2, (d.completed / maxVal) * chartH) : 0;
        const y = padTop + chartH - barH;
        const isToday = d.date === todayStr;

        return (
          <g key={d.date}>
            {barH > 0 && (
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={2}
                className={isToday ? styles.barToday : styles.bar}
              />
            )}
            {isToday && (
              <line
                x1={x + barW / 2} y1={padTop}
                x2={x + barW / 2} y2={padTop + chartH}
                className={styles.todayLine}
              />
            )}
          </g>
        );
      })}

      {/* X-axis week markers */}
      {days.map((d, i) => {
        // Show a label every 7 days
        if (i % 7 !== 0 && i !== days.length - 1) return null;
        const x = padLeft + (i / days.length) * chartW + barW / 2;
        const label = d.date.slice(5); // MM-DD
        return (
          <text key={d.date} x={x} y={H - 4} className={styles.axisLabel} textAnchor="middle">
            {label}
          </text>
        );
      })}
    </svg>
  );
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

            {/* Velocity chart */}
            <div className={styles.group}>
              <h3 className={styles.groupTitle}>Velocity (last 30 days)</h3>
              <VelocityChart projectId={activeProjectId} />
            </div>
          </>
        )}

        <button className={styles.closeBtn} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
