import { useState, useRef, useEffect, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useTasks } from '../../contexts/TaskContext';
import styles from './TaskCard.module.css';

const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_ICONS = { urgent: '\uD83D\uDD34', high: '\uD83D\uDFE0', medium: '\uD83D\uDD35', low: '\uD83D\uDFE2' };

const COL_ORDER = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];
const COL_ABBREV = {
  'idea': 'IDEA',
  'backlog': 'BL',
  'in-progress': 'IP',
  'in-review': 'IR',
  'done': 'DONE',
};
const COL_LABELS = {
  'idea': 'Idea',
  'backlog': 'Backlog',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'done': 'Done',
};

function getDueBadge(dueDate, column) {
  if (!dueDate || column === 'done') return null;
  const now = new Date();
  const due = new Date(dueDate + 'T23:59:59');
  const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return { label: `Overdue by ${Math.abs(diffDays)}d`, className: styles.overdue, emoji: '\u26A0\uFE0F' };
  } else if (diffDays === 0) {
    return { label: 'Due today', className: styles.dueSoon, emoji: '\u23F0' };
  } else if (diffDays <= 3) {
    return { label: `Due in ${diffDays}d`, className: styles.dueSoon, emoji: '\uD83D\uDCC5' };
  }
  return { label: `Due in ${diffDays}d`, className: styles.onTime, emoji: '\uD83D\uDCC5' };
}

function getScheduledLabel(startAfter) {
  if (!startAfter) return null;
  const start = new Date(startAfter);
  const now = new Date();
  if (start <= now) return null;

  const diffMs = start - now;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays === 0) return 'Scheduled: Today';
  if (diffDays === 1) return 'Scheduled: Tomorrow';
  return `Scheduled: in ${diffDays}d`;
}

function getAvatarClass(assignee) {
  if (!assignee) return styles.avatarDefault;
  const lower = assignee.toLowerCase();
  if (lower === 'mike') return styles.avatarMike;
  if (lower === 'clawdawg') return styles.avatarClawdawg;
  return styles.avatarDefault;
}

