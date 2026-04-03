import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTasks } from '../../contexts/TaskContext';
import { listTemplates } from '../../api/templates';
import TagEditor from './TagEditor';
import Checklist from './Checklist';
import Dependencies from './Dependencies';
import Attachments from './Attachments';
import ActivityLog from './ActivityLog';
import HandoffLog from './HandoffLog';
import AgentLog from './AgentLog';
import ConfirmDialog from './ConfirmDialog';
import styles from './TaskModal.module.css';

const COLUMNS = [
  { value: 'idea', label: 'Idea' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'in-progress', label: 'In Progress' },
  { value: 'in-review', label: 'In Review' },
  { value: 'done', label: 'Done' },
];

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export default function TaskModal({ task, onClose }) {
  const { createTask, updateTask, deleteTask, tasks } = useTasks();
  const isEditing = !!task?.id;

  const [form, setForm] = useState({
    title: '',
    description: '',
    assignee: 'Mike',
    priority: 'medium',
    column: 'backlog',
    dueDate: '',
    startAfter: '',
    recurring: '',
    wave: '',
    tags: [],
    subtasks: [],
  });

  const [titleError, setTitleError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const modalRef = useRef(null);
  const titleRef = useRef(null);

  // Collect all existing tags for autocomplete
  const allTags = useMemo(() => {
    const tagSet = new Set();
    tasks.forEach(t => (t.tags || []).forEach(tag => tagSet.add(tag)));
    return [...tagSet].sort();
  }, [tasks]);

  // Populate form from task
  useEffect(() => {
    if (task) {
      setForm({
        title: task.title || '',
        description: task.description || '',
        assignee: task.assignee || 'Mike',
        priority: task.priority || 'medium',
        column: task.column || 'backlog',
        dueDate: task.dueDate || '',
        startAfter: task.startAfter || '',
        recurring: task.recurring || '',
        wave: task.wave != null ? String(task.wave) : '',
        tags: task.tags || [],
        subtasks: task.subtasks || [],
      });
    }
  }, [task]);

  // Load templates for new tasks
  useEffect(() => {
    if (!isEditing) {
      listTemplates().then(data => {
        const list = Array.isArray(data) ? data : (data.items || []);
        setTemplates(list);
      }).catch(() => {});
    }
  }, [isEditing]);

  // Focus title on open
  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 50);
  }, []);

  // Focus trap + Escape
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
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
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

  const setField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    if (key === 'title') setTitleError(false);
  };

  const handleTemplateChange = (e) => {
    const tid = e.target.value;
    setSelectedTemplate(tid);
    if (!tid) return;
    const tpl = templates.find(t => t.id === tid);
    if (tpl) {
      setForm(prev => ({
        ...prev,
        description: tpl.defaultDescription || prev.description,
        assignee: tpl.defaultAssignee || prev.assignee,
        priority: tpl.defaultPriority || prev.priority,
        column: tpl.defaultColumn || prev.column,
        tags: tpl.defaultTags || prev.tags,
      }));
    }
  };

  const handleSave = async () => {
    const title = form.title.trim();
    if (!title) {
      setTitleError(true);
      titleRef.current?.focus();
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      title,
      description: form.description,
      assignee: form.assignee,
      priority: form.priority,
      column: form.column,
      dueDate: form.dueDate || null,
      startAfter: form.startAfter || null,
      recurring: form.recurring || null,
      wave: form.wave !== '' ? Number(form.wave) : null,
      tags: form.tags,
      subtasks: form.subtasks,
    };

    try {
      if (isEditing) {
        await updateTask(task.id, payload);
      } else {
        await createTask(payload);
      }
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await deleteTask(task.id);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to delete task.');
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div
        className={styles.modal}
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-modal-title"
      >
        <h2 className={styles.title} id="task-modal-title">
          {isEditing ? 'Edit Task' : 'New Task'}
        </h2>

        {/* Template selector (new tasks only) */}
        {!isEditing && templates.length > 0 && (
          <div className={styles.field}>
            <label>Use Template</label>
            <select value={selectedTemplate} onChange={handleTemplateChange}>
              <option value="">&mdash; no template &mdash;</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name || t.title}</option>
              ))}
            </select>
          </div>
        )}

        {/* Title */}
        <div className={`${styles.field} ${titleError ? styles.fieldError : ''}`}>
          <label>Title</label>
          <input
            ref={titleRef}
            type="text"
            value={form.title}
            onChange={(e) => setField('title', e.target.value)}
            placeholder="What needs to be done?"
            required
          />
          {titleError && (
            <div className={styles.fieldErrorMessage}>Title is required.</div>
          )}
        </div>

        {/* Description */}
        <div className={styles.field}>
          <label>Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="Add details..."
          />
        </div>

        {/* Assignee + Priority */}
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label>Assignee</label>
            <select value={form.assignee} onChange={(e) => setField('assignee', e.target.value)}>
              <option value="Mike">Mike</option>
              <option value="ClawDawg">ClawDawg</option>
            </select>
          </div>
          <div className={styles.field}>
            <label>Priority</label>
            <select value={form.priority} onChange={(e) => setField('priority', e.target.value)}>
              {PRIORITIES.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Column + Due Date */}
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label>Column</label>
            <select value={form.column} onChange={(e) => setField('column', e.target.value)}>
              {COLUMNS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.field}>
            <label>Due Date</label>
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setField('dueDate', e.target.value)}
            />
          </div>
        </div>

        {/* Start After + Recurring + Hint */}
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label>Starts After</label>
            <input
              type="datetime-local"
              value={form.startAfter}
              onChange={(e) => setField('startAfter', e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label>{'\u{1F504}'} Recurring</label>
            <input
              type="text"
              value={form.recurring}
              onChange={(e) => setField('recurring', e.target.value)}
              placeholder="daily, weekly, monthly, every:Xh"
              list="recurringOptions"
            />
            <datalist id="recurringOptions">
              <option value="daily" />
              <option value="weekly" />
              <option value="monthly" />
              <option value="every:12h" />
              <option value="every:3d" />
            </datalist>
          </div>
          <div className={`${styles.field} ${styles.recurringHint}`}>
            <small className={styles.recurringHintText}>
              Completing this task auto-respawns it with a startAfter delay matching the interval.
            </small>
          </div>
        </div>

        {/* Wave */}
        <div className={styles.field}>
          <label>{'\u26A1'} Wave (optional)</label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={form.wave}
            onChange={(e) => setField('wave', e.target.value)}
            placeholder="e.g. 0, 1, 2..."
          />
        </div>

        {/* Tags */}
        <div className={styles.field}>
          <label>Tags</label>
          <TagEditor
            tags={form.tags}
            onChange={(tags) => setField('tags', tags)}
            allTags={allTags}
          />
        </div>

        {/* Checklist */}
        <Checklist
          subtasks={form.subtasks}
          onChange={(subtasks) => setField('subtasks', subtasks)}
        />

        {/* Dependencies (existing tasks only) */}
        {isEditing && <Dependencies taskId={task.id} />}

        {/* Attachments (existing tasks only) */}
        {isEditing && <Attachments taskId={task.id} />}

        {/* Error banner */}
        {error && (
          <div className={styles.errorBanner}>
            <span>{'\u26A0\u{FE0F}'}</span>
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className={isEditing ? styles.actionsLeft : styles.actions}>
          {isEditing && (
            <button
              className={styles.btnDelete}
              onClick={() => setShowDeleteConfirm(true)}
            >
              {'\u{1F5D1}'} Delete
            </button>
          )}
          <div className={styles.rightActions}>
            <button className={styles.btnCancel} onClick={onClose}>Cancel</button>
            <button
              className={styles.btnSave}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Task'}
            </button>
          </div>
        </div>

        {/* Activity, Handoff, Agent Log (existing tasks only) */}
        {isEditing && <ActivityLog taskId={task.id} />}
        {isEditing && <HandoffLog taskId={task.id} />}
        {isEditing && (
          <AgentLog
            taskId={task.id}
            isInProgress={task.column === 'in-progress'}
          />
        )}
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Task"
          message={`Are you sure you want to delete "${form.title}"? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
