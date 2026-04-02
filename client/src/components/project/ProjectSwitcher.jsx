import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useProjects } from '../../contexts/ProjectContext';
import styles from './ProjectSwitcher.module.css';

export default function ProjectSwitcher({ onClose }) {
  const { projects, activeProjectId, setActiveProject } = useProjects();
  const [query, setQuery] = useState('');
  const [focusIndex, setFocusIndex] = useState(0);
  const inputRef = useRef(null);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return projects;
    return projects.filter(p =>
      (p.name || p.id).toLowerCase().includes(q) ||
      (p.emoji || '').includes(q)
    );
  }, [projects, query]);

  useEffect(() => {
    setFocusIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const select = useCallback((projectId) => {
    setActiveProject(projectId);
    onClose();
  }, [setActiveProject, onClose]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex(prev => Math.min(prev + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[focusIndex]) {
        select(filtered[focusIndex].id);
      }
    }
  }, [onClose, filtered, focusIndex, select]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.panel}>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="Switch project..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        <div className={styles.list}>
          {filtered.length === 0 && (
            <div className={styles.empty}>No matching projects</div>
          )}
          {filtered.map((p, i) => (
            <div
              key={p.id}
              className={`${styles.item} ${i === focusIndex ? styles.itemFocused : ''}`}
              onClick={() => select(p.id)}
            >
              <span className={styles.emoji}>{p.emoji || '\u{1F4CB}'}</span>
              <span className={styles.name}>{p.name || p.id}</span>
              {p.id === activeProjectId && (
                <span className={styles.activeBadge}>Active</span>
              )}
            </div>
          ))}
        </div>
        <div className={styles.hint}>
          {'\u2191\u2193'} Navigate {'\u00B7'} Enter Select {'\u00B7'} Esc Close
        </div>
      </div>
    </div>
  );
}
