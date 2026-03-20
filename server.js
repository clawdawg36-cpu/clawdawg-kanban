const express = require('express');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = 3456;

const COL_LABELS = { 'backlog': 'Backlog', 'in-progress': 'In Progress', 'in-review': 'In Review', 'done': 'Done' };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all tasks
app.get('/api/tasks', (req, res) => {
  const rows = db.prepare('SELECT * FROM tasks').all();
  res.json(rows.map(row => ({ ...row, tags: JSON.parse(row.tags), subtasks: row.subtasks ? JSON.parse(row.subtasks) : null })));
});

// Create task
app.post('/api/tasks', (req, res) => {
  const task = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: req.body.title || 'Untitled',
    description: req.body.description || '',
    assignee: req.body.assignee || 'Mike',
    priority: req.body.priority || 'medium',
    tags: req.body.tags || [],
    column: req.body.column || 'backlog',
    createdAt: new Date().toISOString(),
    recurring: req.body.recurring || null,
    subtasks: req.body.subtasks || null,
  };
  db.prepare(
    'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, recurring, subtasks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(task.id, task.title, task.description, task.assignee, task.priority, JSON.stringify(task.tags), task.column, task.createdAt, task.recurring, task.subtasks ? JSON.stringify(task.subtasks) : null);

  // Log card creation
  const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  db.prepare(
    'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actId, task.id, 'created', `Card created in ${COL_LABELS[task.column] || task.column}`, task.assignee, task.createdAt);

  res.status(201).json(task);
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const updated = {
    ...existing,
    tags: JSON.parse(existing.tags),
    subtasks: existing.subtasks ? JSON.parse(existing.subtasks) : null,
    ...req.body,
    id: existing.id,
    createdAt: existing.createdAt,
  };

  db.prepare(
    'UPDATE tasks SET title = ?, description = ?, assignee = ?, priority = ?, tags = ?, "column" = ?, dueDate = ?, recurring = ?, subtasks = ? WHERE id = ?'
  ).run(updated.title, updated.description, updated.assignee, updated.priority, JSON.stringify(updated.tags), updated.column, updated.dueDate || null, updated.recurring || null, updated.subtasks ? JSON.stringify(updated.subtasks) : null, updated.id);

  // Auto-log column changes
  if (req.body.column && req.body.column !== existing.column) {
    const now = new Date().toISOString();
    const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    db.prepare(
      'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(actId, existing.id, 'move', `Moved from ${COL_LABELS[existing.column] || existing.column} → ${COL_LABELS[req.body.column] || req.body.column}`, 'System', now);
    // Also track in notifications table
    db.prepare(
      'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(existing.id, existing.title, existing.column, req.body.column, updated.assignee || 'System', now);

    // Recurring task: auto-create new card when moved to done
    if (req.body.column === 'done' && existing.recurring) {
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const newCreatedAt = new Date().toISOString();
      db.prepare(
        'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, recurring, subtasks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(newId, existing.title, existing.description, existing.assignee, existing.priority, existing.tags, 'backlog', newCreatedAt, existing.recurring, null);
      const recActId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      db.prepare(
        'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(recActId, newId, 'created', `Recurring card created (${existing.recurring}) from completed task`, 'System', newCreatedAt);
    }
  }

  res.json(updated);
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Get activity/comments for a task
app.get('/api/tasks/:id/activity', (req, res) => {
  const rows = db.prepare('SELECT * FROM card_activity WHERE taskId = ? ORDER BY createdAt ASC').all(req.params.id);
  res.json(rows);
});

// Add a comment to a task
app.post('/api/tasks/:id/comments', (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });

  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });

  const comment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    taskId: req.params.id,
    type: 'comment',
    content,
    author: req.body.author || 'Mike',
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(comment.id, comment.taskId, comment.type, comment.content, comment.author, comment.createdAt);

  res.status(201).json(comment);
});

// Delete a comment
app.delete('/api/activity/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM card_activity WHERE id = ?').get(req.params.id);
  if (!row || row.type !== 'comment') return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM card_activity WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ─── Notifications ────────────────────────────────────────────────────────────

// Get notifications (recent column change events)
app.get('/api/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows);
});

// Mark all notifications as read
app.post('/api/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
  res.json({ ok: true });
});

// Dismiss / delete a notification
app.delete('/api/notifications/:id', (req, res) => {
  db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// --- Task Dependencies ---

// Get all dependencies (full map)
app.get('/api/dependencies', (req, res) => {
  const rows = db.prepare('SELECT blocker_id, blocked_id FROM task_dependencies').all();
  res.json(rows);
});

// Get blockers for a task (what blocks it)
app.get('/api/tasks/:id/blockers', (req, res) => {
  const rows = db.prepare(`
    SELECT t.* FROM tasks t
    INNER JOIN task_dependencies d ON d.blocker_id = t.id
    WHERE d.blocked_id = ?
  `).all(req.params.id);
  res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags) })));
});

