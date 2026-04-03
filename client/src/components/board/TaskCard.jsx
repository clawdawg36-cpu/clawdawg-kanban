import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import styles from './TaskCard.module.css';

const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_ICONS = { urgent: '\uD83D\uDD34', high: '\uD83D\uDFE0', medium: '\uD83D\uDD35', low: '\uD83D\uDFE2' };

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

export default function TaskCard({ task, onClick, isBlocked }) {
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
          <span>\uD83D\uDD12</span> Blocked
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
    </div>
  );
}
