import { useEffect } from 'react';
import styles from './KeyboardHelp.module.css';

const SHORTCUTS = [
  { keys: ['N'], desc: 'New task' },
  { keys: ['E'], desc: 'Edit hovered / focused card' },
  { keys: ['Delete', '\u232B'], desc: 'Delete hovered / focused card' },
  { keys: ['/'], desc: 'Focus search input' },
  { keys: ['1', '\u2013', '5'], desc: 'Switch mobile column tab' },
  { keys: ['\u2318K', '/', 'Ctrl K'], desc: 'Project switcher' },
  { keys: ['Esc'], desc: 'Close modal / overlay' },
  { keys: ['?'], desc: 'Show this overlay' },
];

export default function KeyboardHelp({ onClose }) {
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className={styles.box} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>
          <span className={styles.icon}>{'\u2328\uFE0F'}</span>
          <span className={styles.titleText}>Keyboard Shortcuts</span>
        </h2>
        <table className={styles.table}>
          <tbody>
            {SHORTCUTS.map((s, i) => (
              <tr key={i}>
                <td className={styles.keysCell}>
                  {s.keys.map((k, j) => (
                    <kbd key={j} className={styles.kbd}>{k}</kbd>
                  ))}
                </td>
                <td className={styles.descCell}>{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className={styles.closeHint}>
          Press <kbd className={styles.kbd}>Esc</kbd> or click outside to close
        </p>
      </div>
    </div>
  );
}
