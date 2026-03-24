const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const helmet = require('helmet');
const cors = require('cors');
const db = require('./db');

// ─── Multer config for file uploads ──────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const ALLOWED_MIMETYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // xlsx
  'application/zip',
];

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    // Use a safe extension derived from the allowlist mimetype, not user-supplied filename
    const safeExts = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
      'application/pdf': '.pdf', 'text/plain': '.txt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      'application/zip': '.zip',
    };
    const ext = safeExts[file.mimetype] || '';
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMETYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(new Error('File type not allowed'), { status: 415 }), false);
    }
  },
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const PORT = 3456;

const COL_LABELS = { 'idea': 'Idea', 'backlog': 'Backlog', 'in-progress': 'In Progress', 'in-review': 'In Review', 'done': 'Done' };
const VALID_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const VALID_COLUMNS = ['idea', 'backlog', 'in-progress', 'in-review', 'done'];

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],   // allow inline scripts for the Kanban UI
      styleSrc:  ["'self'", "'unsafe-inline'"],   // allow inline styles
      imgSrc:    ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
    },
  },
}));

// Restrict cross-origin requests to localhost origins only
app.use(cors({
  origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── API authentication (bearer token) ───────────────────────────────────────
// Set KANBAN_API_KEY env var to require Bearer auth on all /api/* routes.
// If KANBAN_API_KEY is unset, the API remains open (backward-compatible).
app.use('/api', (req, res, next) => {
  const token = process.env.KANBAN_API_KEY;
  if (!token) return next(); // no key configured = open mode
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${token}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── Webhook event emitter ────────────────────────────────────────────────────
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns');

// Server-side encryption key for webhook secrets at rest (AES-256-GCM).
// Set WEBHOOK_ENCRYPT_KEY in env as a 64-char hex string (32 bytes).
// Falls back to a deterministic derived key — set a real env var in production.
const _rawEncryptKey = process.env.WEBHOOK_ENCRYPT_KEY ||
  crypto.createHash('sha256').update('kanban-webhook-encrypt-key-default').digest('hex');
const WEBHOOK_ENCRYPT_KEY = Buffer.from(_rawEncryptKey.slice(0, 64), 'hex'); // 32 bytes

const WEBHOOK_SECRET_SENTINEL = 'enc:v1:'; // prefix on all encrypted values

// Encrypt a plaintext webhook secret for at-rest storage.
// Returns: "enc:v1:<iv_hex>:<authTag_hex>:<ciphertext_hex>"
function encryptWebhookSecret(plaintext) {
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', WEBHOOK_ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return WEBHOOK_SECRET_SENTINEL + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted.toString('hex');
}

// Decrypt a stored webhook secret. Returns plaintext, or null on failure.
function decryptWebhookSecret(stored) {
  if (!stored) return null;
  if (!stored.startsWith(WEBHOOK_SECRET_SENTINEL)) {
    // Legacy plaintext value — return as-is (will be re-encrypted on next rotation)
    return stored;
  }
  try {
    const parts = stored.slice(WEBHOOK_SECRET_SENTINEL.length).split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, ctHex] = parts;
    const decipher = crypto.createDecipheriv('aes-256-gcm', WEBHOOK_ENCRYPT_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return decipher.update(Buffer.from(ctHex, 'hex')).toString('utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

// Mask a stored secret for display — show only "••••" + last 4 chars of the decrypted value.
function maskSecret(stored) {
  if (!stored) return null;
  const plaintext = decryptWebhookSecret(stored);
  if (!plaintext) return '••••';
  return '••••' + plaintext.slice(-4);
}

// Generate a new random webhook secret (URL-safe base64, 32 bytes).
function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

// Check if an IP address is a private/loopback address (SSRF protection)
function isPrivateIp(ip) {
  // IPv6 loopback
  if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
  // Strip IPv6-mapped IPv4 prefix (::ffff:x.x.x.x)
  const ipv4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4) return false; // not IPv4, allow (IPv6 addresses not RFC-1918)
  const [a, b] = parts;
  return (
    a === 10 ||                          // 10.0.0.0/8
    a === 127 ||                         // 127.0.0.0/8 loopback
    a === 169 && b === 254 ||            // 169.254.0.0/16 link-local (cloud metadata)
    a === 172 && b >= 16 && b <= 31 ||   // 172.16.0.0/12
    a === 192 && b === 168              // 192.168.0.0/16
  );
}

// Validate a webhook URL: must be https and not target private/loopback IPs.
// Returns null if valid, or an error string if invalid.
async function validateWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return 'Invalid URL';
  }
  if (parsed.protocol !== 'https:') {
    return 'Webhook URL must use https://';
  }
  // Resolve hostname and check for private IPs
  const hostname = parsed.hostname;
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        return resolve('Could not resolve webhook hostname');
      }
      for (const { address } of addresses) {
        if (isPrivateIp(address)) {
          return resolve(`Webhook URL resolves to a disallowed private/loopback address (${address})`);
        }
      }
      resolve(null);
    });
  });
}

