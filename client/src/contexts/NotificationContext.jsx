import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { listNotifications, markNotificationsRead, deleteNotification as apiDeleteNotification } from '../api/notifications';
import { useProjects } from './ProjectContext';

const NotificationContext = createContext();

export function NotificationProvider({ children }) {
  const { activeProjectId } = useProjects();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const intervalRef = useRef(null);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await listNotifications();
      const list = Array.isArray(data) ? data : (data.items || []);
      setNotifications(list);
      setUnreadCount(list.filter(n => !n.is_read && !n.read).length);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    }
  }, []);

  useEffect(() => {
    loadNotifications();
    intervalRef.current = setInterval(loadNotifications, 30000);
    return () => clearInterval(intervalRef.current);
  }, [loadNotifications]);

  // SSE: reload notifications when task events arrive
  useEffect(() => {
    if (!activeProjectId) return;

    const es = new EventSource(`/api/events?projectId=${activeProjectId}`);

    const handleTaskEvent = () => loadNotifications();
    es.addEventListener('task.updated', handleTaskEvent);
    es.addEventListener('task.created', handleTaskEvent);
    es.addEventListener('log.created', handleTaskEvent);

    es.onerror = () => es.close();

    return () => es.close();
  }, [activeProjectId, loadNotifications]);

  const markAllRead = useCallback(async () => {
    try {
      await markNotificationsRead();
      setNotifications(prev => prev.map(n => ({ ...n, is_read: 1, read: true })));
      setUnreadCount(0);
    } catch (err) {
      console.error('Failed to mark notifications read:', err);
    }
  }, []);

  const deleteNotification = useCallback(async (id) => {
    try {
      await apiDeleteNotification(id);
      setNotifications(prev => {
        const updated = prev.filter(n => n.id !== id);
        setUnreadCount(updated.filter(n => !n.is_read && !n.read).length);
        return updated;
      });
    } catch (err) {
      console.error('Failed to delete notification:', err);
    }
  }, []);

  return (
    <NotificationContext.Provider value={{
      notifications,
      unreadCount,
      loadNotifications,
      markAllRead,
      deleteNotification,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) throw new Error('useNotifications must be used within a NotificationProvider');
  return context;
}
