import { useState, useEffect, useCallback } from 'react';
import { getHandoff } from '../../api/tasks';
import styles from './HandoffLog.module.css';

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function HandoffLog({ taskId }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const data = await getHandoff(taskId);
      const items = Array.isArray(data) ? data : (data.entries || data.items || []);
      setEntries(items);
    } catch (err) {
      console.error('Failed to load handoff:', err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (expanded && taskId) load();
  }, [expanded, taskId, load]);

  return (
    <div className={styles.section}>
      <button
        className={styles.toggle}
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
      >
        <span>{'\u{1F91D}'}</span> Handoff Notes
        <span className={expanded ? styles.arrowExpanded : styles.arrow}>{'\u25BC'}</span>
      </button>
      {expanded && (
        <div className={styles.body}>
          <div className={styles.list}>
            {loading && entries.length === 0 && (
              <div className={styles.empty}>Loading...</div>
            )}
            {!loading && entries.length === 0 && (
              <div className={styles.empty}>No handoff notes yet.</div>
            )}
            {entries.map((entry, i) => (
              <div key={entry.id || i} className={styles.item}>
                <div className={styles.icon}>{'\u{1F91D}'}</div>
                <div className={styles.content}>
                  <div className={styles.text}>
                    {entry.summary || entry.text || entry.notes || JSON.stringify(entry)}
                  </div>
                  <div className={styles.meta}>
                    {entry.agent && <span>{entry.agent}</span>}
                    {(entry.createdAt || entry.timestamp) && (
                      <span>{formatTime(entry.createdAt || entry.timestamp)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