const MAX_WEBHOOK_FAILURES = 5; // consecutive failures before auto-disable

function _dispatchWebhookRequest(hook, body, sig) {
  try {
    const url = new URL(hook.url);
    // Only fire over https (skip any http hooks that may have been stored before this fix)
    if (url.protocol !== 'https:') return;
    // Resolve and check for private IPs before firing
    dns.lookup(url.hostname, { all: true }, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        _recordWebhookFailure(hook.id);
        return;
      }
      for (const { address } of addresses) {
        if (isPrivateIp(address)) return; // silently drop SSRF-risk hooks
      }
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(sig ? { 'X-Webhook-Signature': sig } : {}) },
      };
      const req = https.request(options, (res) => {
        // Drain the response to free the socket; treat 2xx as success
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 300) {
          // Success: reset failure counter
          db.prepare('UPDATE webhooks SET failCount = 0 WHERE id = ?').run(hook.id);
        } else {
          _recordWebhookFailure(hook.id);
        }
      });
      req.setTimeout(5000, () => req.destroy());
      req.on('error', () => {
        _recordWebhookFailure(hook.id);
      });
      req.write(body);
      req.end();
    });
  } catch(e) { /* ignore bad URLs */ }
}

function _recordWebhookFailure(hookId) {
  const hook = db.prepare('SELECT id, failCount FROM webhooks WHERE id = ?').get(hookId);
  if (!hook) return;
  const newCount = (hook.failCount || 0) + 1;
  const now = new Date().toISOString();
  if (newCount >= MAX_WEBHOOK_FAILURES) {
    // Auto-disable: set events to '[]' so it won't fire, and log a warning
    db.prepare('UPDATE webhooks SET failCount = ?, lastFailedAt = ?, events = ? WHERE id = ?')
      .run(newCount, now, '[]', hookId);
    console.warn(`[webhook] Auto-disabled webhook ${hookId} after ${newCount} consecutive failures`);
  } else {
    db.prepare('UPDATE webhooks SET failCount = ?, lastFailedAt = ? WHERE id = ?')
      .run(newCount, now, hookId);
  }
}

function fireWebhook(projectId, eventType, payload) {
  const hooks = db.prepare("SELECT * FROM webhooks WHERE projectId = ? AND (events = '[]' OR events LIKE ?)").all(projectId, `%"${eventType}"%`);
  for (const hook of hooks) {
    const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), ...payload });
    // Decrypt the stored secret before using it for HMAC signing
    const signingKey = decryptWebhookSecret(hook.secret);
    const sig = signingKey ? 'sha256=' + crypto.createHmac('sha256', signingKey).update(body).digest('hex') : null;
    // Capture hook reference for closure
    const hookRef = hook;
    const sigRef = sig;
    const bodyRef = body;
    // Dispatch asynchronously after response is sent
    setImmediate(() => _dispatchWebhookRequest(hookRef, bodyRef, sigRef));
  }
}

// ─── Projects ─────────────────────────────────────────────────────────────────

