import { useState } from 'react';
import { useProjects } from '../../contexts/ProjectContext';
import { useFilters } from '../../contexts/FilterContext';
import { useNotifications } from '../../contexts/NotificationContext';
import { useTheme } from '../../contexts/ThemeContext';
import styles from './Header.module.css';

export default function Header({ onToggleSidebar, onToggleStats, activeView, onViewChange }) {
  const { activeProject } = useProjects();
  const { setSearchQuery } = useFilters();
  const { unreadCount } = useNotifications();
  const { theme, toggleTheme } = useTheme();

  const [localSearch, setLocalSearch] = useState('');

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
        <button
          className={styles.iconBtn}
          onClick={() => {}}
          title="Notifications"
        >
          &#128276;
          {unreadCount > 0 && (
            <span className={styles.notifBadge}>{unreadCount}</span>
          )}
        </button>
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
      </div>
    </header>
  );
}