function getInitials(name) {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

export default function TaskCard({ task, onClick, isBlocked, onArchive, onDelete }) {
  const { moveTask } = useTasks();
  const [showColMenu, setShowColMenu] = useState(false);
  const colMenuRef = useRef(null);
  const longPressRef = useRef(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isIdea = task.column === 'idea';
  const isOverdue = task.dueDate && task.column !== 'done' && new Date(task.dueDate + 'T23:59:59') < new Date();
  const isFutureScheduled = task.startAfter && new Date(task.startAfter) > new Date();

  const dueBadge = getDueBadge(task.dueDate, task.column);
  const scheduledLabel = getScheduledLabel(task.startAfter);

  const priorityBarClass = styles[`priority${task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium'}`];
  const priorityBadgeClass = styles[`priorityBadge${task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : 'Medium'}`];

  const subtasks = task.subtasks || [];
  const subtasksDone = subtasks.filter(s => s.done).length;
  const subtasksTotal = subtasks.length;

  const cardClasses = [
    styles.card,
    isDragging && styles.dragging,
    isIdea && styles.ideaCard,
    isOverdue && styles.overdueCard,
    isFutureScheduled && styles.scheduledFuture,
    isBlocked && styles.blockedCard,
    task.archived && styles.archivedCard,
  ].filter(Boolean).join(' ');

  // Column pill: cycle to next column on click
  const handlePillClick = useCallback((e) => {
    e.stopPropagation();
    const idx = COL_ORDER.indexOf(task.column);
    const nextIdx = (idx + 1) % COL_ORDER.length;
    moveTask(task.id, COL_ORDER[nextIdx]);
  }, [task.id, task.column, moveTask]);

  // Column pill: show dropdown on right-click or long-press
  const handlePillContext = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setShowColMenu(prev => !prev);
  }, []);

  const handlePillTouchStart = useCallback((e) => {
    longPressRef.current = setTimeout(() => {
      e.stopPropagation();
      setShowColMenu(true);
    }, 500);
  }, []);

  const handlePillTouchEnd = useCallback(() => {
    clearTimeout(longPressRef.current);
  }, []);

  const handleColSelect = useCallback((e, col) => {
    e.stopPropagation();
    if (col !== task.column) {
      moveTask(task.id, col);
    }
    setShowColMenu(false);
  }, [task.id, task.column, moveTask]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showColMenu) return;
    const handleClick = (e) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target)) {
        setShowColMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick);
    };
  }, [showColMenu]);

  const pillColorClass = styles[`pill${task.column === 'idea' ? 'Idea' : task.column === 'backlog' ? 'Backlog' : task.column === 'in-progress' ? 'InProgress' : task.column === 'in-review' ? 'InReview' : 'Done'}`];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cardClasses}
      onClick={() => onClick?.(task)}
      {...attributes}
      {...listeners}
    >
      <div className={`${styles.priorityBar} ${priorityBarClass}`} />

      {isBlocked && (
        <div className={styles.blockedBanner}>
          <span>{'\uD83D\uDD12'}</span> Blocked
        </div>
      )}

      <div className={styles.badgeRow}>
        {task.priority && (
          <span className={`${styles.priorityBadge} ${priorityBadgeClass}`}>
            {PRIORITY_ICONS[task.priority]} {PRIORITY_LABELS[task.priority]}
          </span>
        )}
        {task.wave != null && task.wave !== '' && (
          <span className={styles.waveBadge}>
            &#127754; Wave {task.wave}
          </span>
        )}
        {task.recurring && (
          <span className={styles.recurringBadge}>
            &#128260; {task.recurring}
          </span>
        )}
      </div>

      <div className={styles.cardTitle}>{task.title}</div>

      {task.description && (
        <div className={styles.cardDesc}>{task.description}</div>
      )}

      {task.tags && task.tags.length > 0 && (
        <div className={styles.cardTags}>
          {task.tags.map((tag, i) => (
            <span key={i} className={styles.tag}>{tag}</span>
          ))}
        </div>
      )}

      {dueBadge && (
        <div className={`${styles.dueBadge} ${dueBadge.className}`}>
          {dueBadge.emoji} {dueBadge.label}
        </div>
      )}

      {scheduledLabel && (
        <div className={styles.scheduledBadge}>
          &#128197; {scheduledLabel}
        </div>
      )}

      {subtasksTotal > 0 && (
        <div className={`${styles.subtaskProgress} ${subtasksDone === subtasksTotal ? styles.allDone : ''}`}>
          &#9745; {subtasksDone}/{subtasksTotal}
        </div>
      )}

      <div className={styles.cardMeta}>
        {task.assignee && (
          <span className={styles.cardAssignee}>
            <span className={`${styles.avatar} ${getAvatarClass(task.assignee)}`}>
              {getInitials(task.assignee)}
            </span>
            {task.assignee}
          </span>
        )}
        {task.createdAt && (
          <span className={styles.cardDate}>
            {new Date(task.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </div>

      {/* Column quick-change pill */}
      <div className={styles.pillWrapper} ref={colMenuRef}>
        <button
          className={`${styles.colPill} ${pillColorClass}`}
          onClick={handlePillClick}
          onContextMenu={handlePillContext}
          onTouchStart={handlePillTouchStart}
          onTouchEnd={handlePillTouchEnd}
          title={`${COL_LABELS[task.column]} — click to advance, right-click to pick`}
        >
          {COL_ABBREV[task.column] || task.column}
        </button>
        {showColMenu && (
          <div className={styles.colDropdown}>
            {COL_ORDER.map(col => (
              <button
                key={col}
                className={`${styles.colDropdownItem} ${col === task.column ? styles.colDropdownActive : ''}`}
                onClick={(e) => handleColSelect(e, col)}
              >
                <span className={`${styles.colDropdownDot} ${styles[`pill${col === 'idea' ? 'Idea' : col === 'backlog' ? 'Backlog' : col === 'in-progress' ? 'InProgress' : col === 'in-review' ? 'InReview' : 'Done'}`]}`} />
                {COL_LABELS[col]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.cardActions}>
        {onArchive && (
          <button
            className={styles.cardActionBtn}
            onClick={(e) => { e.stopPropagation(); onArchive(task.id); }}
            title="Archive"
          >
            &#128230;
          </button>
        )}
        {onDelete && (
          <button
            className={`${styles.cardActionBtn} ${styles.cardActionDelete}`}
            onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
            title="Delete"
          >
            &#128465;
          </button>
        )}
      </div>
    </div>
  );
}
