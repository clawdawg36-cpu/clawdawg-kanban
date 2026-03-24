const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

// ─── Multer config for file uploads ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const PORT = 3456;

const COL_LABELS = { 'backlog': 'Backlog', 'in-progress': 'In Progress', 'in-review': 'In Review', 'done': 'Done' };

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Webhook event emitter ────────────────────────────────────────────────────
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function fireWebhook(projectId, eventType, payload) {
  const hooks = db.prepare("SELECT * FROM webhooks WHERE projectId = ? AND (events = '[]' OR events LIKE ?)").all(projectId, `%"${eventType}"%`);
  for (const hook of hooks) {
    const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), ...payload });
    const sig = hook.secret ? 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex') : null;
    try {
      const url = new URL(hook.url);
      const lib = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(sig ? { 'X-Webhook-Signature': sig } : {}) },
      };
      const req = lib.request(options);
      req.on('error', () => {}); // fire-and-forget
      req.write(body);
      req.end();
    } catch(e) { /* ignore bad URLs */ }
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────

// GET /api/projects — list all projects
app.get('/api/projects', (req, res) => {
  const rows = db.prepare('SELECT * FROM projects ORDER BY createdAt ASC').all();
  res.json(rows.map(r => ({
    ...r,
    agentConfig: r.agentConfig ? JSON.parse(r.agentConfig) : null
  })));
});

// GET /api/projects/:id — single project
app.get('/api/projects/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ ...row, agentConfig: row.agentConfig ? JSON.parse(row.agentConfig) : null });
});

// POST /api/projects — create a project
app.post('/api/projects', (req, res) => {
  const project = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: req.body.name || 'New Project',
    color: req.body.color || '#6c5ce7',
    emoji: req.body.emoji || '📋',
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    'INSERT INTO projects (id, name, color, emoji, createdAt) VALUES (?, ?, ?, ?, ?)'
  ).run(project.id, project.name, project.color, project.emoji, project.createdAt);
  // Create default agent-task template for new project
  const tmplId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newProjDefaultDesc = `Read /Users/mike/.openclaw/workspace/SUBAGENTS.md first — it has everything you need: git workflow, notifications, kanban API, conflict avoidance, and ground rules.\n\n## Task\n\n[describe task here]\n\n## Git Workflow\n\n\`\`\`bash\ncd /path/to/repo\ngit pull origin main\ngit add -A\ngit commit -m "feat|fix|chore: short description"\ngh auth switch --user clawdawg36-cpu\ngit push\ngh auth switch --user mikejwhitehead\n\`\`\`\n\n## Notifications\n\nSend a BlueBubbles message to +18183121807:\n- START: "🔨 Starting: [task title]"\n- FINISH: "✅ Done: [task title]\\n[2-3 sentences on what changed]"\n- BLOCKER: "⚠️ Blocked: [task title]\\n[what you need and why]"`;
  db.prepare(
    'INSERT INTO templates (id, projectId, name, defaultDescription, defaultTags, defaultAssignee, defaultPriority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    tmplId, project.id, 'agent-task',
    newProjDefaultDesc,
    JSON.stringify(['agent', 'automation']),
    'ClawDawg', 'medium', new Date().toISOString()
  );
  res.status(201).json(project);
});

// PUT /api/projects/:id — update a project
app.put('/api/projects/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updated = {
    name: req.body.name !== undefined ? req.body.name : existing.name,
    color: req.body.color !== undefined ? req.body.color : existing.color,
    emoji: req.body.emoji !== undefined ? req.body.emoji : existing.emoji,
    agentConfig: req.body.agentConfig !== undefined ? JSON.stringify(req.body.agentConfig) : existing.agentConfig,
  };
  db.prepare('UPDATE projects SET name = ?, color = ?, emoji = ?, agentConfig = ? WHERE id = ?')
    .run(updated.name, updated.color, updated.emoji, updated.agentConfig, req.params.id);
  res.json({ ...existing, ...updated, agentConfig: updated.agentConfig ? JSON.parse(updated.agentConfig) : null });
});

