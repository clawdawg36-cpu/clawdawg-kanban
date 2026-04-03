import { useState, useRef, useCallback } from 'react';
import { useTasks } from '../contexts/TaskContext';
import { useToast } from '../components/layout/Toast';
import { deleteTask as apiDeleteTask } from '../api/tasks';

export default function useUndoDelete() {
  const { allTasks, removeTaskLocally, restoreTask } = useTasks();
  const toast = useToast();
  const [pendingDelete, setPendingDelete] = useState(null);
  const timerRef = useRef(null);

  const requestDelete = useCallback((taskId) => {
    const task = (allTasks || []).find(t => t.id === taskId);
    if (!task) return;

    // Clear any previous pending delete — flush it immediately
    if (timerRef.current) {
      clearTimeout(timerRef.current.timeout);
      apiDeleteTask(timerRef.current.taskId).catch(() => {});
      timerRef.current = null;
    }

    // Optimistically remove from local state
    removeTaskLocally(taskId);

    const pending = { taskId, task };
    setPendingDelete(pending);

    // Show undo toast
    toast.undo(`Deleted: ${task.title}`, () => {
      // Undo callback — cancel the API call and restore
      if (timerRef.current && timerRef.current.taskId === taskId) {
        clearTimeout(timerRef.current.timeout);
        timerRef.current = null;
      }
      restoreTask(task);
      setPendingDelete(null);
    });

    // Schedule actual API delete after 5 seconds
    const timeout = setTimeout(async () => {
      try {
        await apiDeleteTask(taskId);
      } catch (e) {
        console.error('Failed to delete task:', e);
      }
      setPendingDelete(null);
      timerRef.current = null;
    }, 5000);

    timerRef.current = { timeout, taskId };
  }, [allTasks, removeTaskLocally, restoreTask, toast]);

  const undoDelete = useCallback(() => {
    if (!pendingDelete) return;
    if (timerRef.current) {
      clearTimeout(timerRef.current.timeout);
      timerRef.current = null;
    }
    restoreTask(pendingDelete.task);
    setPendingDelete(null);
  }, [pendingDelete, restoreTask]);

  return { requestDelete, undoDelete, pendingDelete };
}
