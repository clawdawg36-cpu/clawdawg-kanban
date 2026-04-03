import { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react';
import styles from './Toast.module.css';

const ToastContext = createContext();

let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef({});

  const removeToast = useCallback((id) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((message, type = 'info', onUndo) => {
    const id = ++nextId;
    const duration = type === 'undo' ? 5000 : 5000;
    setToasts(prev => [...prev, { id, message, type, onUndo, createdAt: Date.now(), duration }]);
    timersRef.current[id] = setTimeout(() => removeToast(id), duration);
    return id;
  }, [removeToast]);

  const handleUndo = useCallback((id, callback) => {
    clearTimeout(timersRef.current[id]);
    delete timersRef.current[id];
    if (callback) callback();
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useMemo(() => ({
    error: (msg) => addToast(msg, 'error'),
    success: (msg) => addToast(msg, 'success'),
    info: (msg) => addToast(msg, 'info'),
    undo: (msg, onUndo) => addToast(msg, 'undo', onUndo),
  }), [addToast]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={styles.container}>
        {toasts.map(t => (
          <div key={t.id} className={`${styles.toast} ${styles[t.type] || styles.info}`}>
            <span className={styles.message}>{t.message}</span>
            {t.type === 'undo' && (
              <button
                className={styles.undoBtn}
                onClick={() => handleUndo(t.id, t.onUndo)}
              >
                Undo
              </button>
            )}
            <button className={styles.dismiss} onClick={() => removeToast(t.id)}>
              &#10005;
            </button>
            {t.type === 'undo' && (
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressBar}
                  style={{ animationDuration: `${t.duration}ms` }}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}

export default ToastProvider;
