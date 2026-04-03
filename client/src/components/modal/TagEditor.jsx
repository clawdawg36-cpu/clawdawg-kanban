import { useState, useRef, useCallback, useEffect } from 'react';
import styles from './TagEditor.module.css';

export default function TagEditor({ tags = [], onChange, allTags = [] }) {
  const [input, setInput] = useState('');
  const [showAC, setShowAC] = useState(false);
  const [acIndex, setAcIndex] = useState(-1);
  const inputRef = useRef(null);

  const suggestions = input.trim()
    ? allTags.filter(t => t.toLowerCase().includes(input.toLowerCase()) && !tags.includes(t))
    : [];

  useEffect(() => {
    setAcIndex(-1);
  }, [input]);

  const addTag = useCallback((tag) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput('');
    setShowAC(false);
    inputRef.current?.focus();
  }, [tags, onChange]);

  const removeTag = useCallback((index) => {
    onChange(tags.filter((_, i) => i !== index));
  }, [tags, onChange]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (acIndex >= 0 && acIndex < suggestions.length) {
        addTag(suggestions[acIndex]);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === 'Backspace' && !input && tags.length > 0) {
      removeTag(tags.length - 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAcIndex(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAcIndex(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Escape') {
      setShowAC(false);
    }
  };

  const handleInputChange = (e) => {
    setInput(e.target.value);
    setShowAC(e.target.value.trim().length > 0);
  };

  return (
    <div className={styles.tagAutocomplete}>
      <div className={styles.chipEditor} onClick={() => inputRef.current?.focus()}>
        {tags.map((tag, i) => (
          <span key={i} className={styles.chip}>
            {tag}
            <button
              type="button"
              className={styles.chipRemove}
              onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              aria-label={`Remove tag ${tag}`}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          className={styles.chipInput}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => input.trim() && setShowAC(true)}
          onBlur={() => setTimeout(() => setShowAC(false), 150)}
          placeholder={tags.length === 0 ? 'Add tag\u2026' : ''}
          autoComplete="off"
        />
      </div>
      {showAC && suggestions.length > 0 && (
        <div className={styles.autocompleteList}>
          {suggestions.map((s, i) => (
            <div
              key={s}
              className={`${styles.autocompleteItem} ${i === acIndex ? styles.autocompleteItemActive : ''}`}
              onMouseDown={(e) => { e.preventDefault(); addTag(s); }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
