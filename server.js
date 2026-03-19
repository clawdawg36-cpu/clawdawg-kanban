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
  res.json(rows.map(row => ({ ...row, tags: JSON.parse(row.tags) })));
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
  };
  db.prepare(
    'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(task.id, task.title, task.description, task.assignee, task.priority, JSON.stringify(task.tags), task.column, task.createdAt);

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
    ...req.body,
    id: existing.id,
    createdAt: existing.createdAt,
  };

  db.prepare(
    'UPDATE tasks SET title = ?, description = ?, assignee = ?, priority = ?, tags = ?, "column" = ? WHERE id = ?'
  ).run(updated.title, updated.description, updated.assignee, updated.priority, JSON.stringify(updated.tags), updated.column, updated.id);

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

app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});
