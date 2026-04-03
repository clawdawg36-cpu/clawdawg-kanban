import { useCallback } from 'react';
import { PointerSensor, KeyboardSensor, useSensor, useSensors } from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

const COL_ORDER = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];

export default function useDragDrop({ tasks, moveTask }) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

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
      const overTask = tasks.find(t => t.id === overId);
      if (overTask) targetCol = overTask.column;
    }

    if (!targetCol) return;

    const draggedTask = tasks.find(t => t.id === taskId);
    if (!draggedTask || draggedTask.column === targetCol) return;

    moveTask(taskId, targetCol);
  }, [tasks, moveTask]);

  return { sensors, handleDragEnd };
}
