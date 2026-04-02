import { useEffect } from 'react';

function isEditableField(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'textarea', 'select'].includes(tag)) return true;
  if (e.target.isContentEditable) return true;
  return false;
}

export default function useKeyboardShortcuts({
  onNewTask,
  onFocusSearch,
  onToggleKeyboardHelp,
  onToggleSwitcher,
  onCloseOverlay,
  hasOpenOverlay = false,
}) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Cmd+K / Ctrl+K — project switcher (handled even with modifiers)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        onToggleSwitcher?.();
        return;
      }

      // Skip other shortcuts if modifier keys pressed
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // If an overlay is open, only handle Escape
      if (hasOpenOverlay) {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCloseOverlay?.();
        }
        return;
      }

      // Skip if typing in a field
      if (isEditableField(e)) return;

      switch (e.key) {
        case 'n':
        case 'N':
          e.preventDefault();
          onNewTask?.();
          break;

        case '/':
          e.preventDefault();
          onFocusSearch?.();
          break;

        case '?':
          e.preventDefault();
          onToggleKeyboardHelp?.();
          break;

        case 'Escape':
          e.preventDefault();
          onCloseOverlay?.();
          break;

        default:
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onNewTask, onFocusSearch, onToggleKeyboardHelp, onToggleSwitcher, onCloseOverlay, hasOpenOverlay]);
}
