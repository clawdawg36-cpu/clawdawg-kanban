import { useState, useEffect, useRef, useCallback } from 'react';
import { useProjects } from '../../contexts/ProjectContext';
import ConfirmDialog from '../modal/ConfirmDialog';
import styles from './ProjectModal.module.css';

const COLORS = ['#6c5ce7', '#00b894', '#e17055', '#0984e3', '#fdcb6e', '#a29bfe'];
const EMOJIS = ['\u{1F4CB}', '\u{1F680}', '\u{1F4A1}', '\u{1F3AF}', '\u{1F525}', '\u2B50'];

export default function ProjectModal({ project, onClose }) {
  const { createProject, updateProject, deleteProject } = useProjects();
  const isEditing = !!project?.id;

  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [emoji, setEmoji] = useState(EMOJIS[0]);
  const [agentModel, setAgentModel] = useState('');
  const [agentTimeout, setAgentTimeout] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const modalRef = useRef(null);
  const nameRef = useRef(null);

  useEffect(() => {
    if (project) {
      setName(project.name || '');
      setColor(project.color || COLORS[0]);
      setEmoji(project.emoji || EMOJIS[0]);
      setAgentModel(project.agentConfig?.model || '');
      setAgentTimeout(project.agentConfig?.timeout ? String(project.agentConfig.timeout) : '');
    }
  }, [project]);

  useEffect(() => {
    setTimeout(() => nameRef.current?.focus(), 50);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const focusable = modalRef.current?.querySelectorAll(
        'input, textarea, select, button, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      nameRef.current?.focus();
      return;
    }

    const payload = {
      name: trimmed,
      color,
      emoji,
    };

    if (agentModel || agentTimeout) {
      payload.agentConfig = {};
      if (agentModel) payload.agentConfig.model = agentModel;
      if (agentTimeout) payload.agentConfig.timeout = Number(agentTimeout);
    }

    try {
      if (isEditing) {
        await updateProject(project.id, payload);
      } else {
        await createProject(payload);
      }
      onClose();
    } catch (err) {
      console.error('Failed to save project:', err);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteProject(project.id);
      onClose();
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const isDefault = project?.id === 'default';

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.modal} ref={modalRef} role="dialog" aria-modal="true">
        <h2 className={styles.title}>
          {isEditing ? 'Edit Project' : 'New Project'}
        </h2>

        <div className={styles.field}>
          <label>Project Name</label>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Project"
          />
        </div>

        <div className={styles.field}>
          <label>Color</label>
          <div className={styles.colorSwatches} role="radiogroup" aria-label="Project color">
            {COLORS.map(c => (
              <div
                key={c}
                className={color === c ? styles.colorSwatchSelected : styles.colorSwatch}
                style={{ background: c }}
                onClick={() => setColor(c)}
                role="radio"
                aria-checked={color === c}
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setColor(c)}
              />
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label>Emoji</label>
          <div className={styles.emojiOptions}>
            {EMOJIS.map(e => (
              <div
                key={e}
                className={emoji === e ? styles.emojiOptionSelected : styles.emojiOption}
                onClick={() => setEmoji(e)}
                tabIndex={0}
                onKeyDown={(ev) => ev.key === 'Enter' && setEmoji(e)}
              >
                {e}
              </div>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label>{'\u{1F916}'} Agent Config (optional)</label>
          <div className={styles.agentConfig}>
            <div>
              <label>Model override</label>
              <input
                type="text"
                value={agentModel}
                onChange={(e) => setAgentModel(e.target.value)}
                placeholder="e.g. anthropic/claude-sonnet-4-5"
              />
            </div>
            <div>
              <label>Timeout (seconds)</label>
              <input
                type="number"
                value={agentTimeout}
                onChange={(e) => setAgentTimeout(e.target.value)}
                placeholder="300"
              />
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          {isEditing && !isDefault ? (
            <button className={styles.btnDelete} onClick={() => setShowDeleteConfirm(true)}>
              {'\u{1F5D1}'} Delete
            </button>
          ) : <div />}
          <div className={styles.rightActions}>
            <button className={styles.btnCancel} onClick={onClose}>Cancel</button>
            <button className={styles.btnSave} onClick={handleSave}>Save Project</button>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Project"
          message={`Are you sure you want to delete "${name}"? All tasks in this project will be lost.`}
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
