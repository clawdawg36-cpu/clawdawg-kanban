import { createContext, useContext, useState, useCallback } from 'react';
import { useToast } from '../components/layout/Toast';

const BulkSelectContext = createContext();

export function BulkSelectProvider({ children }) {
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const toast = useToast();

  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);

  const toggleSelection = useCallback((taskId) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const bulkMove = useCallback(async (column) => {
    if (!column || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    try {
      const res = await fetch('/api/tasks/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'move', data: { column } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(`Bulk move failed: ${err.error || res.statusText}`);
        return null;
      }
      const result = await res.json();
      toast.success(`Moved ${result.affected} card${result.affected !== 1 ? 's' : ''}`);
      clearSelection();
      return result;
    } catch (err) {
      toast.error(`Bulk move error: ${err.message}`);
      return null;
    }
  }, [selectedIds, clearSelection, toast]);

  const bulkDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    try {
      const res = await fetch('/api/tasks/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'delete' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(`Bulk delete failed: ${err.error || res.statusText}`);
        return null;
      }
      const result = await res.json();
      toast.success(`Deleted ${result.affected} card${result.affected !== 1 ? 's' : ''}`);
      clearSelection();
      return result;
    } catch (err) {
      toast.error(`Bulk delete error: ${err.message}`);
      return null;
    }
  }, [selectedIds, clearSelection, toast]);

  return (
    <BulkSelectContext.Provider value={{
      selectedIds,
      selectMode,
      toggleSelectMode,
      toggleSelection,
      clearSelection,
      bulkMove,
      bulkDelete,
      selectedCount: selectedIds.size,
    }}>
      {children}
    </BulkSelectContext.Provider>
  );
}

export function useBulkSelect() {
  const context = useContext(BulkSelectContext);
  if (!context) throw new Error('useBulkSelect must be used within a BulkSelectProvider');
  return context;
}
