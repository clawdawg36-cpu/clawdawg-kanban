import { useMemo, useCallback } from 'react';
import { DndContext, DragOverlay, closestCorners, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useTasks } from '../../contexts/TaskContext';
import { useFilters } from '../../contexts/FilterContext';
import Column from './Column';
import styles from './Board.module.css';

const COL_ORDER = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];

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

export default function Board({ onCardClick }) {
  const { tasks, loading, error, loadTasks, moveTask, archiveAllDone } = useTasks();
  const { matchesSearch, hasActiveFilters } = useFilters();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

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

    // Determine target column
    let targetCol = null;
    if (COL_ORDER.includes(overId)) {
      targetCol = overId;
    } else {
      // Dropped over another card — find which column that card is in
      const overTask = tasks.find(t => t.id === overId);
      if (overTask) targetCol = overTask.column;
    }

    if (!targetCol) return;

    const draggedTask = tasks.find(t => t.id === taskId);
    if (!draggedTask || draggedTask.column === targetCol) return;

    moveTask(taskId, targetCol);
  }, [tasks, moveTask]);

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
      <div className={styles.board}>
        {COL_ORDER.map(col => (
          <Column
            key={col}
            columnId={col}
            tasks={columnTasks[col]}
            onCardClick={onCardClick}
            onArchiveAllDone={col === 'done' ? archiveAllDone : undefined}
            blockedTaskIds={blockedTaskIds}
            hasActiveFilters={hasActiveFilters}
          />
        ))}
      </div>
    </DndContext>
  );
}
