import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  listTasks,
  createTask as apiCreateTask,
  updateTask as apiUpdateTask,
  deleteTask as apiDeleteTask,
  patchTask as apiPatchTask,
  archiveTask as apiArchiveTask,
  unarchiveTask as apiUnarchiveTask,
  archiveDoneTasks,
} from '../api/tasks';
import { useProjects } from './ProjectContext';

const TaskContext = createContext();

export function TaskProvider({ children }) {
  const { activeProjectId } = useProjects();
  const [tasks, setTasks] = useState([]);
  const [archivedTasks, setArchivedTasks] = useState([]);
  const [showingArchived, setShowingArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadTasks = useCallback(async () => {
    if (!activeProjectId) return;
    setLoading(true);
    setError(null);
    try {
      // Paginate to fetch all tasks
      const pageSize = 200;
      let offset = 0;
      let allTasks = [];

      while (true) {
        const data = await listTasks({
          projectId: activeProjectId,
          limit: pageSize,
          offset,
        });

        if (Array.isArray(data)) {
          allTasks = data;
          break;
        }

        const items = Array.isArray(data.items) ? data.items : [];
        allTasks = allTasks.concat(items);

        if (items.length === 0 || allTasks.length >= (data.total || 0)) {
          break;
        }
        offset += data.limit || pageSize;
      }

      setTasks(allTasks);
    } catch (err) {
      console.error('Failed to load tasks:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activeProjectId]);

  const loadArchivedTasks = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const data = await listTasks({ projectId: activeProjectId, archived: 'true', limit: 200 });
      const items = Array.isArray(data) ? data : (data.items || []);
      setArchivedTasks(items);
    } catch (err) {
      console.error('Failed to load archived tasks:', err);
    }
  }, [activeProjectId]);

  const toggleArchived = useCallback(async () => {
    const next = !showingArchived;
    setShowingArchived(next);
    if (next) await loadArchivedTasks();
  }, [showingArchived, loadArchivedTasks]);

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

  // SSE real-time sync
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const backoffRef = useRef(1000);

  useEffect(() => {
    if (!activeProjectId) return;

    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`/api/events?projectId=${activeProjectId}`);
      eventSourceRef.current = es;

      es.addEventListener('task.updated', (e) => {
        try {
          const { task } = JSON.parse(e.data);
          setTasks(prev => prev.map(t => t.id === task.id ? { ...t, ...task } : t));
        } catch {}
      });

      es.addEventListener('task.created', (e) => {
        try {
          const { task } = JSON.parse(e.data);
          setTasks(prev => prev.some(t => t.id === task.id) ? prev : [...prev, task]);
        } catch {}
      });

      es.addEventListener('task.deleted', (e) => {
        try {
          const { taskId } = JSON.parse(e.data);
          setTasks(prev => prev.filter(t => t.id !== taskId));
        } catch {}
      });

      es.onopen = () => {
        backoffRef.current = 1000;
      };

      es.onerror = () => {
        es.close();
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, 30000);
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, [activeProjectId]);

  const createTask = useCallback(async (data) => {
    const task = await apiCreateTask({ ...data, projectId: activeProjectId });
    setTasks(prev => [...prev, task]);
    return task;
  }, [activeProjectId]);

  const updateTask = useCallback(async (id, data) => {
    const updated = await apiUpdateTask(id, data);
    setTasks(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const deleteTask = useCallback(async (id) => {
    await apiDeleteTask(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  const moveTask = useCallback(async (id, column, sortOrder) => {
    const patchData = { column };
    if (sortOrder != null) patchData.sortOrder = sortOrder;
    // Optimistic update
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patchData } : t));
    const updated = await apiPatchTask(id, patchData);
    setTasks(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const reorderTask = useCallback(async (id, data) => {
    const updated = await apiPatchTask(id, data);
    setTasks(prev => prev.map(t => t.id === id ? updated : t));
    return updated;
  }, []);

  const archiveTask = useCallback(async (id) => {
    await apiArchiveTask(id);
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  const unarchiveTask = useCallback(async (id) => {
    await apiUnarchiveTask(id);
    await loadTasks();
  }, [loadTasks]);

  const archiveAllDone = useCallback(async () => {
    const result = await archiveDoneTasks({ projectId: activeProjectId });
    if (result.archived > 0) {
      await loadTasks();
    }
    return result;
  }, [activeProjectId, loadTasks]);

  return (
    <TaskContext.Provider value={{
      tasks: showingArchived ? archivedTasks : tasks,
      allTasks: tasks,
      archivedTasks,
      showingArchived,
      loading,
      error,
      loadTasks,
      toggleArchived,
      createTask,
      updateTask,
      deleteTask,
      moveTask,
      reorderTask,
      archiveTask,
      unarchiveTask,
      archiveAllDone,
    }}>
      {children}
    </TaskContext.Provider>
  );
}

export function useTasks() {
  const context = useContext(TaskContext);
  if (!context) throw new Error('useTasks must be used within a TaskProvider');
  return context;
}
