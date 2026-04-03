import { useState, useEffect, useCallback } from 'react';
import { getBlockers, addBlocker, removeBlocker } from '../../api/dependencies';
import { useTasks } from '../../contexts/TaskContext';
import styles from './Dependencies.module.css';

const COL_LABELS = {
  'idea': 'Idea',
  'backlog': 'Backlog',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'done': 'Done',
};

export default function Dependencies({ taskId }) {
  const { tasks } = useTasks();
  const [blockers, setBlockers] = useState([]);
  const [selectedBlocker, setSelectedBlocker] = useState('');

  const load = useCallback(async () => {
    if (!taskId) return;
    try {
      const data = await getBlockers(taskId);
      setBlockers(Array.isArray(data) ? data : (data.items || []));
    } catch (err) {
      console.error('Failed to load blockers:', err);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const blockerIds = new Set(blockers.map(b => b.blocker_id || b.blockerId || b.id));

  // Available tasks to add as blockers (not self, not already blocking)
  const available = tasks.filter(t => t.id !== taskId && !blockerIds.has(t.id));

  const handleAdd = async () => {
    if (!selectedBlocker || !taskId) return;
    try {
      await addBlocker(taskId, { blockerId: selectedBlocker });
      setSelectedBlocker('');
      load();
    } catch (err) {
      console.error('Failed to add blocker:', err);
    }
  };

  const handleRemove = async (blockerId) => {
    try {
      await removeBlocker(taskId, blockerId);
      setBlockers(prev => prev.filter(b => (b.blocker_id || b.blockerId || b.id) !== blockerId));
    } catch (err) {
      console.error('Failed to remove blocker:', err);
    }
  };

  // Resolve blocker task details
  const resolveTask = (blockerId) => tasks.find(t => t.id === blockerId);

  return (
    <div className={styles.section}>
      <span className={styles.label}>{'\u{1F512}'} Blocked By</span>
      <div className={styles.list}>
        {blockers.length === 0 && (
          <span className={styles.empty}>No blockers</span>
        )}
        {blockers.map(b => {
          const bid = b.blocker_id || b.blockerId || b.id;
          const blockerTask = resolveTask(bid);
          return (
            <div key={bid} className={styles.item}>
              <span className={styles.depTitle}>
                {blockerTask ? blockerTask.title : `Task #${bid}`}
              </span>
              {blockerTask && (
                <span className={styles.depColBadge}>
                  {COL_LABELS[blockerTask.column] || blockerTask.column}
                </span>
              )}
              <button
                className={styles.removeBtn}
                onClick={() => handleRemove(bid)}
                aria-label="Remove blocker"
              >
                &times;
              </button>
            </div>
          );
        })}
      </div>
      <div className={styles.addRow}>
        <select
          className={styles.addSelect}
          value={selectedBlocker}
          onChange={(e) => setSelectedBlocker(e.target.value)}
        >
          <option value="">&mdash; select a blocker card &mdash;</option>
          {available.map(t => (
            <option key={t.id} value={t.id}>
              {t.title} ({COL_LABELS[t.column] || t.column})
            </option>
          ))}
        </select>
        <button className={styles.addBtn} onClick={handleAdd}>Add</button>
      </div>
    </div>
  );
}
