import { useState, useRef, useEffect } from 'react';
import { useProjects } from '../../contexts/ProjectContext';
import { useFilters } from '../../contexts/FilterContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { useTheme } from '../../contexts/ThemeContext';
import styles from './Header.module.css';

export default function Header({ onToggleSidebar, onToggleStats, activeView, onViewChange, onAddTask }) {
  const { activeProject } = useProjects();
  const { setSearchQuery } = useFilters();
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const { theme, toggleTheme } = useTheme();

  const [localSearch, setLocalSearch] = useState('');
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClick = (e) => {
      if (notifRef.current && !notifRef.current.contains(e.target)) {
        setNotifOpen(false);
      }
    };
    if (notifOpen) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [notifOpen]);

  const handleSearchChange = (e) => {
    setLocalSearch(e.target.value);
    setSearchQuery(e.target.value);
  };

  const views = ['board', 'list', 'timeline'];

  return (
    <header className={styles.header}>
      <div className={styles.logo}>
        <button
          className={`${styles.iconBtn} ${styles.menuBtn}`}
          onClick={onToggleSidebar}
          title="Menu"
        >
          &#9776;
        </button>
        <div className={styles.logoIcon}>K</div>
        <h1 className={styles.logoTitle}>Kanban</h1>
        {activeProject && (
          <span className={styles.projectName}>
            {activeProject.emoji || ''} {activeProject.name || activeProject.id}
          </span>
        )}
      </div>
      <div className={styles.headerActions}>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search tasks..."
          value={localSearch}
          onChange={handleSearchChange}
        />
        <div className={styles.viewToggleGroup}>
          {views.map(v => (
            <button
              key={v}
              className={`${styles.viewToggleBtn} ${activeView === v ? styles.viewToggleBtnActive : ''}`}
              onClick={() => onViewChange?.(v)}
              title={`${v.charAt(0).toUpperCase() + v.slice(1)} view`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
        <div className={styles.notifWrap} ref={notifRef}>
          <button
            className={styles.iconBtn}
            onClick={() => setNotifOpen(prev => !prev)}
            title="Notifications"
          >
            &#128276;
            {unreadCount > 0 && (
              <span className={styles.notifBadge}>{unreadCount}</span>
            )}
          </button>
          {notifOpen && (
            <div className={styles.notifDropdown}>
              <div className={styles.notifHeader}>
                <span>Notifications</span>
                {unreadCount > 0 && (
                  <button className={styles.notifMarkRead} onClick={() => { markAllRead(); }}>Mark all read</button>
                )}
              </div>
              <div className={styles.notifList}>
                {notifications.length === 0 ? (
                  <div className={styles.notifEmpty}>No notifications</div>
                ) : notifications.slice(0, 20).map(n => (
                  <div key={n.id} className={`${styles.notifItem} ${!n.is_read && !n.read ? styles.notifUnread : ''}`}>
                    <div className={styles.notifText}>
                      <strong>{n.task_title}</strong>
                      <span> moved from {n.from_col} → {n.to_col}</span>
                    </div>
                    <div className={styles.notifMeta}>
                      <span>{n.changed_by}</span>
                      <span>{new Date(n.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <button
          className={styles.iconBtn}
          onClick={toggleTheme}
          title="Toggle light/dark theme"
        >
          {theme === 'dark' ? '\u2600\uFE0F' : '\uD83C\uDF19'}
        </button>
        <button
          className={styles.filterBtn}
          onClick={onToggleStats}
        >
          &#128202; Stats
        </button>
        {onAddTask && (
          <button className={styles.btnAdd} onClick={onAddTask}>
            + New Task
          </button>
        )}
      </div>
    </header>
  );
}
