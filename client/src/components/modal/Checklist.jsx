import { useState, useRef } from 'react';
import styles from './Checklist.module.css';

export default function Checklist({ subtasks = [], onChange }) {
  const [newItem, setNewItem] = useState('');
  const inputRef = useRef(null);

  const doneCount = subtasks.filter(s => s.done).length;
  const totalCount = subtasks.length;
  const allDone = totalCount > 0 && doneCount === totalCount;

  const handleAdd = () => {
    const text = newItem.trim();
    if (!text) return;
    onChange([...subtasks, { text, done: false }]);
    setNewItem('');
    inputRef.current?.focus();
  };

  const handleToggle = (index) => {
    const updated = subtasks.map((s, i) =>
      i === index ? { ...s, done: !s.done } : s
    );
    onChange(updated);
  };

  const handleRemove = (index) => {
    onChange(subtasks.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <div className={styles.section}>
      <span className={styles.label}>Checklist</span>
      {totalCount > 0 && (
        <div className={allDone ? styles.progressDone : styles.progress}>
          {doneCount}/{totalCount} done
        </div>
      )}
      <div className={styles.items}>
        {subtasks.map((item, i) => (
          <div key={i} className={styles.item}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => handleToggle(i)}
            />
            <span className={item.done ? styles.itemTextDone : styles.itemText}>
              {item.text}
            </span>
            <button
              type="button"
              className={styles.itemRemove}
              onClick={() => handleRemove(i)}
              aria-label={`Remove ${item.text}`}
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className={styles.addRow}>
        <input
          ref={inputRef}
          type="text"
          className={styles.addInput}
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add checklist item..."
        />
        <button type="button" className={styles.addBtn} onClick={handleAdd}>
          Add
        </button>
      </div>
    </div>
  );
}
