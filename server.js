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
      scriptSrcAttr: ["'unsafe-inline'"],          // allow inline onclick/onchange handlers
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

// ─── SSE client registry ──────────────────────────────────────────────────────
// Maps projectId → Set of response objects for connected SSE clients.
const sseClients = new Map();

function sseSubscribe(projectId, res) {
  if (!sseClients.has(projectId)) sseClients.set(projectId, new Set());
  sseClients.get(projectId).add(res);
}

function sseUnsubscribe(projectId, res) {
  const set = sseClients.get(projectId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseClients.delete(projectId);
  }
}

// Fan-out an SSE event to all connected clients for a given projectId.
function sseBroadcast(projectId, eventType, data) {
  const set = sseClients.get(projectId);
  if (!set || set.size === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch(e) { /* client already gone */ }
  }
}

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
        db.prepare(`DELETE FROM handoff_log WHERE taskId IN (${placeholders})`).run(...taskIds);
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

// GET /api/projects/:id/waves — wave progress status
app.get('/api/projects/:id/waves', (req, res) => {
  try {
    const projectId = req.params.id;
    // Verify project exists
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // GROUP BY wave + column to get counts
    const rows = db.prepare(`
      SELECT
        wave,
        column AS col,
        COUNT(*) AS cnt
      FROM tasks
      WHERE projectId = ?
      GROUP BY wave, column
    `).all(projectId);

    // Aggregate into wave objects
    const waveMap = new Map();
    for (const row of rows) {
      const key = row.wave === null || row.wave === undefined ? null : row.wave;
      if (!waveMap.has(key)) {
        waveMap.set(key, { wave: key, total: 0, done: 0, inProgress: 0, inReview: 0, blocked: 0, idea: 0, backlog: 0 });
      }
      const entry = waveMap.get(key);
      entry.total += row.cnt;
      const col = row.col;
      if (col === 'done')          entry.done        += row.cnt;
      else if (col === 'in-progress') entry.inProgress  += row.cnt;
      else if (col === 'in-review')   entry.inReview    += row.cnt;
      else if (col === 'blocked')  entry.blocked     += row.cnt;
      else if (col === 'idea')     entry.idea        += row.cnt;
      else if (col === 'backlog')  entry.backlog     += row.cnt;
    }

    // Sort: numeric waves first (ascending), null wave last
    const result = Array.from(waveMap.values()).sort((a, b) => {
      if (a.wave === null && b.wave === null) return 0;
      if (a.wave === null) return 1;
      if (b.wave === null) return -1;
      return a.wave - b.wave;
    });

    res.json(result);
  } catch (err) {
    console.error('GET /api/projects/:id/waves error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Export / Import ─────────────────────────────────────────────────────────

// GET /api/projects/:id/export?format=json|csv|ics
// Exports all tasks for the project in the requested format.
//   json  — full project snapshot (project metadata + tasks array)
//   csv   — flat CSV with all task fields, one row per task
//   ics   — iCalendar VTODO output for tasks that have a dueDate
app.get('/api/projects/:id/export', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = db.prepare('SELECT * FROM tasks WHERE projectId = ?').all(req.params.id);

    const format = (req.query.format || 'json').toLowerCase();

    if (format === 'json') {
      const snapshot = {
        exportedAt: new Date().toISOString(),
        project: { ...project, agentConfig: project.agentConfig ? JSON.parse(project.agentConfig) : null },
        tasks: tasks.map(t => ({
          ...t,
          tags: JSON.parse(t.tags || '[]'),
          subtasks: t.subtasks ? JSON.parse(t.subtasks) : null,
          blockedBy: t.blockedBy ? JSON.parse(t.blockedBy) : [],
          handoffLog: t.handoffLog ? JSON.parse(t.handoffLog) : [],
        })),
      };
      res.setHeader('Content-Disposition', `attachment; filename="project-${req.params.id}-export.json"`);
      res.setHeader('Content-Type', 'application/json');
      return res.json(snapshot);
    }

    if (format === 'csv') {
      const CSV_FIELDS = ['id', 'title', 'description', 'assignee', 'priority', 'tags', 'column', 'createdAt', 'dueDate', 'recurring', 'subtasks', 'projectId', 'wave', 'blockedBy'];
      const escapeCsv = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return /[,"\n\r]/.test(str) ? `"${str}"` : str;
      };
      const header = CSV_FIELDS.join(',');
      const rows = tasks.map(t => {
        return CSV_FIELDS.map(f => {
          if (f === 'tags') return escapeCsv(JSON.parse(t.tags || '[]').join(';'));
          if (f === 'blockedBy') return escapeCsv((t.blockedBy ? JSON.parse(t.blockedBy) : []).join(';'));
          if (f === 'subtasks') return escapeCsv(t.subtasks ? JSON.stringify(JSON.parse(t.subtasks)) : '');
          return escapeCsv(t[f]);
        }).join(',');
      });
      const csv = [header, ...rows].join('\n');
      res.setHeader('Content-Disposition', `attachment; filename="project-${req.params.id}-export.csv"`);
      res.setHeader('Content-Type', 'text/csv');
      return res.send(csv);
    }

    if (format === 'ics') {
      // Only export tasks that have a dueDate
      const dueTasks = tasks.filter(t => t.dueDate);

      const escapeIcs = (str) => (str || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

      const foldLine = (line) => {
        // RFC 5545: lines longer than 75 octets must be folded
        const out = [];
        while (line.length > 75) {
          out.push(line.slice(0, 75));
          line = ' ' + line.slice(75);
        }
        out.push(line);
        return out.join('\r\n');
      };

      const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2)}@kanban`;

      const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Kanban Board//Export//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
      ];

      for (const t of dueTasks) {
        const dueDate = t.dueDate.replace(/-/g, '');  // YYYYMMDD
        const createdAt = new Date(t.createdAt).toISOString().replace(/[-:]/g, '').replace('.000', '');
        const priority = { urgent: 1, high: 3, medium: 5, low: 9 }[t.priority] || 5;
        const status = t.column === 'done' ? 'COMPLETED' : 'NEEDS-ACTION';
        lines.push('BEGIN:VTODO');
        lines.push(`UID:${uid()}`);
        lines.push(`DTSTAMP:${createdAt.slice(0, 15)}Z`);
        lines.push(`CREATED:${createdAt.slice(0, 15)}Z`);
        lines.push(foldLine(`SUMMARY:${escapeIcs(t.title)}`));
        if (t.description) lines.push(foldLine(`DESCRIPTION:${escapeIcs(t.description.slice(0, 500))}`));
        lines.push(`DUE;VALUE=DATE:${dueDate}`);
        lines.push(`PRIORITY:${priority}`);
        lines.push(`STATUS:${status}`);
        lines.push(`CATEGORIES:${escapeIcs((JSON.parse(t.tags || '[]')).join(',') || 'kanban')}`);
        lines.push('END:VTODO');
      }
      lines.push('END:VCALENDAR');

      const ics = lines.join('\r\n');
      res.setHeader('Content-Disposition', `attachment; filename="project-${req.params.id}-export.ics"`);
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      return res.send(ics);
    }

    return res.status(400).json({ error: 'Invalid format. Use: json, csv, or ics' });
  } catch (err) {
    console.error('GET /api/projects/:id/export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/import
// Body: { tasks: [...] }  — array of task objects (fields same as task schema)
// Creates tasks in bulk; generates new IDs (does not overwrite existing tasks).
// Returns: { imported: <count>, skipped: <count>, tasks: [...created task ids] }
app.post('/api/projects/:id/import', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    // Accept { tasks: [...] } or a bare array or a JSON snapshot from our own exporter
    let taskList = null;
    if (Array.isArray(incoming)) {
      taskList = incoming;
    } else if (Array.isArray(incoming.tasks)) {
      taskList = incoming.tasks;
    } else {
      return res.status(400).json({ error: 'Body must be { tasks: [...] } or a task array' });
    }

    if (taskList.length === 0) {
      return res.status(400).json({ error: 'tasks array is empty' });
    }
    if (taskList.length > 500) {
      return res.status(400).json({ error: 'Cannot import more than 500 tasks at once' });
    }

    const IMPORT_ALLOWED_COLUMNS = new Set(['idea', 'backlog', 'in-progress', 'in-review', 'done']);
    const IMPORT_ALLOWED_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);

    const importTasks = db.transaction(() => {
      const imported = [];
      let skipped = 0;
      const now = new Date().toISOString();

      for (const raw of taskList) {
        if (!raw || typeof raw !== 'object') { skipped++; continue; }
        const title = (raw.title || '').trim();
        if (!title) { skipped++; continue; }

        const col = IMPORT_ALLOWED_COLUMNS.has(raw.column) ? raw.column : 'backlog';
        const pri = IMPORT_ALLOWED_PRIORITIES.has(raw.priority) ? raw.priority : 'medium';
        const tags = Array.isArray(raw.tags) ? raw.tags : (typeof raw.tags === 'string' ? raw.tags.split(';').map(t => t.trim()).filter(Boolean) : []);
        const blockedBy = Array.isArray(raw.blockedBy) ? raw.blockedBy : [];
        const wave = Number.isInteger(raw.wave) && raw.wave >= 0 ? raw.wave : null;
        const dueDate = raw.dueDate ? String(raw.dueDate).slice(0, 10) : null;
        const subtasks = raw.subtasks ? JSON.stringify(raw.subtasks) : null;

        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        db.prepare(
          'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, dueDate, recurring, subtasks, projectId, wave, blockedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          id,
          title,
          raw.description || '',
          raw.assignee || 'Mike',
          pri,
          JSON.stringify(tags),
          col,
          now,
          dueDate,
          raw.recurring || null,
          subtasks,
          req.params.id,
          wave,
          JSON.stringify(blockedBy)
        );

        // Log import activity
        const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        db.prepare(
          'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(actId, id, 'created', `Card imported into ${COL_LABELS[col] || col}`, raw.assignee || 'Mike', now);

        imported.push(id);
      }

      return { imported, skipped };
    });

    const result = importTasks();
    res.status(201).json({
      imported: result.imported.length,
      skipped: result.skipped,
      taskIds: result.imported,
    });
  } catch (err) {
    console.error('POST /api/projects/:id/import error:', err);
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

// Get all tasks (optionally filtered by projectId and server-side filter params)
// Supported query params:
//   ?projectId=default       — project scope (default: "default")
//   ?column=backlog          — exact column match
//   ?wave=1                  — exact wave match (integer)
//   ?blocked=false|true      — filter by computed blocked status
//   ?locked=false|true       — filter by lock state (locked=false means no active lock)
//   ?assignee=ClawDawg       — exact assignee match
//   ?priority=high           — exact priority match
//   ?tag=agent               — JSON array contains check (case-sensitive)
//   ?agentStatus=idle|in-progress|claimed|done — computed agent status filter
//   ?dueBefore=2025-12-31    — tasks with dueDate before this date (YYYY-MM-DD)
// All params are optional and combinable.
app.get('/api/tasks', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';

    // Build SQL WHERE clauses incrementally
    const conditions = ['projectId = ?'];
    const params = [projectId];

    // ?column=backlog
    if (req.query.column !== undefined) {
      conditions.push('"column" = ?');
      params.push(req.query.column);
    }

    // ?wave=1
    if (req.query.wave !== undefined) {
      const waveVal = req.query.wave === 'null' ? null : parseInt(req.query.wave, 10);
      if (waveVal === null) {
        conditions.push('wave IS NULL');
      } else if (!isNaN(waveVal)) {
        conditions.push('wave = ?');
        params.push(waveVal);
      }
    }

    // ?assignee=ClawDawg
    if (req.query.assignee !== undefined) {
      conditions.push('assignee = ?');
      params.push(req.query.assignee);
    }

    // ?priority=high
    if (req.query.priority !== undefined) {
      conditions.push('priority = ?');
      params.push(req.query.priority);
    }

    // ?tag=agent — JSON array contains check using LIKE
    if (req.query.tag !== undefined) {
      // Matches '"agent"' inside the JSON array string
      conditions.push('tags LIKE ?');
      params.push(`%"${req.query.tag}"%`);
    }

    // ?locked=false — no active lock; ?locked=true — has active (non-expired) lock
    if (req.query.locked !== undefined) {
      if (req.query.locked === 'false') {
        conditions.push("(lockExpiresAt IS NULL OR lockExpiresAt < datetime('now'))");
      } else if (req.query.locked === 'true') {
        conditions.push("(lockExpiresAt IS NOT NULL AND lockExpiresAt >= datetime('now'))");
      }
    }

    // ?dueBefore=2025-12-31
    if (req.query.dueBefore !== undefined) {
      conditions.push('dueDate IS NOT NULL AND dueDate < ?');
      params.push(req.query.dueBefore);
    }

    // Lock expiry is handled by background cleanup (see setInterval below) — no UPDATE here
    const sql = `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY sortOrder ASC NULLS LAST, createdAt ASC`;
    let rows = db.prepare(sql).all(...params);

    // Compute blocked status for each task (needed for ?blocked filter and response shape)
    // Fetch done IDs scoped to the same project for accurate blocked computation
    const allProjectRows = (conditions.length === 1)
      ? rows  // no extra filters — rows IS the full project set
      : db.prepare('SELECT id, "column", blockedBy FROM tasks WHERE projectId = ?').all(projectId);
    const doneIds = new Set(allProjectRows.filter(r => r.column === 'done').map(r => r.id));

    // Compute agentStatus for each row
    const computeAgentStatus = (row) => {
      if (row.column === 'done') return 'done';
      if (!row.lockedBy) return 'idle';
      const now = new Date();
      const expires = row.lockExpiresAt ? new Date(row.lockExpiresAt) : null;
      if (expires && expires < now) return 'idle'; // lock expired
      return row.column === 'in-progress' ? 'in-progress' : 'claimed';
    };

    const computeBlocked = (row) => {
      const blockedBy = row.blockedBy ? JSON.parse(row.blockedBy) : [];
      return blockedBy.some(id => !doneIds.has(id));
    };

    // Apply post-SQL filters that require computed values
    if (req.query.blocked !== undefined) {
      const wantBlocked = req.query.blocked === 'true';
      rows = rows.filter(row => computeBlocked(row) === wantBlocked);
    }

    if (req.query.agentStatus !== undefined) {
      const wantStatus = req.query.agentStatus;
      rows = rows.filter(row => computeAgentStatus(row) === wantStatus);
    }

    // Fetch all handoff_log rows for the returned tasks in one query (avoid N+1)
    const taskIds = rows.map(r => r.id);
    let handoffByTaskId = {};
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => '?').join(', ');
      const handoffRows = db.prepare(`SELECT * FROM handoff_log WHERE taskId IN (${placeholders}) ORDER BY timestamp ASC`).all(...taskIds);
      for (const h of handoffRows) {
        if (!handoffByTaskId[h.taskId]) handoffByTaskId[h.taskId] = [];
        handoffByTaskId[h.taskId].push(h);
      }
    }

    res.json(rows.map(row => {
      // Use new table rows if present, fall back to legacy JSON blob
      const handoffLog = handoffByTaskId[row.id]
        ? handoffByTaskId[row.id]
        : (row.handoffLog ? JSON.parse(row.handoffLog) : []);
      return {
        ...row,
        tags: JSON.parse(row.tags),
        subtasks: row.subtasks ? JSON.parse(row.subtasks) : null,
        blockedBy: row.blockedBy ? JSON.parse(row.blockedBy) : [],
        blocked: computeBlocked(row),
        handoffLog,
        agentStatus: computeAgentStatus(row),
      };
    }));
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

// POST /api/tasks/claim-next — atomic queue-pop for agents
// Accepts { agentSessionId, projectId, wave?, assignee?, tags?, priority? }
// Inside a BEGIN IMMEDIATE transaction: finds the highest-priority available
// (unlocked, not blocked, backlog column) task matching filters, claims it,
// and returns it. Returns 204 if no matching task is available.
app.post('/api/tasks/claim-next', (req, res) => {
  try {
    const { agentSessionId, projectId, wave, assignee, tags, priority } = req.body;

    if (!agentSessionId || typeof agentSessionId !== 'string' || agentSessionId.trim() === '') {
      return res.status(400).json({ error: 'agentSessionId is required and must be a non-empty string' });
    }

    const resolvedProjectId = projectId || 'default';

    const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low'];

    // Use BEGIN IMMEDIATE to prevent TOCTOU races between concurrent agents
    const claimNext = db.transaction(() => {
      // Fetch all backlog tasks for this project
      let rows = db.prepare(
        `SELECT * FROM tasks WHERE projectId = ? AND "column" = 'backlog'`
      ).all(resolvedProjectId);

      // Filter out locked tasks (unexpired locks only)
      const now = new Date();
      rows = rows.filter(row => {
        if (!row.lockedBy) return true;
        const expires = row.lockExpiresAt ? new Date(row.lockExpiresAt) : null;
        return expires && expires < now; // lock expired → available
      });

      // Filter out blocked tasks (any blocker not yet done)
      const doneIds = new Set(
        db.prepare(`SELECT id FROM tasks WHERE projectId = ? AND "column" = 'done'`).all(resolvedProjectId).map(r => r.id)
      );
      rows = rows.filter(row => {
        const blockedBy = row.blockedBy ? JSON.parse(row.blockedBy) : [];
        return !blockedBy.some(id => !doneIds.has(id));
      });

      // Apply optional filters
      if (wave !== undefined && wave !== null) {
        rows = rows.filter(row => row.wave === wave);
      }
      if (assignee !== undefined && assignee !== null) {
        rows = rows.filter(row => row.assignee === assignee);
      }
      if (priority !== undefined && priority !== null) {
        rows = rows.filter(row => row.priority === priority);
      }
      if (tags !== undefined && tags !== null && Array.isArray(tags) && tags.length > 0) {
        rows = rows.filter(row => {
          const taskTags = row.tags ? JSON.parse(row.tags) : [];
          return tags.every(t => taskTags.includes(t));
        });
      }

      if (rows.length === 0) return null;

      // Sort by priority (highest first), then by createdAt (oldest first) as tiebreaker
      rows.sort((a, b) => {
        const pa = PRIORITY_ORDER.indexOf(a.priority);
        const pb = PRIORITY_ORDER.indexOf(b.priority);
        if (pa !== pb) return pa - pb;
        return new Date(a.createdAt) - new Date(b.createdAt);
      });

      const best = rows[0];
      const claimNow = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      // Atomic claim: UPDATE only if still unlocked or lock expired
      const result = db.prepare(
        `UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ?, "column" = 'in-progress'
         WHERE id = ? AND (lockedBy IS NULL OR lockExpiresAt < datetime('now'))`
      ).run(agentSessionId, claimNow, expiresAt, agentSessionId, claimNow, best.id);

      if (result.changes === 0) {
        // Another agent snuck in — return null to signal caller to retry or give up
        return null;
      }

      return db.prepare('SELECT * FROM tasks WHERE id = ?').get(best.id);
    });

    const claimed = claimNext();

    if (!claimed) {
      return res.status(204).end();
    }

    const claimedHandoffRows = db.prepare('SELECT * FROM handoff_log WHERE taskId = ? ORDER BY timestamp ASC').all(claimed.id);
    const claimedHandoffLog = claimedHandoffRows.length > 0
      ? claimedHandoffRows
      : (claimed.handoffLog ? JSON.parse(claimed.handoffLog) : []);
    res.json({
      ...claimed,
      tags: JSON.parse(claimed.tags),
      subtasks: claimed.subtasks ? JSON.parse(claimed.subtasks) : null,
      blockedBy: claimed.blockedBy ? JSON.parse(claimed.blockedBy) : [],
      handoffLog: claimedHandoffLog,
    });
  } catch (err) {
    console.error('POST /api/tasks/claim-next error:', err);
    res.status(500).json({ error: 'Internal server error' });
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

// POST /api/tasks/:id/keepalive — extend the lock expiry for a long-running agent
app.post('/api/tasks/:id/keepalive', (req, res) => {
  try {
    const { agentSessionId } = req.body;

    if (!agentSessionId || typeof agentSessionId !== 'string' || agentSessionId.trim() === '') {
      return res.status(400).json({ error: 'agentSessionId is required and must be a non-empty string' });
    }

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    // 409 if lock has already expired (or was never set)
    const now = new Date();
    const expires = task.lockExpiresAt ? new Date(task.lockExpiresAt) : null;
    if (!task.lockedBy || !expires || expires < now) {
      return res.status(409).json({ error: 'Lock has already expired or task is not locked' });
    }

    // 403 if session ID doesn't match the current lock owner
    if (task.lockedBy !== agentSessionId) {
      return res.status(403).json({ error: 'agentSessionId does not match lock owner' });
    }

    // Extend lockExpiresAt by 10 minutes from now
    const newExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare('UPDATE tasks SET lockExpiresAt = ? WHERE id = ?').run(newExpiry, req.params.id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json({
      ...updated,
      tags: JSON.parse(updated.tags),
      subtasks: updated.subtasks ? JSON.parse(updated.subtasks) : null,
      blockedBy: updated.blockedBy ? JSON.parse(updated.blockedBy) : [],
      handoffLog: updated.handoffLog ? JSON.parse(updated.handoffLog) : [],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
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

    // Fan-out SSE event to connected clients for this project
    sseBroadcast(task.projectId, 'task.created', { task });

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

  // Fan-out SSE event to connected clients for this project
  sseBroadcast(updated.projectId || 'default', 'task.updated', { task: updated });

  res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Reorder tasks within a column (or across columns)
// Body: { taskId, newIndex, column }
// Calculates a new sortOrder for the task by placing it between the cards at (newIndex-1) and newIndex
app.post('/api/tasks/reorder', (req, res) => {
  try {
    const { taskId, newIndex, column } = req.body;
    if (!taskId || newIndex == null || !column) {
      return res.status(400).json({ error: 'taskId, newIndex, and column are required' });
    }
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'Not found' });

    // Fetch all tasks in the target column (ordered by sortOrder, then createdAt as tiebreaker)
    // Exclude the dragged task itself
    const siblings = db.prepare(
      `SELECT id, sortOrder FROM tasks WHERE "column" = ? AND projectId = ? AND id != ? ORDER BY sortOrder ASC NULLS LAST, createdAt ASC`
    ).all(column, task.projectId || 'default', taskId);

    // Clamp newIndex to valid range
    const clampedIndex = Math.max(0, Math.min(newIndex, siblings.length));

    let newSortOrder;
    if (siblings.length === 0) {
      newSortOrder = 1000;
    } else if (clampedIndex === 0) {
      // Insert before the first card
      const firstOrder = siblings[0].sortOrder != null ? siblings[0].sortOrder : 1000;
      newSortOrder = firstOrder - 1000;
    } else if (clampedIndex >= siblings.length) {
      // Insert after the last card
      const lastOrder = siblings[siblings.length - 1].sortOrder != null ? siblings[siblings.length - 1].sortOrder : 1000;
      newSortOrder = lastOrder + 1000;
    } else {
      // Insert between two cards
      const prev = siblings[clampedIndex - 1].sortOrder != null ? siblings[clampedIndex - 1].sortOrder : 0;
      const next = siblings[clampedIndex].sortOrder != null ? siblings[clampedIndex].sortOrder : prev + 2000;
      newSortOrder = (prev + next) / 2;

      // Renormalize if the gap gets too small (< 0.001)
      if (Math.abs(next - prev) < 0.001) {
        // Renormalize all tasks in this column with spacing of 1000
        const allInCol = db.prepare(
          `SELECT id FROM tasks WHERE "column" = ? AND projectId = ? ORDER BY sortOrder ASC NULLS LAST, createdAt ASC`
        ).all(column, task.projectId || 'default');
        const renorm = db.transaction(() => {
          allInCol.forEach((t, i) => {
            db.prepare('UPDATE tasks SET sortOrder = ? WHERE id = ?').run((i + 1) * 1000, t.id);
          });
        });
        renorm();
        // After renormalization, recompute newSortOrder
        const renormedSiblings = db.prepare(
          `SELECT id, sortOrder FROM tasks WHERE "column" = ? AND projectId = ? AND id != ? ORDER BY sortOrder ASC`
        ).all(column, task.projectId || 'default', taskId);
        const ci = Math.min(clampedIndex, renormedSiblings.length);
        if (ci === 0) {
          newSortOrder = (renormedSiblings[0]?.sortOrder ?? 1000) - 1000;
        } else if (ci >= renormedSiblings.length) {
          newSortOrder = (renormedSiblings[renormedSiblings.length - 1]?.sortOrder ?? 0) + 1000;
        } else {
          newSortOrder = ((renormedSiblings[ci - 1].sortOrder ?? 0) + (renormedSiblings[ci].sortOrder ?? 0)) / 2;
        }
      }
    }

    // Update the task's column and sortOrder
    db.prepare('UPDATE tasks SET "column" = ?, sortOrder = ? WHERE id = ?').run(column, newSortOrder, taskId);

    // If column changed, log it
    if (column !== task.column) {
      const now = new Date().toISOString();
      const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      db.prepare(
        'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(actId, taskId, 'move', `Moved from ${COL_LABELS[task.column] || task.column} → ${COL_LABELS[column] || column}`, 'System', now);
      db.prepare(
        'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(taskId, task.title, task.column, column, task.assignee || 'System', now);
    }

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    sseBroadcast(task.projectId || 'default', 'task.updated', { task: updated });
    res.json({ ...updated, tags: JSON.parse(updated.tags), sortOrder: newSortOrder });
  } catch (err) {
    console.error('POST /api/tasks/reorder error:', err);
    res.status(500).json({ error: 'Internal server error' });
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
    // Populate handoffLog from dedicated table (new) or fall back to JSON blob (legacy)
    const handoffRows = db.prepare('SELECT * FROM handoff_log WHERE taskId = ? ORDER BY timestamp ASC').all(task.id);
    const handoffLog = handoffRows.length > 0
      ? handoffRows
      : (task.handoffLog ? JSON.parse(task.handoffLog) : []);
    res.json({
      ...task,
      tags: JSON.parse(task.tags),
      subtasks: task.subtasks ? JSON.parse(task.subtasks) : null,
      blockedBy: task.blockedBy ? JSON.parse(task.blockedBy) : [],
      blocked: activeBlockers.length > 0,
      handoffLog,
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

    // Check if task has unresolved blockers
    const activeBlockers = db.prepare(
      "SELECT td.blocker_id FROM task_dependencies td INNER JOIN tasks t ON t.id = td.blocker_id WHERE td.blocked_id = ? AND t.column != 'done'"
    ).all(req.params.id);
    if (activeBlockers.length > 0) {
      const activeBlockerIds = activeBlockers.map(r => r.blocker_id);
      return res.status(409).json({ error: 'Task is blocked', blockedBy: activeBlockerIds });
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

// POST /api/tasks/:id/handoff — append a handoff note (writes to dedicated table)
app.post('/api/tasks/:id/handoff', (req, res) => {
  try {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const message = (req.body.message || req.body.note || '').trim();
    if (!message) return res.status(400).json({ error: 'message required' });

    const crypto = require('crypto');
    const entry = {
      id: crypto.randomBytes(8).toString('hex'),
      taskId: req.params.id,
      agentId: req.body.agentId || req.body.agentSessionId || 'unknown',
      message,
      timestamp: new Date().toISOString(),
    };

    db.prepare('INSERT INTO handoff_log (id, taskId, agentId, message, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.taskId, entry.agentId, entry.message, entry.timestamp);

    res.status(201).json(entry);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tasks/:id/handoff — list all handoff notes for a task
app.get('/api/tasks/:id/handoff', (req, res) => {
  try {
    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const rows = db.prepare('SELECT * FROM handoff_log WHERE taskId = ? ORDER BY timestamp ASC').all(req.params.id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Agent Logs ───────────────────────────────────────────────────────────────

// POST /api/tasks/:id/logs — append a log entry (called by agents)
app.post('/api/tasks/:id/logs', (req, res) => {
  try {
    const task = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(req.params.id);
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

    const logEntry = { id: result.lastInsertRowid, ...entry };

    // Fan-out SSE log.created event to connected clients for this project
    sseBroadcast(task.projectId || 'default', 'log.created', { log: logEntry });

    res.status(201).json(logEntry);
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

// POST /api/tasks/bulk — perform a bulk action on multiple tasks
// Body: { ids: string[], action: 'move' | 'delete', data?: { column?: string } }
// Returns: { affected: number, results: [...] }
app.post('/api/tasks/bulk', (req, res) => {
  try {
    const { ids, action, data } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    if (ids.length > 200) {
      return res.status(400).json({ error: 'Cannot bulk-operate on more than 200 tasks at once' });
    }
    if (!['move', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'action must be one of: move, delete' });
    }

    if (action === 'move') {
      const newCol = data && data.column;
      if (!newCol || !VALID_COLUMNS.includes(newCol)) {
        return res.status(400).json({ error: `data.column must be one of: ${VALID_COLUMNS.join(', ')}` });
      }

      const now = new Date().toISOString();
      const results = [];

      const bulkMove = db.transaction(() => {
        for (const id of ids) {
          const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
          if (!task) { results.push({ id, ok: false, error: 'Not found' }); continue; }
          if (task.column === newCol) { results.push({ id, ok: true, skipped: true }); continue; }

          db.prepare('UPDATE tasks SET "column" = ? WHERE id = ?').run(newCol, id);

          // Activity log
          const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
          db.prepare(
            'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(actId, id, 'move', `Moved from ${COL_LABELS[task.column] || task.column} → ${COL_LABELS[newCol] || newCol} (bulk)`, 'System', now);

          db.prepare(
            'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          ).run(id, task.title, task.column, newCol, 'System', now);

          results.push({ id, ok: true });
        }
      });
      bulkMove();

      // SSE broadcast per task
      const projectId = (ids.length > 0 && db.prepare('SELECT projectId FROM tasks WHERE id = ?').get(ids[0]))?.projectId || 'default';
      sseBroadcast(projectId, 'task.updated', { bulkMove: true, ids, column: newCol });

      return res.json({ affected: results.filter(r => r.ok && !r.skipped).length, results });
    }

    if (action === 'delete') {
      const results = [];

      // Collect unique projectIds before deletion
      const placeholders = ids.map(() => '?').join(',');
      const tasksToDelete = db.prepare(`SELECT DISTINCT projectId FROM tasks WHERE id IN (${placeholders})`).all(...ids);
      const projectIds = new Set(tasksToDelete.map(t => t.projectId || 'default'));

      const bulkDelete = db.transaction(() => {
        for (const id of ids) {
          const task = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(id);
          if (!task) { results.push({ id, ok: false, error: 'Not found' }); continue; }

          db.prepare('DELETE FROM agent_logs WHERE taskId = ?').run(id);
          db.prepare('DELETE FROM handoff_log WHERE taskId = ?').run(id);
          db.prepare('DELETE FROM card_activity WHERE taskId = ?').run(id);
          db.prepare('DELETE FROM notifications WHERE task_id = ?').run(id);
          db.prepare('DELETE FROM task_dependencies WHERE blocker_id = ? OR blocked_id = ?').run(id, id);
          db.prepare('DELETE FROM attachments WHERE task_id = ?').run(id);
          db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

          results.push({ id, ok: true });
        }
      });
      bulkDelete();

      // SSE broadcast per unique projectId
      for (const pid of projectIds) {
        sseBroadcast(pid, 'task.deleted', { bulkDelete: true, ids });
      }

      return res.json({ affected: results.filter(r => r.ok).length, results });
    }
  } catch (err) {
    console.error('POST /api/tasks/bulk error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    // Capture projectId before deletion for SSE fan-out
    const taskRow = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(req.params.id);
    const deletedProjectId = taskRow ? (taskRow.projectId || 'default') : 'default';

    const deleteTask = db.transaction(() => {
      const taskId = req.params.id;
      // Cascade cleanup of all child tables (foreign_keys pragma not enabled, so manual)
      db.prepare('DELETE FROM agent_logs WHERE taskId = ?').run(taskId);
      db.prepare('DELETE FROM handoff_log WHERE taskId = ?').run(taskId);
      db.prepare('DELETE FROM card_activity WHERE taskId = ?').run(taskId);
      db.prepare('DELETE FROM notifications WHERE task_id = ?').run(taskId);
      db.prepare('DELETE FROM task_dependencies WHERE blocker_id = ? OR blocked_id = ?').run(taskId, taskId);
      db.prepare('DELETE FROM attachments WHERE task_id = ?').run(taskId);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    });
    deleteTask();

    // Fan-out SSE event to connected clients for this project
    sseBroadcast(deletedProjectId, 'task.deleted', { taskId: req.params.id });

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

// Mark a single notification as read
app.post('/api/notifications/:id/read', (req, res) => {
  try {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(req.params.id);
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
    const projectId = req.query.projectId || null;

    let query, params;
    if (projectId) {
      // Filter to dependencies where either blocker or blocked task belongs to the project
      query = `SELECT d.blocker_id, d.blocked_id FROM task_dependencies d
               INNER JOIN tasks t ON (t.id = d.blocker_id OR t.id = d.blocked_id)
               WHERE t.projectId = ?
               GROUP BY d.blocker_id, d.blocked_id
               LIMIT ? OFFSET ?`;
      params = [projectId, limit, offset];
    } else {
      query = 'SELECT blocker_id, blocked_id FROM task_dependencies LIMIT ? OFFSET ?';
      params = [limit, offset];
    }

    const rows = db.prepare(query).all(...params);
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

    // Agent activity metrics
    const nowIso = new Date().toISOString();
    const agentActive = db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE projectId = ? AND lockedBy IS NOT NULL AND lockExpiresAt >= ?`
    ).get(projectId, nowIso).cnt;

    const agentExpiredLocks = db.prepare(
      `SELECT COUNT(*) as cnt FROM tasks WHERE projectId = ? AND lockedBy IS NOT NULL AND lockExpiresAt < ?`
    ).get(projectId, nowIso).cnt;

    // blockedCount: tasks where at least one blockedBy dep is not done, and task itself is not done
    const allNonDone = db.prepare(
      `SELECT id, blockedBy FROM tasks WHERE projectId = ? AND "column" != 'done'`
    ).all(projectId);
    const doneIdSet = new Set(
      db.prepare(`SELECT id FROM tasks WHERE projectId = ? AND "column" = 'done'`).all(projectId).map(r => r.id)
    );
    let blockedCount = 0;
    for (const t of allNonDone) {
      const deps = t.blockedBy ? JSON.parse(t.blockedBy) : [];
      if (deps.some(id => !doneIdSet.has(id))) blockedCount++;
    }

    // waveProgress: per-wave breakdown
    const waveRows = db.prepare(
      `SELECT wave, "column", COUNT(*) as cnt FROM tasks WHERE projectId = ? GROUP BY wave, "column"`
    ).all(projectId);
    const waveMap = new Map();
    for (const row of waveRows) {
      const key = row.wave === null || row.wave === undefined ? null : row.wave;
      if (!waveMap.has(key)) waveMap.set(key, { wave: key, total: 0, done: 0 });
      const entry = waveMap.get(key);
      entry.total += row.cnt;
      if (row.column === 'done') entry.done += row.cnt;
    }
    const waveProgress = Array.from(waveMap.values())
      .filter(w => w.wave !== null)
      .sort((a, b) => a.wave - b.wave)
      .map(w => ({ wave: w.wave, total: w.total, done: w.done, pct: w.total > 0 ? Math.round((w.done / w.total) * 100) : 0 }));

    // completedByAgent: tasks completed this week, grouped by agentSessionId
    const completedByAgentRows = db.prepare(
      `SELECT t.agentSessionId, COUNT(DISTINCT a.taskId) as cnt
       FROM card_activity a
       INNER JOIN tasks t ON t.id = a.taskId
       WHERE a.type = 'move' AND a.content LIKE '%→ Done%' AND a.createdAt >= ? AND t.projectId = ? AND t.agentSessionId IS NOT NULL
       GROUP BY t.agentSessionId`
    ).all(weekAgo, projectId);
    const completedByAgent = completedByAgentRows.map(r => ({ agentSessionId: r.agentSessionId, count: r.cnt }));

    res.json({
      projectId, projectName, totalByAssignee, completedThisWeek, overdueCount, columnCounts,
      avgTimeToComplete, agentActive, agentExpiredLocks, blockedCount, waveProgress, completedByAgent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Server-Sent Events ───────────────────────────────────────────────────────
// GET /api/events?projectId=X
// Streams task.created, task.updated, task.deleted, and log.created events
// to connected clients so the board can update in real-time without polling.
app.get('/api/events', (req, res) => {
  const projectId = req.query.projectId || 'default';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx proxy buffering
  res.flushHeaders();

  // Send a heartbeat comment every 25s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch(e) { /* ignore */ }
  }, 25000);

  sseSubscribe(projectId, res);

  // Immediately send a 'connected' event so the client knows the stream is live
  res.write(`event: connected\ndata: ${JSON.stringify({ projectId, ts: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseUnsubscribe(projectId, res);
  });
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
