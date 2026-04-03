import { useMemo, useState } from 'react';
import { useFilters } from '../../contexts/FilterContext';
import { useTasks } from '../../contexts/TaskContext';
import styles from './FilterBar.module.css';

export default function FilterBar() {
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const {
    searchQuery, setSearchQuery,
    priorityFilter, setPriorityFilter,
    assigneeFilter, setAssigneeFilter,
    waveFilter, setWaveFilter,
    agentStatusFilter, setAgentStatusFilter,
    showBlocked, setShowBlocked,
    showOverdue, setShowOverdue,
    showArchived, setShowArchived,
    resetFilters,
    hasActiveFilters,
    matchesSearch,
  } = useFilters();

  const { tasks } = useTasks();

  // Derive unique assignees from tasks
  const assignees = useMemo(() => {
    return [...new Set(tasks.map(t => t.assignee).filter(Boolean))].sort();
  }, [tasks]);

  // Derive unique waves from tasks
  const waves = useMemo(() => {
    return [...new Set(
      tasks.map(t => t.wave).filter(w => w != null && w !== '')
    )].sort((a, b) => Number(a) - Number(b));
  }, [tasks]);

  // Count visible tasks
  const visibleCount = useMemo(() => {
    return tasks.filter(t => matchesSearch(t)).length;
  }, [tasks, matchesSearch]);

  return (
    <div className={styles.searchBar}>
      <div className={styles.searchInputWrap}>
        <span className={styles.searchIcon}>&#128269;</span>
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search title, description, tag, assignee\u2026"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          autoComplete="off"
          spellCheck="false"
        />
        {searchQuery && (
          <button
            className={styles.searchClear}
            onClick={() => setSearchQuery('')}
            title="Clear search"
          >
            &#10005;
          </button>
        )}
      </div>

      <button
        className={`${styles.mobileFilterToggle} ${mobileFiltersOpen ? styles.mobileFilterToggleActive : ''}`}
        onClick={() => setMobileFiltersOpen(prev => !prev)}
        title="Toggle filters"
      >
        &#9776;
        {hasActiveFilters && <span className={styles.filterActiveDot} />}
      </button>

      <div className={`${styles.filters} ${mobileFiltersOpen ? styles.filtersExpanded : ''}`}>
        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Priority</span>
          <select
            className={`${styles.filterSelect} ${priorityFilter ? styles.filterSelectActive : ''}`}
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Assignee</span>
          <select
            className={`${styles.filterSelect} ${assigneeFilter ? styles.filterSelectActive : ''}`}
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          >
            <option value="">All</option>
            {assignees.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Wave</span>
          <select
            className={`${styles.filterSelect} ${waveFilter ? styles.filterSelectActive : ''}`}
            value={waveFilter}
            onChange={(e) => setWaveFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="none">No Wave</option>
            {waves.map(w => (
              <option key={w} value={w}>Wave {w}</option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Agent</span>
          <select
            className={`${styles.filterSelect} ${agentStatusFilter ? styles.filterSelectActive : ''}`}
            value={agentStatusFilter}
            onChange={(e) => setAgentStatusFilter(e.target.value)}
          >
            <option value="">All</option>
            <option value="idle">Idle</option>
            <option value="claimed">Claimed</option>
            <option value="in-progress">In Progress</option>
            <option value="done">Done</option>
          </select>
        </div>

        <div className={styles.toggleGroup}>
          <button
            className={`${styles.toggleBtn} ${showBlocked ? styles.toggleBtnActive : ''}`}
            onClick={() => setShowBlocked(!showBlocked)}
            title="Show only blocked tasks"
          >
            &#128683; Blocked
          </button>
          <button
            className={`${styles.toggleBtn} ${showOverdue ? styles.toggleBtnActive : ''}`}
            onClick={() => setShowOverdue(!showOverdue)}
            title="Show only overdue tasks"
          >
            &#9888;&#65039; Overdue
          </button>
          <button
            className={`${styles.toggleBtn} ${showArchived ? styles.toggleBtnActive : ''}`}
            onClick={() => setShowArchived(!showArchived)}
            title="Show archived tasks"
          >
            &#128230; Archived
          </button>
        </div>

        {hasActiveFilters && (
          <>
            <span className={`${styles.resultsInfo} ${styles.resultsInfoActive}`}>
              {visibleCount} of {tasks.length} cards
            </span>
            <button className={styles.resetBtn} onClick={resetFilters}>
              Reset filters
            </button>
          </>
        )}
      </div>
    </div>
  );
}
