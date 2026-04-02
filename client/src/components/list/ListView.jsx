import { useState, useMemo } from 'react';
import { useTasks } from '../../contexts/TaskContext';
import { useFilters } from '../../contexts/FilterContext';
import Badge from '../common/Badge';
import styles from './ListView.module.css';

const COLUMNS = [
  { key: 'title', label: 'Title' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'priority', label: 'Priority' },
  { key: 'column', label: 'Column' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'tags', label: 'Tags' },
];

const PRIORITY_SORT = { urgent: 0, high: 1, medium: 2, low: 3 };
const COL_SORT_ORDER = { idea: 0, backlog: 1, 'in-progress': 2, 'in-review': 3, done: 4 };
const COL_LABELS = { idea: 'Idea', backlog: 'Backlog', 'in-progress': 'In Progress', 'in-review': 'In Review', done: 'Done' };

export default function ListView({ onTaskClick }) {
  const { tasks, loading } = useTasks();
  const { matchesSearch } = useFilters();
  const [sortCol, setSortCol] = useState('title');
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (col) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const sorted = useMemo(() => {
    const filtered = tasks.filter(t => matchesSearch(t));

    return [...filtered].sort((a, b) => {
      let valA, valB;
      switch (sortCol) {
        case 'title':
          valA = (a.title || '').toLowerCase();
          valB = (b.title || '').toLowerCase();
          break;
        case 'assignee':
          valA = (a.assignee || '').toLowerCase();
          valB = (b.assignee || '').toLowerCase();
          break;
        case 'priority':
          valA = PRIORITY_SORT[a.priority] ?? 9;
          valB = PRIORITY_SORT[b.priority] ?? 9;
          break;
        case 'column':
          valA = COL_SORT_ORDER[a.column] ?? 9;
          valB = COL_SORT_ORDER[b.column] ?? 9;
          break;
        case 'dueDate':
          valA = a.dueDate || '9999';
          valB = b.dueDate || '9999';
          break;
        case 'tags':
          valA = (a.tags || []).join(',').toLowerCase();
          valB = (b.tags || []).join(',').toLowerCase();
          break;
        default:
          valA = '';
          valB = '';
      }
      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [tasks, matchesSearch, sortCol, sortAsc]);

  if (loading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingMsg}>Loading tasks...</div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <table className={styles.table}>
        <thead>
          <tr>
            {COLUMNS.map(col => (
              <th
                key={col.key}
                className={sortCol === col.key ? styles.sorted : ''}
                onClick={() => handleSort(col.key)}
              >
                <span className={styles.sortArrow}>
                  {sortCol === col.key ? (sortAsc ? '\u25B2' : '\u25BC') : '\u25B2'}
                </span>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(task => (
            <tr key={task.id} onClick={() => onTaskClick?.(task)}>
              <td className={styles.titleCell}>{task.title}</td>
              <td>{task.assignee || '\u2014'}</td>
              <td>
                {task.priority ? (
                  <Badge type="priority" value={task.priority} size="small" />
                ) : '\u2014'}
              </td>
              <td>
                <span className={styles.colBadge}>
                  {COL_LABELS[task.column] || task.column}
                </span>
              </td>
              <td>
                {task.dueDate
                  ? new Date(task.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  : '\u2014'}
              </td>
              <td>
                <div className={styles.listTags}>
                  {(task.tags || []).map(tag => (
                    <span key={tag} className={styles.tag}>{tag}</span>
                  ))}
                </div>
              </td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={6} className={styles.emptyRow}>No tasks found</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