// DELETE /api/projects/:id — delete project and cascade tasks
app.delete('/api/projects/:id', (req, res) => {
  if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default project' });
  db.prepare("DELETE FROM tasks WHERE projectId = ?").run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ─── Templates ───────────────────────────────────────────────────────────────

// GET /api/templates?projectId=x
app.get('/api/templates', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    const rows = db.prepare('SELECT * FROM templates WHERE projectId = ? ORDER BY createdAt ASC').all(projectId);
    res.json(rows.map(r => ({ ...r, defaultTags: JSON.parse(r.defaultTags) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/templates
app.post('/api/templates', (req, res) => {
  try {
    const tmpl = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      projectId: req.body.projectId || 'default',
      name: req.body.name || 'New Template',
      defaultDescription: req.body.defaultDescription || '',
      defaultTags: req.body.defaultTags || [],
      defaultAssignee: req.body.defaultAssignee || 'Mike',
      defaultPriority: req.body.defaultPriority || 'medium',
      createdAt: new Date().toISOString(),
    };
    db.prepare(
      'INSERT INTO templates (id, projectId, name, defaultDescription, defaultTags, defaultAssignee, defaultPriority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(tmpl.id, tmpl.projectId, tmpl.name, tmpl.defaultDescription, JSON.stringify(tmpl.defaultTags), tmpl.defaultAssignee, tmpl.defaultPriority, tmpl.createdAt);
    res.status(201).json({ ...tmpl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/templates/:id
app.delete('/api/templates/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

// Get all tasks (optionally filtered by projectId)
app.get('/api/tasks', (req, res) => {
  const projectId = req.query.projectId || 'default';
  // Auto-expire stale locks before returning results
  db.prepare(`
    UPDATE tasks SET lockedBy = NULL, lockedAt = NULL, lockExpiresAt = NULL
    WHERE lockExpiresAt IS NOT NULL AND lockExpiresAt < datetime('now')
  `).run();
  const rows = db.prepare("SELECT * FROM tasks WHERE projectId = ?").all(projectId);
  // Compute blocked status for each task
  const doneIds = new Set(rows.filter(r => r.column === 'done').map(r => r.id));
  res.json(rows.map(row => ({
    ...row,
    tags: JSON.parse(row.tags),
    subtasks: row.subtasks ? JSON.parse(row.subtasks) : null,
    blockedBy: row.blockedBy ? JSON.parse(row.blockedBy) : [],
    blocked: (row.blockedBy ? JSON.parse(row.blockedBy) : []).some(id => !doneIds.has(id)),
    handoffLog: row.handoffLog ? JSON.parse(row.handoffLog) : [],
    agentStatus: (() => {
      if (row.column === 'done') return 'done';
      if (!row.lockedBy) return 'idle';
      const now = new Date();
      const expires = row.lockExpiresAt ? new Date(row.lockExpiresAt) : null;
      if (expires && expires < now) return 'idle'; // lock expired
      return row.column === 'in-progress' ? 'in-progress' : 'claimed';
    })(),
  })));
});

// POST /api/tasks/:id/claim — atomically lock a card
app.post('/api/tasks/:id/claim', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    // Check if task is currently locked by someone else
    if (task.lockedBy && task.lockExpiresAt) {
      const expiry = db.prepare("SELECT lockExpiresAt > datetime('now') as active FROM tasks WHERE id = ?").get(req.params.id);
      if (expiry && expiry.active) {
        return res.status(409).json({ error: 'Task already locked', lockedBy: task.lockedBy, lockExpiresAt: task.lockExpiresAt });
      }
    }

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const agentSessionId = req.body.agentSessionId;

    db.prepare('UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ? WHERE id = ?')
      .run(agentSessionId, now, expiresAt, agentSessionId, now, req.params.id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ ...updated, tags: JSON.parse(updated.tags), subtasks: updated.subtasks ? JSON.parse(updated.subtasks) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/release — release a lock
app.post('/api/tasks/:id/release', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    if (task.lockedBy !== req.body.agentSessionId) {
      return res.status(403).json({ error: 'Not the lock owner' });
    }

    db.prepare('UPDATE tasks SET lockedBy = NULL, lockedAt = NULL, lockExpiresAt = NULL WHERE id = ?')
      .run(req.params.id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ ...updated, tags: JSON.parse(updated.tags), subtasks: updated.subtasks ? JSON.parse(updated.subtasks) : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create task
app.post('/api/tasks', (req, res) => {
  const blockedByArr = Array.isArray(req.body.blockedBy) ? req.body.blockedBy : [];
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
    projectId: req.body.projectId || 'default',
    wave: req.body.wave !== undefined ? req.body.wave : null,
    blockedBy: blockedByArr,
  };
  db.prepare(
    'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, recurring, subtasks, projectId, wave, blockedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(task.id, task.title, task.description, task.assignee, task.priority, JSON.stringify(task.tags), task.column, task.createdAt, task.recurring, task.subtasks ? JSON.stringify(task.subtasks) : null, task.projectId, task.wave, JSON.stringify(blockedByArr));

  // Sync blockedBy to task_dependencies
  for (const blockerId of blockedByArr) {
    const blockerExists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blockerId);
    if (blockerExists) {
      db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, task.id);
    }
  }

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

  // Handle blockedBy sync to task_dependencies
  if (req.body.blockedBy !== undefined) {
    const blockedByArr = Array.isArray(req.body.blockedBy) ? req.body.blockedBy : [];
    updated.blockedBy = blockedByArr;
    // Sync to task_dependencies: clear existing blockers for this task, re-insert from blockedBy
    db.prepare('DELETE FROM task_dependencies WHERE blocked_id = ?').run(updated.id);
    for (const blockerId of blockedByArr) {
      if (blockerId !== updated.id) {
        db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, updated.id);
      }
    }
  } else {
    updated.blockedBy = existing.blockedBy ? JSON.parse(existing.blockedBy) : [];
  }

  // Handle wave field explicitly
  updated.wave = req.body.wave !== undefined ? req.body.wave : (existing.wave !== undefined ? existing.wave : null);

  // Handle agentSessionId and agentStartedAt
  updated.agentSessionId = req.body.agentSessionId !== undefined ? req.body.agentSessionId || null : (existing.agentSessionId || null);
  updated.agentStartedAt = req.body.agentStartedAt !== undefined ? req.body.agentStartedAt || null : (existing.agentStartedAt || null);

  db.prepare(
    'UPDATE tasks SET title = ?, description = ?, assignee = ?, priority = ?, tags = ?, "column" = ?, dueDate = ?, recurring = ?, subtasks = ?, projectId = ?, blockedBy = ?, wave = ?, agentSessionId = ?, agentStartedAt = ? WHERE id = ?'
  ).run(updated.title, updated.description, updated.assignee, updated.priority, JSON.stringify(updated.tags), updated.column, updated.dueDate || null, updated.recurring || null, updated.subtasks ? JSON.stringify(updated.subtasks) : null, updated.projectId || 'default', JSON.stringify(updated.blockedBy), updated.wave, updated.agentSessionId, updated.agentStartedAt, updated.id);

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

    // Fire webhooks
    fireWebhook(updated.projectId || 'default', 'task.updated', { task: { ...updated, tags: JSON.stringify(updated.tags) } });

    // Wave auto-promotion: when all tasks in wave N are done, promote wave N+1 to backlog
    if (req.body.column === 'done' && updated.wave != null) {
      const projectId = updated.projectId || 'default';
      const waveN = updated.wave;
      const waveTasks = db.prepare("SELECT id, \"column\" FROM tasks WHERE projectId = ? AND wave = ?").all(projectId, waveN);
      // Check if all wave N tasks are done (treating the current task as done)
      const allDone = waveTasks.every(t => t.id === updated.id ? true : t.column === 'done');
      if (allDone) {
        // Promote all wave N+1 tasks from idea to backlog
        const nextWaveTasks = db.prepare("SELECT id FROM tasks WHERE projectId = ? AND wave = ? AND \"column\" = 'idea'").all(projectId, waveN + 1);
        if (nextWaveTasks.length > 0) {
          const promoteStmt = db.prepare("UPDATE tasks SET \"column\" = 'backlog' WHERE id = ?");
          const promoteAll = db.transaction((tasks) => { for (const t of tasks) promoteStmt.run(t.id); });
          promoteAll(nextWaveTasks);
        }
        // Fire layer.unlocked webhook
        if (typeof fireWebhook === 'function') {
          fireWebhook(projectId, 'layer.unlocked', { wave: waveN, nextWave: waveN + 1, promotedCount: nextWaveTasks.length, projectId });
        }
      }
    }

    // Check if this task being done unblocks others (task.unblocked event)
    if (req.body.column === 'done') {
      const unblocked = db.prepare("SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?").all(existing.id);
      for (const dep of unblocked) {
        const blockedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(dep.blocked_id);
        if (blockedTask) {
          const remainingBlockers = db.prepare("SELECT td.blocker_id FROM task_dependencies td INNER JOIN tasks t ON t.id = td.blocker_id WHERE td.blocked_id = ? AND t.column != 'done'").all(dep.blocked_id);
          if (remainingBlockers.length === 0) {
            fireWebhook(blockedTask.projectId || 'default', 'task.unblocked', { taskId: dep.blocked_id, task: blockedTask });
          }
        }
      }
    }
  }

  res.json(updated);
});

// Get single task
app.get('/api/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Not found' });
  // Get blockers and compute blocked status
  const blockerIds = db.prepare('SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?').all(task.id).map(r => r.blocker_id);
  const activeBlockers = blockerIds.filter(bid => {
    const b = db.prepare('SELECT "column" FROM tasks WHERE id = ?').get(bid);
    return b && b.column !== 'done';
  });
  res.json({
    ...task,
    tags: JSON.parse(task.tags),
    subtasks: task.subtasks ? JSON.parse(task.subtasks) : null,
    blockedBy: task.blockedBy ? JSON.parse(task.blockedBy) : [],
    blocked: activeBlockers.length > 0,
    handoffLog: task.handoffLog ? JSON.parse(task.handoffLog) : [],
    agentStatus: (() => {
      if (task.column === 'done') return 'done';
      if (!task.lockedBy) return 'idle';
      const now = new Date();
      const expires = task.lockExpiresAt ? new Date(task.lockExpiresAt) : null;
      if (expires && expires < now) return 'idle'; // lock expired
      return task.column === 'in-progress' ? 'in-progress' : 'claimed';
    })(),
  });
});

// POST /api/tasks/:id/spawn — spawn an agent for this card
app.post('/api/tasks/:id/spawn', async (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    // Check if already locked
    const now = new Date();
    if (task.lockedBy && task.lockExpiresAt && new Date(task.lockExpiresAt) > now) {
      return res.status(409).json({ error: 'Task already claimed', lockedBy: task.lockedBy });
    }

    // Read project agentConfig for model/timeout overrides
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.projectId || 'default');
    const agentConfig = project && project.agentConfig ? JSON.parse(project.agentConfig) : {};

    // Read auth token
    let authToken = process.env.OPENCLAW_TOKEN;
    if (!authToken) {
      try {
        const configPath = require('path').join(require('os').homedir(), '.openclaw', 'openclaw.json');
        const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        authToken = config?.auth?.token || config?.gateway?.auth?.token ||
          (config?.auth?.profiles && Object.values(config.auth.profiles)[0]?.token);
      } catch(e) { /* no token found */ }
    }

    // Build spawn payload
    const taskDetails = [
      `# Task: ${task.title}`,
      task.description ? `\n## Description\n${task.description}` : '',
      `\n## Card ID\n${task.id}`,
      `\n## Project\n${task.projectId || 'default'}`,
      `\n## Priority\n${task.priority}`,
      task.tags ? `\n## Tags\n${JSON.parse(task.tags || '[]').join(', ')}` : '',
    ].join('');

    const spawnPayload = {
      task: `Read /Users/mike/.openclaw/workspace/SUBAGENTS.md first.\n\n${taskDetails}`,
      mode: 'run',
      ...(agentConfig.model ? { model: agentConfig.model } : {}),
      ...(agentConfig.timeoutSeconds ? { runTimeoutSeconds: agentConfig.timeoutSeconds } : {}),
    };

    // Call gateway spawn endpoint
    const gatewayRes = await fetch('http://localhost:18789/api/sessions/spawn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(spawnPayload),
    });

    if (!gatewayRes.ok) {
      const errText = await gatewayRes.text();
      return res.status(502).json({ error: 'Gateway spawn failed', details: errText });
    }

    const spawnResult = await gatewayRes.json();
    const sessionId = spawnResult.sessionKey || spawnResult.sessionId || spawnResult.id || 'unknown';

    // Lock the card and store agent session ID
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();
    db.prepare('UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ?, "column" = ? WHERE id = ?')
      .run(sessionId, nowIso, expiresAt, sessionId, nowIso, 'in-progress', task.id);

    res.json({ sessionId, taskId: task.id, status: 'spawned' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tasks/:id/handoff — append handoff note
app.post('/api/tasks/:id/handoff', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const entry = {
      agentId: req.body.agentId || 'unknown',
      timestamp: new Date().toISOString(),
      message: (req.body.message || '').trim(),
    };
    if (!entry.message) return res.status(400).json({ error: 'message required' });

    const log = task.handoffLog ? JSON.parse(task.handoffLog) : [];
    log.push(entry);

    db.prepare('UPDATE tasks SET handoffLog = ? WHERE id = ?').run(JSON.stringify(log), task.id);

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agent Logs ───────────────────────────────────────────────────────────────

// POST /api/tasks/:id/logs — append a log entry (called by agents)
app.post('/api/tasks/:id/logs', (req, res) => {
  try {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const entry = {
      taskId: req.params.id,
      agentSessionId: req.body.agentSessionId || null,
      level: ['info', 'warn', 'error'].includes(req.body.level) ? req.body.level : 'info',
      message: (req.body.message || '').trim(),
      timestamp: new Date().toISOString(),
    };
    if (!entry.message) return res.status(400).json({ error: 'message required' });

    const result = db.prepare(
      'INSERT INTO agent_logs (taskId, agentSessionId, level, message, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(entry.taskId, entry.agentSessionId, entry.level, entry.message, entry.timestamp);

    res.status(201).json({ id: result.lastInsertRowid, ...entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tasks/:id/logs — get all log entries for a task
app.get('/api/tasks/:id/logs', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM agent_logs WHERE taskId = ? ORDER BY timestamp ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ─── File Attachments ─────────────────────────────────────────────────────────

// Serve uploaded files
app.use('/uploads', express.static(UPLOADS_DIR));

// GET /api/tasks/:id/attachments — list attachments for a task
app.get('/api/tasks/:id/attachments', (req, res) => {
  const rows = db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY uploadedAt ASC').all(req.params.id);
  res.json(rows);
});

// POST /api/tasks/:id/attachments — upload a file
app.post('/api/tasks/:id/attachments', upload.single('file'), (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const attachment = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    task_id: req.params.id,
    filename: req.file.filename,
    original_name: req.file.originalname,
    path: req.file.path,
    mimetype: req.file.mimetype,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
  };

  db.prepare(
    'INSERT INTO attachments (id, task_id, filename, original_name, path, mimetype, size, uploadedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(attachment.id, attachment.task_id, attachment.filename, attachment.original_name, attachment.path, attachment.mimetype, attachment.size, attachment.uploadedAt);

  // Log activity
  const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  db.prepare(
    'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actId, req.params.id, 'attachment', `Attached file: ${req.file.originalname}`, 'System', attachment.uploadedAt);

  res.status(201).json(attachment);
});

// DELETE /api/attachments/:id — remove an attachment
app.delete('/api/attachments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Delete file from disk
  try { fs.unlinkSync(row.path); } catch (e) { /* ignore if already gone */ }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

app.get('/api/webhooks', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    const rows = db.prepare('SELECT * FROM webhooks WHERE projectId = ? ORDER BY createdAt ASC').all(projectId);
    res.json(rows.map(r => ({ ...r, events: JSON.parse(r.events) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webhooks', (req, res) => {
  try {
    const hook = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      projectId: req.body.projectId || 'default',
      url: req.body.url || '',
      events: req.body.events || [],
      secret: req.body.secret || null,
      createdAt: new Date().toISOString(),
    };
    if (!hook.url) return res.status(400).json({ error: 'url required' });
    db.prepare('INSERT INTO webhooks (id, projectId, url, events, secret, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hook.id, hook.projectId, hook.url, JSON.stringify(hook.events), hook.secret, hook.createdAt);
    res.status(201).json({ ...hook });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/webhooks/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Stats Dashboard ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  // Default to "default" project if no projectId passed (backwards compatible)
  const projectId = req.query.projectId || 'default';

  // Look up project name for display
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId);
  const projectName = project ? project.name : projectId;

  // Tasks by assignee (scoped to project)
  const assigneeRows = db.prepare('SELECT assignee, COUNT(*) as cnt FROM tasks WHERE projectId = ? GROUP BY assignee').all(projectId);
  const totalByAssignee = {};
  assigneeRows.forEach(r => { totalByAssignee[r.assignee] = r.cnt; });

  // Column counts (scoped to project)
  const colRows = db.prepare('SELECT "column", COUNT(*) as cnt FROM tasks WHERE projectId = ? GROUP BY "column"').all(projectId);
  const columnCounts = {};
  colRows.forEach(r => { columnCounts[r.column] = r.cnt; });

  // Completed this week (tasks moved to done in last 7 days via card_activity, scoped to project)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const completedThisWeek = db.prepare(
    `SELECT COUNT(DISTINCT a.taskId) as cnt FROM card_activity a
     INNER JOIN tasks t ON t.id = a.taskId
     WHERE a.type = 'move' AND a.content LIKE '%→ Done%' AND a.createdAt >= ? AND t.projectId = ?`
  ).get(weekAgo, projectId).cnt;

  // Overdue count (scoped to project)
  const now = new Date().toISOString().slice(0, 10);
  const overdueCount = db.prepare(
    `SELECT COUNT(*) as cnt FROM tasks WHERE dueDate IS NOT NULL AND dueDate < ? AND "column" != 'done' AND projectId = ?`
  ).get(now, projectId).cnt;

  // Average time to complete (seconds from createdAt to move-to-done activity, scoped to project)
  const completionRows = db.prepare(`
    SELECT t.createdAt as taskCreated, MIN(a.createdAt) as doneAt
    FROM tasks t
    INNER JOIN card_activity a ON a.taskId = t.id AND a.type = 'move' AND a.content LIKE '%→ Done%'
    WHERE t."column" = 'done' AND t.projectId = ?
    GROUP BY t.id
  `).all(projectId);
  let avgTimeToComplete = 0;
  if (completionRows.length > 0) {
    const totalSec = completionRows.reduce((sum, r) => {
      return sum + (new Date(r.doneAt).getTime() - new Date(r.taskCreated).getTime()) / 1000;
    }, 0);
    avgTimeToComplete = Math.round(totalSec / completionRows.length);
  }

  res.json({ projectId, projectName, totalByAssignee, completedThisWeek, overdueCount, columnCounts, avgTimeToComplete });
});

// ─── Startup: seed default 'agent-task' template for projects that have none ──
(function seedDefaultTemplates() {
  const DEFAULT_DESCRIPTION = `Read /Users/mike/.openclaw/workspace/SUBAGENTS.md first — it has everything you need: git workflow, notifications, kanban API, conflict avoidance, and ground rules.

## Task

[describe task here]

## Git Workflow

\`\`\`bash
cd /path/to/repo
git pull origin main
git add -A
git commit -m "feat|fix|chore: short description"
gh auth switch --user clawdawg36-cpu
git push
gh auth switch --user mikejwhitehead
\`\`\`

## Notifications

Send a BlueBubbles message to +18183121807:
- START: "🔨 Starting: [task title]"
- FINISH: "✅ Done: [task title]\\n[2-3 sentences on what changed]"
- BLOCKER: "⚠️ Blocked: [task title]\\n[what you need and why]"`;

  const projects = db.prepare('SELECT id FROM projects').all();
  for (const project of projects) {
    const existing = db.prepare('SELECT id FROM templates WHERE projectId = ?').get(project.id);
    if (!existing) {
      const tmplId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      db.prepare(
        'INSERT INTO templates (id, projectId, name, defaultDescription, defaultTags, defaultAssignee, defaultPriority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        tmplId, project.id, 'agent-task',
        DEFAULT_DESCRIPTION,
        JSON.stringify(['agent', 'automation']),
        'ClawDawg', 'medium', new Date().toISOString()
      );
      console.log(`Seeded default agent-task template for project: ${project.id}`);
    }
  }
})();

app.listen(PORT, () => {
  console.log(`Kanban board running at http://localhost:${PORT}`);
});