// GET /api/projects — list all projects
app.get('/api/projects', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM projects ORDER BY createdAt ASC').all();
    res.json(rows.map(r => ({
      ...r,
      agentConfig: r.agentConfig ? JSON.parse(r.agentConfig) : null
    })));
  } catch (err) {
    console.error('GET /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/projects/:id — single project
app.get('/api/projects/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({ ...row, agentConfig: row.agentConfig ? JSON.parse(row.agentConfig) : null });
  } catch (err) {
    console.error('GET /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects — create a project
app.post('/api/projects', (req, res) => {
  try {
  const project = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: req.body.name || 'New Project',
    color: req.body.color || '#6c5ce7',
    emoji: req.body.emoji || '📋',
    createdAt: new Date().toISOString(),
  };
  const tmplId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const newProjDefaultDesc = `Read /Users/mike/.openclaw/workspace/SUBAGENTS.md first — it has everything you need: git workflow, notifications, kanban API, conflict avoidance, and ground rules.\n\n## Task\n\n[describe task here]\n\n## Git Workflow\n\n\`\`\`bash\ncd /path/to/repo\ngit pull origin main\ngit add -A\ngit commit -m "feat|fix|chore: short description"\ngh auth switch --user clawdawg36-cpu\ngit push\ngh auth switch --user mikejwhitehead\n\`\`\`\n\n## Notifications\n\nSend a BlueBubbles message to +18183121807:\n- START: "🔨 Starting: [task title]"\n- FINISH: "✅ Done: [task title]\\n[2-3 sentences on what changed]"\n- BLOCKER: "⚠️ Blocked: [task title]\\n[what you need and why]"`;
  const createProject = db.transaction(() => {
    db.prepare(
      'INSERT INTO projects (id, name, color, emoji, createdAt) VALUES (?, ?, ?, ?, ?)'
    ).run(project.id, project.name, project.color, project.emoji, project.createdAt);
    // Create default agent-task template for new project
    db.prepare(
      'INSERT INTO templates (id, projectId, name, defaultDescription, defaultTags, defaultAssignee, defaultPriority, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      tmplId, project.id, 'agent-task',
      newProjDefaultDesc,
      JSON.stringify(['agent', 'automation']),
      'ClawDawg', 'medium', new Date().toISOString()
    );
  });
  createProject();
  res.status(201).json(project);
  } catch (err) {
    console.error('POST /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/projects/:id — update a project
app.put('/api/projects/:id', (req, res) => {
  try {
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
  } catch (err) {
    console.error('PUT /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:id — delete project and cascade tasks
app.delete('/api/projects/:id', (req, res) => {
  try {
    if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default project' });
    const deleteProject = db.transaction(() => {
      const projectId = req.params.id;
      // Get all task IDs for this project (needed for child-table cleanup)
      const taskIds = db.prepare("SELECT id FROM tasks WHERE projectId = ?").all(projectId).map(t => t.id);
      if (taskIds.length > 0) {
        const placeholders = taskIds.map(() => '?').join(', ');
        // Cascade cleanup of child tables referencing task IDs
        db.prepare(`DELETE FROM agent_logs WHERE taskId IN (${placeholders})`).run(...taskIds);
        db.prepare(`DELETE FROM card_activity WHERE taskId IN (${placeholders})`).run(...taskIds);
        db.prepare(`DELETE FROM notifications WHERE task_id IN (${placeholders})`).run(...taskIds);
        db.prepare(`DELETE FROM task_dependencies WHERE blocker_id IN (${placeholders}) OR blocked_id IN (${placeholders})`).run(...taskIds, ...taskIds);
        db.prepare(`DELETE FROM attachments WHERE task_id IN (${placeholders})`).run(...taskIds);
      }
      // Delete tasks, templates, and webhooks for this project
      db.prepare("DELETE FROM tasks WHERE projectId = ?").run(projectId);
      db.prepare("DELETE FROM templates WHERE projectId = ?").run(projectId);
      db.prepare("DELETE FROM webhooks WHERE projectId = ?").run(projectId);
      db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    });
    deleteProject();
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Templates ───────────────────────────────────────────────────────────────

// GET /api/templates?projectId=x
app.get('/api/templates', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    const rows = db.prepare('SELECT * FROM templates WHERE projectId = ? ORDER BY createdAt ASC').all(projectId);
    res.json(rows.map(r => ({ ...r, defaultTags: JSON.parse(r.defaultTags) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/templates/:id
app.delete('/api/templates/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

// Get all tasks (optionally filtered by projectId)
app.get('/api/tasks', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    // Lock expiry is handled by background cleanup (see setInterval below) — no UPDATE here
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
  } catch (err) {
    console.error('GET /api/tasks error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/tasks/:id/claim — atomically lock a card
app.post('/api/tasks/:id/claim', (req, res) => {
  try {
    const { agentSessionId } = req.body;

    // Validate agentSessionId — must be a non-empty string
    if (!agentSessionId || typeof agentSessionId !== 'string' || agentSessionId.trim() === '') {
      return res.status(400).json({ error: 'agentSessionId is required and must be a non-empty string' });
    }

    // Check task exists first
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Atomic claim: only succeeds if task is unlocked or lock has expired
    const result = db.prepare(
      `UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ?
       WHERE id = ? AND (lockedBy IS NULL OR lockExpiresAt < datetime('now'))`
    ).run(agentSessionId, now, expiresAt, agentSessionId, now, req.params.id);

    if (result.changes === 0) {
      const current = db.prepare('SELECT lockedBy, lockExpiresAt FROM tasks WHERE id = ?').get(req.params.id);
      return res.status(409).json({ error: 'Task already locked', lockedBy: current.lockedBy, lockExpiresAt: current.lockExpiresAt });
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ ...updated, tags: JSON.parse(updated.tags), subtasks: updated.subtasks ? JSON.parse(updated.subtasks) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tasks/:id/release — release a lock
app.post('/api/tasks/:id/release', (req, res) => {
  try {
    const agentSessionId = req.body.agentSessionId;
    if (!agentSessionId || typeof agentSessionId !== 'string' || agentSessionId.trim() === '') {
      return res.status(400).json({ error: 'agentSessionId is required and must be a non-empty string' });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    if (task.lockedBy !== agentSessionId) {
      return res.status(403).json({ error: 'Not the lock owner' });
    }

    db.prepare('UPDATE tasks SET lockedBy = NULL, lockedAt = NULL, lockExpiresAt = NULL WHERE id = ?')
      .run(req.params.id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({ ...updated, tags: JSON.parse(updated.tags), subtasks: updated.subtasks ? JSON.parse(updated.subtasks) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Create task
app.post('/api/tasks', (req, res) => {
  try {
    // Input validation
    if (req.body.priority !== undefined && !VALID_PRIORITIES.includes(req.body.priority)) {
      return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
    }
    if (req.body.column !== undefined && !VALID_COLUMNS.includes(req.body.column)) {
      return res.status(400).json({ error: `Invalid column. Must be one of: ${VALID_COLUMNS.join(', ')}` });
    }
    if (req.body.wave !== undefined && req.body.wave !== null) {
      if (!Number.isInteger(req.body.wave) || req.body.wave < 0) {
        return res.status(400).json({ error: 'Invalid wave. Must be null or a non-negative integer' });
      }
    }

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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update task
app.put('/api/tasks/:id', (req, res) => {
  try {
  const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // Allowlist of client-settable fields — protects lock/agent fields from mass-assignment
  const ALLOWED_UPDATE_FIELDS = ['title', 'description', 'assignee', 'priority', 'tags', 'column', 'dueDate', 'recurring', 'subtasks', 'projectId', 'blockedBy', 'wave'];
  const clientUpdate = {};
  for (const field of ALLOWED_UPDATE_FIELDS) {
    if (req.body[field] !== undefined) clientUpdate[field] = req.body[field];
  }

  const updated = {
    ...existing,
    tags: JSON.parse(existing.tags),
    subtasks: existing.subtasks ? JSON.parse(existing.subtasks) : null,
    ...clientUpdate,
    id: existing.id,
    createdAt: existing.createdAt,
  };

  // Resolve blockedBy before transaction
  if (req.body.blockedBy !== undefined) {
    updated.blockedBy = Array.isArray(req.body.blockedBy) ? req.body.blockedBy : [];
  } else {
    updated.blockedBy = existing.blockedBy ? JSON.parse(existing.blockedBy) : [];
  }

  // Preserve lock/agent fields from existing — never overwrite from req.body
  updated.lockedBy = existing.lockedBy || null;
  updated.lockedAt = existing.lockedAt || null;
  updated.lockExpiresAt = existing.lockExpiresAt || null;
  updated.agentSessionId = existing.agentSessionId || null;
  updated.agentStartedAt = existing.agentStartedAt || null;

  // Handle wave field — use clientUpdate value if provided, else keep existing
  updated.wave = clientUpdate.wave !== undefined ? clientUpdate.wave : (existing.wave !== undefined ? existing.wave : null);

  // Track whether wave promotion happened (for webhook firing outside transaction)
  let promotedWaveTasks = [];
  let wavePromotionInfo = null;
  // Track unblocked tasks for webhook firing outside transaction
  let unblockedTasks = [];

  // Wrap all DB writes in a single transaction
  const updateTask = db.transaction(() => {
    // Sync blockedBy to task_dependencies if changed
    if (req.body.blockedBy !== undefined) {
      db.prepare('DELETE FROM task_dependencies WHERE blocked_id = ?').run(updated.id);
      for (const blockerId of updated.blockedBy) {
        if (blockerId !== updated.id) {
          db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, updated.id);
        }
      }
    }

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
          'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, recurring, subtasks, projectId, wave) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(newId, existing.title, existing.description, existing.assignee, existing.priority, existing.tags, 'backlog', newCreatedAt, existing.recurring, null, existing.projectId || 'default', existing.wave || null);
        const recActId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        db.prepare(
          'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(recActId, newId, 'created', `Recurring card created (${existing.recurring}) from completed task`, 'System', newCreatedAt);
      }

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
            for (const t of nextWaveTasks) promoteStmt.run(t.id);
            promotedWaveTasks = nextWaveTasks;
          }
          wavePromotionInfo = { wave: waveN, nextWave: waveN + 1, promotedCount: nextWaveTasks ? nextWaveTasks.length : 0, projectId };
        }
      }

      // Collect unblocked tasks for webhook firing after transaction
      if (req.body.column === 'done') {
        const unblocked = db.prepare("SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?").all(existing.id);
        for (const dep of unblocked) {
          const blockedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(dep.blocked_id);
          if (blockedTask) {
            const remainingBlockers = db.prepare("SELECT td.blocker_id FROM task_dependencies td INNER JOIN tasks t ON t.id = td.blocker_id WHERE td.blocked_id = ? AND t.column != 'done'").all(dep.blocked_id);
            if (remainingBlockers.length === 0) {
              unblockedTasks.push({ taskId: dep.blocked_id, task: blockedTask });
            }
          }
        }
      }
    }
  });
  updateTask();

  // Fire webhooks outside the transaction (external side effects)
  if (req.body.column && req.body.column !== existing.column) {
    fireWebhook(updated.projectId || 'default', 'task.updated', { task: { ...updated, tags: JSON.stringify(updated.tags) } });
    if (wavePromotionInfo) {
      fireWebhook(wavePromotionInfo.projectId, 'layer.unlocked', wavePromotionInfo);
    }
    for (const u of unblockedTasks) {
      fireWebhook(u.task.projectId || 'default', 'task.unblocked', { taskId: u.taskId, task: u.task });
    }
  }

  res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get single task
app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });
    // Get blockers and compute blocked status (single query instead of N+1)
    const blockerRows = db.prepare('SELECT id, "column" FROM tasks WHERE id IN (SELECT blocker_id FROM task_dependencies WHERE blocked_id = ?)').all(task.id);
    const activeBlockers = blockerRows.filter(b => b.column !== 'done');
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
  } catch (err) {
    console.error('GET /api/tasks/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    // Note: agentConfig may be the JSON string "null" — always fall back to {}
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.projectId || 'default');
    let agentConfig = {};
    if (project && project.agentConfig) {
      try {
        const parsed = JSON.parse(project.agentConfig);
        agentConfig = (parsed && typeof parsed === 'object') ? parsed : {};
      } catch(e) { /* malformed JSON — keep default */ }
    }

    // Read auth token from openclaw.json (gateway.auth.token)
    let authToken = process.env.OPENCLAW_TOKEN;
    if (!authToken) {
      try {
        const configPath = require('path').join(require('os').homedir(), '.openclaw', 'openclaw.json');
        const config = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
        authToken = config?.gateway?.auth?.token || config?.auth?.token ||
          (config?.auth?.profiles && Object.values(config.auth.profiles)[0]?.token);
      } catch(e) { /* no token found */ }
    }

    // Build task prompt
    const taskDetails = [
      `# Task: ${task.title}`,
      task.description ? `\n## Description\n${task.description}` : '',
      `\n## Card ID\n${task.id}`,
      `\n## Project\n${task.projectId || 'default'}`,
      `\n## Priority\n${task.priority}`,
      task.tags ? `\n## Tags\n${JSON.parse(task.tags || '[]').join(', ')}` : '',
    ].join('');

    const taskPrompt = `Read /Users/mike/.openclaw/workspace/SUBAGENTS.md first.\n\n${taskDetails}`;

    // Spawn via openclaw agent CLI as a detached background process.
    // The gateway uses WebSocket RPC (not HTTP REST) for session spawning, so we
    // invoke the CLI directly. We fire-and-forget and return a session key immediately.
    const os = require('os');
    const crypto = require('crypto');
    const sessionKey = `kanban-${task.id}-${crypto.randomBytes(4).toString('hex')}`;

    // Spawn openclaw agent as a detached background process (fire-and-forget)
    const { spawn } = require('child_process');
    const agentArgs = [
      'agent',
      '--session-id', sessionKey,
      '--message', taskPrompt,
    ];
    if (agentConfig.model) agentArgs.push('--agent', agentConfig.model);

    const env = { ...process.env, HOME: require('os').homedir() };
    if (authToken) env.OPENCLAW_TOKEN = authToken;

    const child = spawn('/opt/homebrew/bin/openclaw', agentArgs, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();

    // Lock the card and store agent session ID
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();
    db.prepare('UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ?, "column" = ? WHERE id = ?')
      .run(sessionKey, nowIso, expiresAt, sessionKey, nowIso, 'in-progress', task.id);

    res.json({ sessionKey, sessionId: sessionKey, taskId: task.id, status: 'spawned' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
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
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tasks/:id/logs — get log entries for a task (paginated)
// Query params: ?limit=100&offset=0 (default limit 100, max 500), ?level=info|warn|error, ?since=<ISO8601>
app.get('/api/tasks/:id/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const level = ['info', 'warn', 'error'].includes(req.query.level) ? req.query.level : null;
    const since = req.query.since || null;

    let query = 'SELECT * FROM agent_logs WHERE taskId = ?';
    const params = [req.params.id];

    if (level) {
      query += ' AND level = ?';
      params.push(level);
    }
    if (since) {
      query += ' AND timestamp > ?';
      params.push(since);
    }
    query += ' ORDER BY timestamp ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const deleteTask = db.transaction(() => {
      const taskId = req.params.id;
      // Cascade cleanup of all child tables (foreign_keys pragma not enabled, so manual)
      db.prepare('DELETE FROM agent_logs WHERE taskId = ?').run(taskId);
      db.prepare('DELETE FROM card_activity WHERE taskId = ?').run(taskId);
      db.prepare('DELETE FROM notifications WHERE task_id = ?').run(taskId);
      db.prepare('DELETE FROM task_dependencies WHERE blocker_id = ? OR blocked_id = ?').run(taskId, taskId);
      db.prepare('DELETE FROM attachments WHERE task_id = ?').run(taskId);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    });
    deleteTask();
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/tasks/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get activity/comments for a task
app.get('/api/tasks/:id/activity', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM card_activity WHERE taskId = ? ORDER BY createdAt ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add a comment to a task
app.post('/api/tasks/:id/comments', (req, res) => {
  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Delete a comment
app.delete('/api/activity/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM card_activity WHERE id = ?').get(req.params.id);
    if (!row || row.type !== 'comment') return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM card_activity WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Notifications ────────────────────────────────────────────────────────────

// Get notifications (recent column change events)
app.get('/api/notifications', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50').all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Mark all notifications as read
app.post('/api/notifications/read', (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0').run();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Dismiss / delete a notification
app.delete('/api/notifications/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM notifications WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Task Dependencies ---

// Get all dependencies (full map, paginated)
// Query params: ?limit=100&offset=0 (default limit 100, max 500)
app.get('/api/dependencies', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = db.prepare('SELECT blocker_id, blocked_id FROM task_dependencies LIMIT ? OFFSET ?').all(limit, offset);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get blockers for a task (what blocks it)
app.get('/api/tasks/:id/blockers', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.* FROM tasks t
      INNER JOIN task_dependencies d ON d.blocker_id = t.id
      WHERE d.blocked_id = ?
    `).all(req.params.id);
    res.json(rows.map(r => ({ ...r, tags: JSON.parse(r.tags) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add a blocker dependency
app.post('/api/tasks/:id/blockers', (req, res) => {
  try {
    const { blocker_id } = req.body;
    const blocked_id = req.params.id;
    if (!blocker_id) return res.status(400).json({ error: 'blocker_id required' });
    if (blocker_id === blocked_id) return res.status(400).json({ error: 'A task cannot block itself' });
    const blockerExists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocker_id);
    const blockedExists = db.prepare('SELECT id FROM tasks WHERE id = ?').get(blocked_id);
    if (!blockerExists || !blockedExists) return res.status(404).json({ error: 'Task not found' });
    db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blocker_id, blocked_id);
    res.status(201).json({ blocker_id, blocked_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Remove a blocker dependency
app.delete('/api/tasks/:id/blockers/:blocker_id', (req, res) => {
  try {
    db.prepare('DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?')
      .run(req.params.blocker_id, req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── File Attachments ─────────────────────────────────────────────────────────

// Serve uploaded files via controlled route (NOT express.static — prevents stored XSS)
app.get('/uploads/:filename', (req, res) => {
  try {
    // Validate filename: no path traversal, only alphanumeric + safe chars
    const filename = req.params.filename;
    if (!filename || /[/\\]/.test(filename)) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const resolvedPath = path.resolve(path.join(UPLOADS_DIR, filename));
    // Ensure resolved path is strictly within UPLOADS_DIR
    if (!resolvedPath.startsWith(UPLOADS_DIR + path.sep) && resolvedPath !== UPLOADS_DIR) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Look up attachment in DB to get original_name and trusted mimetype
    const row = db.prepare('SELECT * FROM attachments WHERE filename = ?').get(filename);
    if (!row) return res.status(404).json({ error: 'Not found' });

    if (!fs.existsSync(resolvedPath)) return res.status(404).json({ error: 'File not found on disk' });

    // Force download with original name; use DB-stored mimetype (not user-supplied)
    res.setHeader('Content-Type', row.mimetype);
    res.setHeader('Content-Disposition', `attachment; filename="${row.original_name.replace(/"/g, '\\"')}"`);
    // Prevent browser from executing content even if content-type is wrong
    res.setHeader('X-Content-Type-Options', 'nosniff');

    fs.createReadStream(resolvedPath).pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tasks/:id/attachments — list attachments for a task
app.get('/api/tasks/:id/attachments', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM attachments WHERE task_id = ? ORDER BY uploadedAt ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/tasks/:id/attachments — upload a file
app.post('/api/tasks/:id/attachments', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error(err);
      const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400);
      const safeMessage = status === 413 ? 'File too large' : status === 415 ? 'File type not allowed' : 'Upload error';
      return res.status(status).json({ error: safeMessage });
    }
    next();
  });
}, (req, res) => {
  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/attachments/:id — remove an attachment
app.delete('/api/attachments/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    // Reconstruct path from UPLOADS_DIR + filename (NOT from DB-stored path field — path traversal risk)
    const safePath = path.resolve(path.join(UPLOADS_DIR, row.filename));
    if (!safePath.startsWith(UPLOADS_DIR + path.sep) && safePath !== UPLOADS_DIR) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Delete file from disk
    try { fs.unlinkSync(safePath); } catch (e) { /* ignore if already gone */ }

    db.prepare('DELETE FROM attachments WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Webhooks ─────────────────────────────────────────────────────────────────

app.get('/api/webhooks', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    const rows = db.prepare('SELECT * FROM webhooks WHERE projectId = ? ORDER BY createdAt ASC').all(projectId);
    // Never expose raw secrets — return a masked hint (last 4 chars of hash) instead
    res.json(rows.map(r => ({
      id: r.id,
      projectId: r.projectId,
      url: r.url,
      events: JSON.parse(r.events),
      secretHint: maskSecret(r.secret),
      createdAt: r.createdAt,
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/api/webhooks/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Never expose raw secrets
    res.json({
      id: row.id,
      projectId: row.projectId,
      url: row.url,
      events: JSON.parse(row.events),
      secretHint: maskSecret(row.secret),
      createdAt: row.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post('/api/webhooks', async (req, res) => {
  try {
    const plaintextSecret = req.body.secret || generateWebhookSecret();
    const hook = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      projectId: req.body.projectId || 'default',
      url: req.body.url || '',
      events: req.body.events || [],
      // Hash the secret before storing — never persist plaintext
      secret: encryptWebhookSecret(plaintextSecret),
      createdAt: new Date().toISOString(),
    };
    if (!hook.url) return res.status(400).json({ error: 'url required' });
    // Validate the URL: must be https and not target private/loopback IPs (SSRF protection)
    const urlError = await validateWebhookUrl(hook.url);
    if (urlError) return res.status(400).json({ error: urlError });
    db.prepare('INSERT INTO webhooks (id, projectId, url, events, secret, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hook.id, hook.projectId, hook.url, JSON.stringify(hook.events), hook.secret, hook.createdAt);
    // Return the plaintext secret ONCE on creation — caller must store it securely
    res.status(201).json({
      id: hook.id,
      projectId: hook.projectId,
      url: hook.url,
      events: hook.events,
      secret: plaintextSecret,   // only time plaintext is returned
      secretHint: maskSecret(hook.secret),
      createdAt: hook.createdAt,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.delete('/api/webhooks/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM webhooks WHERE id = ?').run(req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/webhooks/:id/rotate-secret — generate and store a new secret for an existing webhook.
// Returns the new plaintext secret ONCE; caller must store it securely.
app.post('/api/webhooks/:id/rotate-secret', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const newPlaintext = generateWebhookSecret();
    const newEncrypted = encryptWebhookSecret(newPlaintext);
    db.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(newEncrypted, req.params.id);
    res.json({
      id: row.id,
      secret: newPlaintext,          // plaintext returned ONCE — store securely
      secretHint: maskSecret(newEncrypted),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Stats Dashboard ─────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  let dbStatus = 'ok';
  try {
    db.prepare('SELECT 1').get();
  } catch (err) {
    dbStatus = 'error';
  }
  const healthy = dbStatus === 'ok';
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    uptime: process.uptime(),
    db: dbStatus,
    port: PORT,
    timestamp: new Date().toISOString(),
  });
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

// ─── Background lock expiry cleanup ──────────────────────────────────────────
// Run immediately at startup to clear any expired locks from a prior run,
// then repeat every 60 seconds. Keeps GET /api/tasks read-only.
const expireStaleLocksStmt = db.prepare(
  "UPDATE tasks SET lockedBy=NULL,lockedAt=NULL,lockExpiresAt=NULL WHERE lockExpiresAt IS NOT NULL AND lockExpiresAt < datetime('now')"
);
expireStaleLocksStmt.run(); // clear on startup
setInterval(() => {
  expireStaleLocksStmt.run();
}, 60000);

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Kanban board running at http://127.0.0.1:${PORT}`);
});
