import { useMemo } from 'react';
import { useTasks } from '../../contexts/TaskContext';
import { useFilters } from '../../contexts/FilterContext';
import styles from './TimelineView.module.css';

const DAY_WIDTH = 80;
const MS_PER_DAY = 86400000;
const MAX_DAYS = 60;
const LABEL_WIDTH = 120;

function escHtml(str) {
  return str || '';
}

export default function TimelineView({ onTaskClick }) {
  const { tasks, loading } = useTasks();
  const { matchesSearch } = useFilters();

  const { days, byAssignee, startMs } = useMemo(() => {
    const filtered = tasks.filter(t => matchesSearch(t) && (t.startAfter || t.dueDate));

    if (!filtered.length) return { days: [], byAssignee: {}, startMs: 0 };

    const allDates = [];
    filtered.forEach(t => {
      if (t.startAfter) allDates.push(new Date(t.startAfter));
      if (t.dueDate) allDates.push(new Date(t.dueDate + 'T23:59:59'));
    });

    let minDate = new Date(Math.min(...allDates));
    let maxDate = new Date(Math.max(...allDates));
    minDate.setDate(minDate.getDate() - 1);
    maxDate.setDate(maxDate.getDate() + 1);

    const daysList = [];
    const cursor = new Date(minDate);
    cursor.setHours(0, 0, 0, 0);
    const maxEnd = new Date(maxDate);
    maxEnd.setHours(0, 0, 0, 0);
    while (cursor <= maxEnd && daysList.length < MAX_DAYS) {
      daysList.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }

    const grouped = {};
    filtered.forEach(t => {
      const key = t.assignee || 'Unassigned';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(t);
    });

    return {
      days: daysList,
      byAssignee: grouped,
      startMs: daysList.length > 0 ? daysList[0].getTime() : 0,
    };
  }, [tasks, matchesSearch]);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.noDates}>Loading timeline...</div>
      </div>
    );
  }

  if (days.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.noDates}>No tasks with dates to display</div>
      </div>
    );
  }

  const totalWidth = LABEL_WIDTH + days.length * DAY_WIDTH;

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header} style={{ minWidth: totalWidth }}>
        <div className={`${styles.headerLabel} ${styles.assigneeCol}`}>Assignee</div>
        {days.map((d, i) => (
          <div key={i} className={styles.headerLabel} style={{ minWidth: DAY_WIDTH }}>
            {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </div>
        ))}
      </div>

      {/* Swimlanes */}
      {Object.entries(byAssignee).map(([assignee, assigneeTasks]) => (
        <div key={assignee} className={styles.swimlane} style={{ minWidth: totalWidth }}>
          <div className={styles.swimlaneLabel}>
            <span className={styles.avatar}>
              {assignee === 'Mike' ? 'M' : assignee.substring(0, 2).toUpperCase()}
            </span>
            {escHtml(assignee)}
          </div>
          <div className={styles.row} style={{ width: days.length * DAY_WIDTH }}>
            {assigneeTasks.map(t => {
              const taskStart = t.startAfter
                ? new Date(t.startAfter)
                : (t.dueDate ? new Date(t.dueDate) : null);
              const taskEnd = t.dueDate
                ? new Date(t.dueDate + 'T23:59:59')
                : (t.startAfter ? new Date(new Date(t.startAfter).getTime() + MS_PER_DAY) : null);

              if (!taskStart || !taskEnd) return null;

              const leftPx = Math.max(0, ((taskStart.getTime() - startMs) / MS_PER_DAY) * DAY_WIDTH);
              const widthPx = Math.max(DAY_WIDTH * 0.5, ((taskEnd.getTime() - taskStart.getTime()) / MS_PER_DAY) * DAY_WIDTH);

              return (
                <div
                  key={t.id}
                  className={`${styles.bar} ${styles[`col${t.column.replace('-', '')}`] || ''}`}
                  style={{ left: leftPx, width: widthPx }}
                  title={t.title}
                  onClick={() => onTaskClick?.(t)}
                >
                  {t.title}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
