import { useState } from 'react';
import { useBulkSelect } from '../../contexts/BulkSelectContext';
import { useTasks } from '../../contexts/TaskContext';
import styles from './BulkToolbar.module.css';

const COLUMNS = [
  { value: 'idea', label: '\uD83D\uDCA1 Idea' },
  { value: 'backlog', label: '\uD83D\uDCCB Backlog' },
  { value: 'in-progress', label: '\u26A1 In Progress' },
  { value: 'in-review', label: '\uD83D\uDD0D In Review' },
  { value: 'done', label: '\u2705 Done' },
];

export default function BulkToolbar() {
  const { selectedCount, bulkMove, bulkDelete, clearSelection } = useBulkSelect();
  const { loadTasks } = useTasks();
  const [moveCol, setMoveCol] = useState('');

  const handleMove = async (col) => {
    setMoveCol('');
    const result = await bulkMove(col);
    if (result) loadTasks();
  };

  const handleDelete = async () => {
    const result = await bulkDelete();
    if (result) loadTasks();
  };

  if (selectedCount === 0) return null;

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Bulk actions">
      <span className={styles.count}>{selectedCount} selected</span>
      <div className={styles.divider} />
      <span className={styles.actionLabel}>Move to</span>
      <select
        className={styles.moveSelect}
        value={moveCol}
        onChange={(e) => handleMove(e.target.value)}
      >
        <option value="">Select column...</option>
        {COLUMNS.map(c => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      <div className={styles.divider} />
      <button className={`${styles.btn} ${styles.danger}`} onClick={handleDelete}>
        {'\uD83D\uDDD1'} Delete
      </button>
      <button className={`${styles.btn} ${styles.deselect}`} onClick={clearSelection}>
        {'\u2715'} Deselect all
      </button>
    </div>
  );
}
