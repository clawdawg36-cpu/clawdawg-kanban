import { useState, useEffect, useCallback, useRef } from 'react';
import { getTaskLogs } from '../../api/tasks';
import styles from './AgentLog.module.css';

function getIconClass(level) {
  switch (level) {
    case 'warn': case 'warning': return styles.iconWarn;
    case 'error': return styles.iconError;
    default: return styles.iconInfo;
  }
}

function getIconEmoji(level) {
  switch (level) {
    case 'warn': case 'warning': return '\u{26A0}\u{FE0F}';
    case 'error': return '\u{274C}';
    default: return '\u{1F4DF}';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

export default function AgentLog({ taskId, isInProgress }) {
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef(null);

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const data = await getTaskLogs(taskId);
      const items = Array.isArray(data) ? data : (data.entries || data.items || []);
      setEntries(items);
    } catch (err) {
      console.error('Failed to load agent logs:', err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (expanded && taskId) load();
  }, [expanded, taskId, load]);

  // Auto-refresh every 5s when in-progress
  useEffect(() => {
    if (expanded && isInProgress && taskId) {
      intervalRef.current = setInterval(load, 5000);
      return () => clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [expanded, isInProgress, taskId, load]);

  return (
    <div className={styles.section}>
      <button
        className={styles.toggle}
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
      >
        <span>{'\u{1F4DF}'}</span> Agent Log
        <span className={expanded ? styles.arrowExpanded : styles.arrow}>{'\u25BC'}</span>
      </button>
      {expanded && (
        <div className={styles.body}>
          <div className={styles.list}>
            {loading && entries.length === 0 && (
              <div className={styles.empty}>Loading...</div>
            )}
            {!loading && entries.length === 0 && (
              <div className={styles.empty}>No log entries yet.</div>
            )}
            {entries.map((entry, i) => (
              <div key={entry.id || i} className={styles.item}>
                <div className={getIconClass(entry.level)}>
                  {getIconEmoji(entry.level)}
                </div>
                <div className={styles.content}>
                  <div className={styles.text}>{entry.message || entry.text}</div>
                  <div className={styles.meta}>
                    {(entry.createdAt || entry.timestamp) && (
                      <span>{formatTime(entry.createdAt || entry.timestamp)}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {isInProgress && (
            <div className={styles.refreshNote}>Auto-refreshing every 5s</div>
          )}
        </div>
      )}
    </div>
  );
}
