import { createContext, useContext, useState, useEffect, useCallback } from 'react';
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

  useEffect(() => {
    loadTasks();
  }, [loadTasks]);

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

  const moveTask = useCallback(async (id, column) => {
    const updated = await apiPatchTask(id, { column });
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
      tasks,
      loading,
      error,
      loadTasks,
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
