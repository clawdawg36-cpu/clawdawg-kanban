import { createContext, useContext, useState, useCallback, useMemo } from 'react';

const FilterContext = createContext();

export function FilterProvider({ children }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [waveFilter, setWaveFilter] = useState('');
  const [agentStatusFilter, setAgentStatusFilter] = useState('');
  const [showBlocked, setShowBlocked] = useState(false);
  const [showOverdue, setShowOverdue] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const resetFilters = useCallback(() => {
    setSearchQuery('');
    setPriorityFilter('');
    setAssigneeFilter('');
    setWaveFilter('');
    setAgentStatusFilter('');
    setShowBlocked(false);
    setShowOverdue(false);
    setShowArchived(false);
  }, []);

  const matchesSearch = useCallback((task) => {
    const q = searchQuery.toLowerCase().trim();
    if (q) {
      const inTitle = task.title && task.title.toLowerCase().includes(q);
      const inDesc = task.description && task.description.toLowerCase().includes(q);
      const inTags = (task.tags || []).some(tag => tag.toLowerCase().includes(q));
      const inAssignee = task.assignee && task.assignee.toLowerCase().includes(q);
      if (!inTitle && !inDesc && !inTags && !inAssignee) return false;
    }
    if (priorityFilter && task.priority !== priorityFilter) return false;
    if (assigneeFilter && task.assignee !== assigneeFilter) return false;
    if (waveFilter !== '') {
      const waveNum = waveFilter === 'none' ? null : parseInt(waveFilter, 10);
      if (waveNum === null) {
        if (task.wave != null && task.wave !== '') return false;
      } else {
        if (task.wave == null || parseInt(task.wave, 10) !== waveNum) return false;
      }
    }
    if (agentStatusFilter) {
      const agentCol = task.agentStatus || task.column;
      if (agentCol !== agentStatusFilter) return false;
    }
    if (showBlocked) {
      const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      if (blockers.length === 0) return false;
    }
    if (showOverdue) {
      if (!task.dueDate) return false;
      const due = new Date(task.dueDate + 'T23:59:59');
      if (due >= new Date() || task.column === 'done') return false;
    }
    return true;
  }, [searchQuery, priorityFilter, assigneeFilter, waveFilter, agentStatusFilter, showBlocked, showOverdue]);

  const hasActiveFilters = useMemo(() => {
    return !!(searchQuery || priorityFilter || assigneeFilter || waveFilter || agentStatusFilter || showBlocked || showOverdue);
  }, [searchQuery, priorityFilter, assigneeFilter, waveFilter, agentStatusFilter, showBlocked, showOverdue]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (searchQuery) count++;
    if (priorityFilter) count++;
    if (assigneeFilter) count++;
    if (waveFilter) count++;
    if (agentStatusFilter) count++;
    if (showBlocked) count++;
    if (showOverdue) count++;
    return count;
  }, [searchQuery, priorityFilter, assigneeFilter, waveFilter, agentStatusFilter, showBlocked, showOverdue]);

  return (
    <FilterContext.Provider value={{
      searchQuery, setSearchQuery,
      priorityFilter, setPriorityFilter,
      assigneeFilter, setAssigneeFilter,
      waveFilter, setWaveFilter,
      agentStatusFilter, setAgentStatusFilter,
      showBlocked, setShowBlocked,
      showOverdue, setShowOverdue,
      showArchived, setShowArchived,
      resetFilters,
      matchesSearch,
      hasActiveFilters,
      activeFilterCount,
    }}>
      {children}
    </FilterContext.Provider>
  );
}

export function useFilters() {
  const context = useContext(FilterContext);
  if (!context) throw new Error('useFilters must be used within a FilterProvider');
  return context;
}
