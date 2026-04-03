import { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useTasks } from '../../contexts/TaskContext';
import { useFilters } from '../../contexts/FilterContext';
import useUndoDelete from '../../hooks/useUndoDelete';
import Column from './Column';
import styles from './Board.module.css';

const COL_ORDER = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];
const COL_LABELS = {
  'idea': 'Idea',
  'backlog': 'Backlog',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'done': 'Done',
};
const COL_LABELS_MOBILE = {
  'idea': 'Idea',
  'backlog': 'Backlog',
  'in-progress': 'In Prog',
  'in-review': 'Review',
  'done': 'Done',
};
const COL_DOT_CLASS = {
  'idea': 'tabDotIdea',
  'backlog': 'tabDotBacklog',
  'in-progress': 'tabDotInProgress',
  'in-review': 'tabDotInReview',
  'done': 'tabDotDone',
};

function LoadingSkeleton() {
  const cols = [
    [{ w: '75%' }, { w: '60%', hasDesc2: true }],
    [{ w: '80%' }, { w: '100%' }, { w: '55%', noDesc: true }],
    [{ w: '100%', hasDesc2: true }, { w: '65%' }],
    [{ w: '70%' }],
    [{ w: '100%' }, { w: '50%', noDesc: true }, { w: '75%', hasDesc2: true }],
  ];

  return (
    <div className={styles.loadingOverlay}>
      {cols.map((cards, ci) => (
        <div key={ci} className={styles.skeletonCol}>
          <div className={styles.skeletonColHeader} />
          {cards.map((c, i) => (
            <div key={i} className={styles.skeletonCard}>
              <div className={`${styles.skeletonLine} ${styles.skeletonTitle}`} style={{ width: c.w }} />
              {!c.noDesc && <div className={`${styles.skeletonLine} ${styles.skeletonDesc}`} />}
              {c.hasDesc2 && <div className={`${styles.skeletonLine} ${styles.skeletonDesc2}`} />}
              <div className={`${styles.skeletonLine} ${styles.skeletonMeta}`} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Board({ onCardClick, onAddTask }) {
  const { tasks, loading, error, loadTasks, moveTask, archiveTask, archiveAllDone } = useTasks();
  const { matchesSearch, hasActiveFilters } = useFilters();
  const { requestDelete } = useUndoDelete();
  const [mobileActiveCol, setMobileActiveCol] = useState('backlog');
  const boardRef = useRef(null);
  const touchStartRef = useRef(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  // Mobile swipe to switch columns
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const SWIPE_THRESHOLD = 50;

    const handleTouchStart = (e) => {
      touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    };

    const handleTouchEnd = (e) => {
      if (!touchStartRef.current) return;
      const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
      const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      // Only horizontal swipes (not scrolling)
      if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dy) > Math.abs(dx)) return;

      setMobileActiveCol(prev => {
        const idx = COL_ORDER.indexOf(prev);
        if (dx < 0 && idx < COL_ORDER.length - 1) return COL_ORDER[idx + 1];
        if (dx > 0 && idx > 0) return COL_ORDER[idx - 1];
        return prev;
      });
    };

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchend', handleTouchEnd);
    };
  }, []);

  // Build blocked set (tasks whose non-done blockers exist)
  // For now, we expose the set; dependency loading can be added later
  const blockedTaskIds = useMemo(() => new Set(), []);

  // Group + filter tasks by column
  const columnTasks = useMemo(() => {
    const result = {};
    COL_ORDER.forEach(col => { result[col] = []; });
    tasks.forEach(task => {
      if (COL_ORDER.includes(task.column) && matchesSearch(task)) {
        result[task.column].push(task);
      }
    });
    return result;
  }, [tasks, matchesSearch]);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    if (!over) return;

    const taskId = active.id;
    const overId = over.id;

    // Determine target column and drop index
    let targetCol = null;
    let overTaskIndex = -1;
    if (COL_ORDER.includes(overId)) {
      targetCol = overId;
    } else {
      const overTask = tasks.find(t => t.id === overId);
      if (overTask) {
        targetCol = overTask.column;
        const colTasks = columnTasks[targetCol] || [];
        overTaskIndex = colTasks.findIndex(t => t.id === overId);
      }
    }

    if (!targetCol) return;

    const draggedTask = tasks.find(t => t.id === taskId);
    if (!draggedTask || draggedTask.column === targetCol) return;

    // Calculate sortOrder based on drop position
    const targetTasks = (columnTasks[targetCol] || [])
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    let sortOrder;
    if (targetTasks.length === 0) {
      sortOrder = 0;
    } else if (overTaskIndex <= 0) {
      // Dropped at start or on column itself
      sortOrder = (targetTasks[0].sortOrder ?? 0) - 1;
    } else if (overTaskIndex >= targetTasks.length - 1) {
      // Dropped at end
      sortOrder = (targetTasks[targetTasks.length - 1].sortOrder ?? 0) + 1;
    } else {
      // Dropped between two cards
      const before = targetTasks[overTaskIndex - 1].sortOrder ?? 0;
      const after = targetTasks[overTaskIndex].sortOrder ?? 0;
      sortOrder = (before + after) / 2;
    }

    moveTask(taskId, targetCol, sortOrder);
  }, [tasks, columnTasks, moveTask]);

  if (loading) return <LoadingSkeleton />;

  if (error) {
    return (
      <div className={styles.errorState}>
        <div className={styles.errorIcon}>&#9888;&#65039;</div>
        <div className={styles.errorTitle}>Failed to load board</div>
        <div className={styles.errorMsg}>{error}</div>
        <button className={styles.retryBtn} onClick={loadTasks}>
          &#8634; Retry
        </button>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={handleDragEnd}
    >
      {/* Mobile column tabs */}
      <div className={styles.mobileColNav}>
        {COL_ORDER.map(col => (
          <button
            key={col}
            className={`${styles.mobileColTab} ${mobileActiveCol === col ? styles.mobileColTabActive : ''}`}
            onClick={() => setMobileActiveCol(col)}
          >
            <span className={`${styles.tabDot} ${styles[COL_DOT_CLASS[col]]}`} />
            <span className={styles.tabLabel}>{COL_LABELS_MOBILE[col]}</span>
            <span className={styles.tabCount}>{columnTasks[col].length}</span>
          </button>
        ))}
      </div>

      <div className={styles.board} ref={boardRef}>
        {COL_ORDER.map(col => (
          <Column
            key={col}
            columnId={col}
            tasks={columnTasks[col]}
            onCardClick={onCardClick}
            onArchiveTask={archiveTask}
            onDeleteTask={requestDelete}
            onArchiveAllDone={col === 'done' ? archiveAllDone : undefined}
            blockedTaskIds={blockedTaskIds}
            hasActiveFilters={hasActiveFilters}
            mobileActive={mobileActiveCol === col}
          />
        ))}
      </div>

      {/* FAB for mobile */}
      {onAddTask && (
        <button className={styles.fab} onClick={onAddTask} title="New task">
          +
        </button>
      )}
    </DndContext>
  );
}
