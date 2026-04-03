import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import TaskCard from './TaskCard';
import styles from './Column.module.css';

const COL_META = {
  'idea': { label: 'Idea', dotClass: 'dotIdea' },
  'backlog': { label: 'Backlog', dotClass: 'dotBacklog' },
  'in-progress': { label: 'In Progress', dotClass: 'dotInProgress' },
  'in-review': { label: 'In Review', dotClass: 'dotInReview' },
  'done': { label: 'Done', dotClass: 'dotDone' },
};

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];
const PRIORITY_META = {
  urgent: { label: 'Urgent', emoji: '\uD83D\uDD34', color: 'var(--red)' },
  high:   { label: 'High',   emoji: '\uD83D\uDFE0', color: 'var(--orange)' },
  medium: { label: 'Medium', emoji: '\uD83D\uDD35', color: 'var(--blue)' },
  low:    { label: 'Low',    emoji: '\uD83D\uDFE2', color: 'var(--green)' },
};

export default function Column({ columnId, tasks: rawTasks, onCardClick, onArchiveTask, onDeleteTask, onArchiveAllDone, blockedTaskIds, hasActiveFilters, mobileActive }) {
  const meta = COL_META[columnId] || { label: columnId, dotClass: '' };

  const { setNodeRef, isOver } = useDroppable({ id: columnId });

  // Sort tasks by sortOrder within column
  const tasks = [...rawTasks].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  // Group by priority
  const grouped = {};
  PRIORITY_ORDER.forEach(p => { grouped[p] = []; });
  tasks.forEach(t => {
    const p = PRIORITY_ORDER.includes(t.priority) ? t.priority : 'low';
    grouped[p].push(t);
  });
  const activeTiers = PRIORITY_ORDER.filter(p => grouped[p].length > 0);
  const showSwimlanes = activeTiers.length >= 2;

  const taskIds = tasks.map(t => t.id);

  return (
    <div className={`${styles.column} ${mobileActive ? styles.mobileActive : ''}`}>
      <div className={styles.columnHeader}>
        <span className={styles.columnTitle}>
          <span className={`${styles.columnDot} ${styles[meta.dotClass]}`} />
          {meta.label}
        </span>
        <div className={styles.headerRight}>
          <span className={styles.columnCount}>{tasks.length}</span>
          {columnId === 'done' && tasks.length > 0 && onArchiveAllDone && (
            <button className={styles.archiveAllBtn} onClick={onArchiveAllDone} title="Archive all done tasks">
              &#128230; Archive All
            </button>
          )}
        </div>
      </div>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`${styles.cardList} ${isOver ? styles.dragOver : ''}`}
        >
          {tasks.length === 0 && (
            <div className={styles.noResults}>
              {hasActiveFilters ? 'No matching cards' : (
                <>
                  <div style={{ opacity: 0.6, fontSize: 20, marginBottom: 6 }}>&#128237;</div>
                  No tasks yet
                </>
              )}
            </div>
          )}

          {showSwimlanes ? (
            PRIORITY_ORDER.map(p => {
              if (!grouped[p].length) return null;
              const pmeta = PRIORITY_META[p];
              return (
                <div key={p}>
                  <div className={styles.swimlaneHeader}>
                    <span className={styles.swimlaneLabel} style={{ color: pmeta.color }}>
                      {pmeta.emoji} {pmeta.label}
                    </span>
                    <span className={styles.swimlaneLine} />
                  </div>
                  {grouped[p].map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onClick={onCardClick}
                      isBlocked={blockedTaskIds?.has(task.id)}
                      onArchive={onArchiveTask}
                      onDelete={onDeleteTask}
                    />
                  ))}
                </div>
              );
            })
          ) : (
            tasks.map(task => (
              <TaskCard
                key={task.id}
                task={task}
                onClick={onCardClick}
                isBlocked={blockedTaskIds?.has(task.id)}
                onArchive={onArchiveTask}
                onDelete={onDeleteTask}
              />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}
