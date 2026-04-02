import { useState, useEffect, useCallback } from 'react';
import { getActivity, addComment, deleteActivity } from '../../api/activity';
import styles from './ActivityLog.module.css';

function getIconClass(type) {
  switch (type) {
    case 'move': return styles.iconMove;
    case 'comment': return styles.iconComment;
    case 'created': return styles.iconCreated;
    default: return styles.iconEdit;
  }
}

function getIconEmoji(type) {
  switch (type) {
    case 'move': return '\u{1F4E6}';
    case 'comment': return '\u{1F4AC}';
    case 'created': return '\u{2728}';
    default: return '\u{270F}\u{FE0F}';
  }
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function ActivityLog({ taskId }) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [comment, setComment] = useState('');
  const [author, setAuthor] = useState('Mike');

  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const data = await getActivity(taskId);
      setItems(Array.isArray(data) ? data : (data.items || []));
    } catch (err) {
      console.error('Failed to load activity:', err);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (expanded && taskId) load();
  }, [expanded, taskId, load]);

  const handlePost = async () => {
    const text = comment.trim();
    if (!text || !taskId) return;
    try {
      await addComment(taskId, { text, author });
      setComment('');
      load();
    } catch (err) {
      console.error('Failed to post comment:', err);
    }
  };

  const handleDelete = async (activityId) => {
    try {
      await deleteActivity(activityId);
      setItems(prev => prev.filter(a => a.id !== activityId));
    } catch (err) {
      console.error('Failed to delete activity:', err);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handlePost();
    }
  };

  return (
    <div className={styles.section}>
      <button
        className={styles.toggle}
        onClick={() => setExpanded(prev => !prev)}
        aria-expanded={expanded}
      >
        <span>{'\u{1F4AC}'}</span> Activity & Comments
        <span className={expanded ? styles.arrowExpanded : styles.arrow}>{'\u25BC'}</span>
      </button>
      {expanded && (
        <div className={styles.body}>
          <div className={styles.list}>
            {loading && items.length === 0 && (
              <div className={styles.empty}>Loading...</div>
            )}
            {!loading && items.length === 0 && (
              <div className={styles.empty}>No activity yet.</div>
            )}
            {items.map(item => (
              <div key={item.id} className={styles.item}>
                <div className={getIconClass(item.type)}>
                  {getIconEmoji(item.type)}
                </div>
                <div className={styles.content}>
                  <div className={styles.text}>{item.text}</div>
                  <div className={styles.meta}>
                    {item.author && <span>{item.author}</span>}
                    {item.createdAt && <span>{formatTime(item.createdAt)}</span>}
                  </div>
                </div>
                {item.type === 'comment' && (
                  <button
                    className={styles.deleteBtn}
                    onClick={() => handleDelete(item.id)}
                    aria-label="Delete comment"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className={styles.commentForm}>
            <textarea
              className={styles.commentInput}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Add a comment..."
              rows="1"
            />
            <select
              className={styles.authorSelect}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            >
              <option value="Mike">Mike</option>
              <option value="ClawDawg">ClawDawg</option>
            </select>
            <button className={styles.postBtn} onClick={handlePost}>Post</button>
          </div>
        </div>
      )}
    </div>
  );
}