// Add a blocker dependency
app.post('/api/tasks/:id/blockers', (req, res) => {
  const { blocker_id } = req.body;
  const blocked_id = req.params.id;
  if (!blocker_id) return res.status(400).json({ error: 'blocker_id required' });
  if (blocker_id === blocked_id) return res.status(400).json({ error: 'A task cannot block itself' });
  const blockerExists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocker_id);
  const blockedExists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocked_id);
  if (!blockerExists || !blockedExists) return res.status(404).json({ error: 'Task not found' });
  db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blocker_id, blocked_id);
  res.status(201).json({ blocker_id, blocked_id });
});

// Remove a blocker dependency
app.delete('/api/tasks/:id/blockers/:blocker_id', (req, res) => {
  db.prepare('DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?')
    .run(req.params.blocker_id, req.params.id);
  res.status(204).end();
});

// ─── Stats Dashboard ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  // Tasks by assignee
  const assigneeRows = db.prepare('SELECT assignee, COUNT(*) as cnt FROM tasks GROUP BY assignee').all();
  const totalByAssignee = {};
  assigneeRows.forEach(r => { totalByAssignee[r.assignee] = r.cnt; });

  // Column counts
  const colRows = db.prepare('SELECT "column", COUNT(*) as cnt FROM tasks GROUP BY "column"').all();
  const columnCounts = {};
  colRows.forEach(r => { columnCounts[r.column] = r.cnt; });

  // Completed this week (tasks moved to done in last 7 days via card_activity)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const completedThisWeek = db.prepare(
    `SELECT COUNT(DISTINCT taskId) as cnt FROM card_activity WHERE type = 'move' AND content LIKE '%→ Done%' AND createdAt >= ?`
  ).get(weekAgo).cnt;

  // Overdue count
  const now = new Date().toISOString().slice(0, 10);
  const overdueCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks WHERE dueDate IS NOT NULL AND dueDate < ? AND "column" != 'done'`
  ).get(now).cnt;

  // Average time to complete (seconds from createdAt to move-to-done activity)
  const completionRows = db.prepare(`
    SELECT t.createdAt as taskCreated, MIN(a.createdAt) as doneAt
    FROM tasks t
    INNER JOIN card_activity a ON a.taskId = t.id AND a.type = 'move' AND a.content LIKE '%→ Done%'
    WHERE t."column" = 'done'
    GROUP BY t.id
  `).all();
  let avgTimeToComplete = 0;
  if (completionRows.length > 0) {
    const totalSec = completionRows.reduce((sum, r) => {
      return sum + (new Date(r.doneAt).getTime() - new Date(r.taskCreated).getTime()) / 1000;
    }, 0);
    avgTimeToComplete = Math.round(totalSec / completionRows.length);
  }

  res.json({ totalByAssignee, completedThisWeek, overdueCount, columnCounts, avgTimeToComplete });
});

app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});
