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
const MAX_AGENT_LOG_MESSAGE_BYTES = 10 * 1024;
const SAFE_AGENT_MODEL_REGEX = /^[a-zA-Z0-9/_.-]+$/;
const MAX_SPAWN_TASK_DESCRIPTION_LENGTH = 4000;

// In-memory registry of spawned agent processes (taskId → { pid, sessionKey, startTime })
const agentProcesses = new Map();
const DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN = '{{KANBAN_SUBAGENTS_PATH}}';
const DEFAULT_TEMPLATE_AGENT_PHONE_TOKEN = '{{KANBAN_AGENT_PHONE}}';
const DEFAULT_TEMPLATE_SUBAGENTS_PATH = process.env.KANBAN_SUBAGENTS_PATH || DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN;
const DEFAULT_TEMPLATE_AGENT_PHONE = process.env.KANBAN_AGENT_PHONE || DEFAULT_TEMPLATE_AGENT_PHONE_TOKEN;

const intervalHandles = new Set();
const activeRequests = new Set();
const openSockets = new Set();
let isShuttingDown = false;
let shutdownPromise = null;

function trackInterval(fn, ms) {
  const handle = setInterval(fn, ms);
  intervalHandles.add(handle);
  return handle;
}

function untrackRequest(req) {
  activeRequests.delete(req);
}

function waitForActiveRequestsToDrain(timeoutMs) {
  if (activeRequests.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (activeRequests.size === 0 || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function generateAgentSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function getDefaultAgentTemplateDescription() {
  return `Read ${DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN} first — it has everything you need: git workflow, notifications, kanban API, conflict avoidance, and ground rules.

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

Send a BlueBubbles message to ${DEFAULT_TEMPLATE_AGENT_PHONE_TOKEN}:
- START: "🔨 Starting: [task title]"
- FINISH: "✅ Done: [task title]\\n[2-3 sentences on what changed]"
- BLOCKER: "⚠️ Blocked: [task title]\\n[what you need and why]"`;
}

function resolveTemplatePlaceholders(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .split(DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN).join(DEFAULT_TEMPLATE_SUBAGENTS_PATH)
    .split(DEFAULT_TEMPLATE_AGENT_PHONE_TOKEN).join(DEFAULT_TEMPLATE_AGENT_PHONE);
}

function parseProjectAgentConfig(project) {
  if (!project?.agentConfig) return {};
  try {
    const parsed = typeof project.agentConfig === 'string'
      ? JSON.parse(project.agentConfig)
      : project.agentConfig;
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

function getTaskLockExpiryIso(project) {
  const agentConfig = parseProjectAgentConfig(project);
  const timeoutSeconds = Number(agentConfig.timeoutSeconds);
  const ttlSeconds = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 600;
  return new Date(Date.now() + ttlSeconds * 1000).toISOString();
}

function getValidatedAgentModel(agentConfig) {
  if (!agentConfig?.model) return null;
  if (typeof agentConfig.model !== 'string') return null;
  const trimmedModel = agentConfig.model.trim();
  if (!trimmedModel) return null;
  return SAFE_AGENT_MODEL_REGEX.test(trimmedModel) ? trimmedModel : null;
}

function truncateSpawnTaskDescription(description) {
  if (typeof description !== 'string' || !description) return '';
  if (description.length <= MAX_SPAWN_TASK_DESCRIPTION_LENGTH) return description;
  return `${description.slice(0, MAX_SPAWN_TASK_DESCRIPTION_LENGTH)}\n\n[truncated]`;
}

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],       // allow inline <script> blocks for the Kanban UI
      scriptSrcAttr: ["'none'"],                       // block inline handlers — all migrated to addEventListener
      styleSrc:  ["'self'", "'unsafe-inline'"],       // allow inline styles
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
app.use((req, res, next) => {
  if (isShuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ error: 'Server is shutting down' });
  }

  activeRequests.add(req);
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    untrackRequest(req);
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── API authentication (bearer token) ───────────────────────────────────────
// Set KANBAN_API_KEY env var to require Bearer auth on all /api/* routes.
// If KANBAN_API_KEY is unset, the API remains open (backward-compatible).
app.use('/api', (req, res, next) => {
  const token = process.env.KANBAN_API_KEY;
  if (!token) return next(); // no key configured = open mode
  const auth = req.headers.authorization || '';
  const provided = Buffer.from(auth.replace('Bearer ', ''), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length || !require('crypto').timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── SSE client registry ──────────────────────────────────────────────────────
const DEFAULT_MAX_PROJECT_SSE_CONNECTIONS = 50;
const configuredMaxProjectSseConnections = Number.parseInt(process.env.MAX_PROJECT_SSE_CONNECTIONS || '', 10);
const MAX_PROJECT_SSE_CONNECTIONS = Number.isInteger(configuredMaxProjectSseConnections) && configuredMaxProjectSseConnections > 0
  ? configuredMaxProjectSseConnections
  : DEFAULT_MAX_PROJECT_SSE_CONNECTIONS;

// Maps projectId → Map<response, { heartbeat: IntervalHandle }>
const sseClients = new Map();

function getProjectSseClients(projectId) {
  if (!sseClients.has(projectId)) sseClients.set(projectId, new Map());
  return sseClients.get(projectId);
}

function getProjectSseConnectionCount(projectId) {
  return sseClients.get(projectId)?.size || 0;
}

function sseSubscribe(projectId, res, meta) {
  getProjectSseClients(projectId).set(res, meta);
}

function sseUnsubscribe(projectId, res) {
  const clients = sseClients.get(projectId);
  if (!clients) return;
  const meta = clients.get(res);
  if (meta?.heartbeat) clearInterval(meta.heartbeat);
  clients.delete(res);
  if (clients.size === 0) sseClients.delete(projectId);
}

function sseBroadcast(projectId, eventType, data) {
  const clients = sseClients.get(projectId);
  if (!clients || clients.size === 0) return;

  const payload = `event: ${eventType}
data: ${JSON.stringify(data)}

`;
  for (const [clientRes] of clients) {
    if (clientRes.destroyed || clientRes.writableEnded) {
      sseUnsubscribe(projectId, clientRes);
      continue;
    }
    try {
      clientRes.write(payload);
    } catch (err) {
      sseUnsubscribe(projectId, clientRes);
    }
  }
}

// ─── Rate Limiting (in-memory, no external deps) ─────────────────────────────
// Map<ip, Map<bucket, {count, resetAt}>>
// Buckets: 'logs' (60/min), 'spawn' (20/min), 'write' (120/min)
const _rateLimitStore = new Map();

function _getClient(ip) {
  if (!_rateLimitStore.has(ip)) _rateLimitStore.set(ip, new Map());
  return _rateLimitStore.get(ip);
}

function checkRateLimit(ip, bucket, maxPerMin) {
  const now = Date.now();
  const client = _getClient(ip);
  let entry = client.get(bucket);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + 60 * 1000 };
    client.set(bucket, entry);
  }
  entry.count++;
  if (entry.count > maxPerMin) {
    return { limited: true, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { limited: false };
}

// Clean up stale IP entries every 5 minutes to prevent unbounded growth
trackInterval(() => {
  const now = Date.now();
  for (const [ip, buckets] of _rateLimitStore) {
    for (const [bucket, entry] of buckets) {
      if (now >= entry.resetAt) buckets.delete(bucket);
    }
    if (buckets.size === 0) _rateLimitStore.delete(ip);
  }
}, 5 * 60 * 1000);

// Single write rate-limit middleware: selects bucket by path pattern
// - /api/tasks/:id/logs        → 60/min
// - /api/tasks/:id/claim       → 20/min
// - /api/tasks/claim-next      → 20/min
// - /api/tasks/:id/spawn       → 20/min
// - all other writes (POST/PUT/DELETE) → 120/min
const writeRateLimitMiddleware = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || '0.0.0.0';
  const p = req.path; // path relative to app root, e.g. /api/tasks/abc123/logs
  let bucket, limit;
  if (/^\/api\/tasks\/[^/]+\/logs$/.test(p)) {
    bucket = 'logs'; limit = 60;
  } else if (/^\/api\/tasks\/[^/]+\/claim$/.test(p) || /^\/api\/tasks\/claim-next$/.test(p) || /^\/api\/tasks\/[^/]+\/spawn$/.test(p)) {
    bucket = 'spawn'; limit = 20;
  } else {
    bucket = 'write'; limit = 120;
  }
  const result = checkRateLimit(ip, bucket, limit);
  if (result.limited) {
    res.set('Retry-After', String(result.retryAfter));
    return res.status(429).json({ error: 'Too many requests', retryAfter: result.retryAfter });
  }
  next();
};

// Apply to all write methods on /api/*
app.post('/api/*splat', writeRateLimitMiddleware);
app.put('/api/*splat', writeRateLimitMiddleware);
app.delete('/api/*splat', writeRateLimitMiddleware);

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

function getActorIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || null;
}

const insertAuditLogStmt = db.prepare(
  'INSERT INTO audit_log (id, timestamp, action, actorIp, targetId, details) VALUES (?, ?, ?, ?, ?, ?)'
);

function writeAuditLog(req, action, targetId, details = null) {
  try {
    insertAuditLogStmt.run(
      Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      new Date().toISOString(),
      action,
      getActorIp(req),
      targetId || null,
      details == null ? null : JSON.stringify(details)
    );
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

function fireWebhook(projectId, eventType, payload) {
  const hooks = db.prepare("SELECT * FROM webhooks WHERE projectId = ? AND (events = '[]' OR events LIKE ?)").all(projectId, `%"${eventType}"%`);
  for (const hook of hooks) {
    const body = JSON.stringify({ event: eventType, timestamp: new Date().toISOString(), ...payload });
    // Decrypt the stored secret before using it for HMAC signing
    const signingKey = decryptWebhookSecret(hook.secret);
    const sig = signingKey ? 'sha256=' + crypto.createHmac('sha256', signingKey).update(body).digest('hex') : null;
    try {
      const url = new URL(hook.url);
      // Only fire over https (skip any http hooks that may have been stored before this fix)
      if (url.protocol !== 'https:') continue;
      // Resolve and check for private IPs before firing
      dns.lookup(url.hostname, { all: true }, (err, addresses) => {
        if (err || !addresses || addresses.length === 0) return;
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
        const req = https.request(options);
        req.setTimeout(5000, () => req.destroy());
        req.on('error', () => {}); // fire-and-forget
        req.write(body);
        req.end();
      });
    } catch(e) { /* ignore bad URLs */ }
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

// GET /api/projects/:id/handoffs — project-scoped handoff log feed (paginated)
// Returns all handoff log entries for tasks in the given project, newest first.
// Query params: ?limit=50&offset=0
// Response: { total, limit, offset, items: [{ taskId, taskTitle, agentId, timestamp, message }, ...] }
app.get('/api/projects/:id/handoffs', (req, res) => {
  try {
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // Fetch all tasks in this project that have handoff logs
    const rows = db.prepare(
      "SELECT id, title, handoffLog FROM tasks WHERE projectId = ? AND handoffLog IS NOT NULL AND handoffLog != '[]'"
    ).all(req.params.id);

    // Flatten all handoff entries with task context, then sort by timestamp descending
    const allEntries = [];
    for (const row of rows) {
      let log;
      try { log = JSON.parse(row.handoffLog); } catch { continue; }
      if (!Array.isArray(log)) continue;
      for (const entry of log) {
        allEntries.push({
          taskId: row.id,
          taskTitle: row.title,
          agentId: entry.agentId || entry.agentSessionId || 'unknown',
          timestamp: entry.timestamp || null,
          message: entry.message || entry.note || '',
        });
      }
    }

    // Sort newest first
    allEntries.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    const total = allEntries.length;
    const items = allEntries.slice(offset, offset + limit);

    res.json({ total, limit, offset, items });
  } catch (err) {
    console.error('GET /api/projects/:id/handoffs error:', err);
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
  const newProjDefaultDesc = getDefaultAgentTemplateDescription();
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
    if (req.body.agentConfig !== undefined && req.body.agentConfig !== null && typeof req.body.agentConfig !== 'object') {
      return res.status(400).json({ error: 'agentConfig must be an object or null' });
    }
    if (req.body.agentConfig && req.body.agentConfig.model !== undefined && getValidatedAgentModel(req.body.agentConfig) === null) {
      return res.status(400).json({ error: 'agentConfig.model must match /^[a-zA-Z0-9\\/_.-]+$/' });
    }
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

// GET /api/audit-log — list security-sensitive operations (read-only)
app.get('/api/audit-log', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const action = typeof req.query.action === 'string' && req.query.action.trim() ? req.query.action.trim() : null;

    let rows;
    if (action) {
      rows = db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(action, limit, offset);
    } else {
      rows = db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
    }

    res.json(rows.map((row) => ({
      ...row,
      details: row.details ? (() => {
        try { return JSON.parse(row.details); } catch { return row.details; }
      })() : null,
    })));
  } catch (err) {
    console.error('GET /api/audit-log error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/projects/:id — delete project and cascade tasks
app.delete('/api/projects/:id', (req, res) => {
  try {
    if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default project' });
    const projectId = req.params.id;
    const existingProject = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    let deletedTaskCount = 0;
    let deletedWebhookCount = 0;
    let deletedTemplateCount = 0;
    const deleteProject = db.transaction(() => {
      // Get all task IDs for this project (needed for child-table cleanup)
      const taskIds = db.prepare("SELECT id FROM tasks WHERE projectId = ?").all(projectId).map(t => t.id);
      deletedTaskCount = taskIds.length;
      deletedWebhookCount = db.prepare('SELECT COUNT(*) AS cnt FROM webhooks WHERE projectId = ?').get(projectId).cnt;
      deletedTemplateCount = db.prepare('SELECT COUNT(*) AS cnt FROM templates WHERE projectId = ?').get(projectId).cnt;
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
    writeAuditLog(req, 'project.delete', projectId, {
      projectName: existingProject?.name || null,
      deletedTaskCount,
      deletedWebhookCount,
      deletedTemplateCount,
    });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Export / Import ─────────────────────────────────────────────────────────

// GET /api/projects/:id/export?format=json|csv
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
        })),
      };
      res.setHeader('Content-Disposition', `attachment; filename="project-${req.params.id}-export.json"`);
      res.setHeader('Content-Type', 'application/json');
      return res.json(snapshot);
    }
    if (format === 'csv') {
      const CSV_FIELDS = ['id', 'title', 'description', 'assignee', 'priority', 'tags', 'column', 'createdAt', 'dueDate', 'recurring', 'projectId', 'wave'];
      const escapeCsv = (val) => {
        if (val === null || val === undefined) return '';
        const str = String(val).replace(/"/g, '""');
        return /[,"\n\r]/.test(str) ? `"${str}"` : str;
      };
      const header = CSV_FIELDS.join(',');
      const rows = tasks.map(t => CSV_FIELDS.map(f => {
        if (f === 'tags') return escapeCsv(JSON.parse(t.tags || '[]').join(';'));
        return escapeCsv(t[f]);
      }).join(','));
      const csv = [header, ...rows].join('\n');
      res.setHeader('Content-Disposition', `attachment; filename="project-${req.params.id}-export.csv"`);
      res.setHeader('Content-Type', 'text/csv');
      return res.send(csv);
    }
    return res.status(400).json({ error: 'Invalid format. Use: json or csv' });
  } catch (err) {
    console.error('GET /api/projects/:id/export error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/projects/:id/import
// Body: { tasks: [...] } or bare array
// Sanitizes string fields to strip HTML tags before inserting into DB.
app.post('/api/projects/:id/import', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Request body must be a JSON object' });
    }

    let taskList = null;
    if (Array.isArray(incoming)) {
      taskList = incoming;
    } else if (Array.isArray(incoming.tasks)) {
      taskList = incoming.tasks;
    } else {
      return res.status(400).json({ error: 'Body must be { tasks: [...] } or a task array' });
    }

    if (taskList.length === 0) return res.status(400).json({ error: 'tasks array is empty' });
    if (taskList.length > 500) return res.status(400).json({ error: 'Cannot import more than 500 tasks at once' });

    const IMPORT_ALLOWED_COLUMNS = new Set(['idea', 'backlog', 'in-progress', 'in-review', 'done']);
    const IMPORT_ALLOWED_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low']);

    // Strip HTML tags from string fields to prevent stored XSS via imported data
    const stripHtml = (str) => String(str || '').replace(/<[^>]*>/g, '');

    const importTasks = db.transaction(() => {
      const imported = [];
      let skipped = 0;
      const now = new Date().toISOString();

      for (const raw of taskList) {
        if (!raw || typeof raw !== 'object') { skipped++; continue; }
        const title = stripHtml((raw.title || '').trim());
        if (!title) { skipped++; continue; }

        const col = IMPORT_ALLOWED_COLUMNS.has(raw.column) ? raw.column : 'backlog';
        const pri = IMPORT_ALLOWED_PRIORITIES.has(raw.priority) ? raw.priority : 'medium';
        const rawTags = Array.isArray(raw.tags) ? raw.tags : (typeof raw.tags === 'string' ? raw.tags.split(';').map(t => t.trim()).filter(Boolean) : []);
        const tags = rawTags.map(t => stripHtml(String(t)));
        const blockedBy = Array.isArray(raw.blockedBy) ? raw.blockedBy : [];
        const wave = Number.isInteger(raw.wave) && raw.wave >= 0 ? raw.wave : null;
        const dueDate = raw.dueDate ? String(raw.dueDate).slice(0, 10) : null;
        const subtasks = raw.subtasks ? JSON.stringify(raw.subtasks) : null;

        const id = crypto.randomBytes(12).toString('base64url');
        db.prepare(
          'INSERT INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, dueDate, recurring, subtasks, projectId, wave, blockedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(
          id,
          title,
          stripHtml(raw.description || ''),
          stripHtml(raw.assignee || 'Mike'),
          pri,
          JSON.stringify(tags),
          col,
          now,
          dueDate,
          raw.recurring ? stripHtml(raw.recurring) : null,
          subtasks,
          req.params.id,
          wave,
          JSON.stringify(blockedBy)
        );

        const actId = crypto.randomBytes(12).toString('base64url');
        db.prepare(
          'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(actId, id, 'created', `Card imported into ${COL_LABELS[col] || col}`, stripHtml(raw.assignee || 'Mike'), now);

        imported.push(id);
      }
      return { imported, skipped };
    });

    const result = importTasks();
    res.status(201).json({ imported: result.imported.length, skipped: result.skipped, taskIds: result.imported });
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
    res.json(rows.map(r => ({
      ...r,
      defaultDescription: resolveTemplatePlaceholders(r.defaultDescription),
      defaultTags: JSON.parse(r.defaultTags)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

function buildTemplatePayload(body = {}, existing = {}) {
  const defaultPriority = body.defaultPriority !== undefined
    ? body.defaultPriority
    : (existing.defaultPriority || 'medium');

  if (!VALID_PRIORITIES.includes(defaultPriority)) {
    return { error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` };
  }

  let defaultTags = body.defaultTags !== undefined
    ? body.defaultTags
    : (existing.defaultTags || []);

  if (typeof defaultTags === 'string') {
    try {
      defaultTags = JSON.parse(defaultTags);
    } catch {
      defaultTags = defaultTags.split(',').map(tag => tag.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(defaultTags)) {
    return { error: 'defaultTags must be an array of strings' };
  }

  return {
    name: body.name !== undefined ? String(body.name).trim() || 'New Template' : (existing.name || 'New Template'),
    defaultDescription: body.defaultDescription !== undefined ? String(body.defaultDescription) : (existing.defaultDescription || ''),
    defaultTags: defaultTags.map(tag => String(tag).trim()).filter(Boolean),
    defaultAssignee: body.defaultAssignee !== undefined ? String(body.defaultAssignee).trim() || 'Mike' : (existing.defaultAssignee || 'Mike'),
    defaultPriority,
  };
}

// POST /api/templates
app.post('/api/templates', (req, res) => {
  try {
    const payload = buildTemplatePayload(req.body);
    if (payload.error) return res.status(400).json({ error: payload.error });

    const tmpl = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      projectId: req.body.projectId || 'default',
      ...payload,
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

// PUT /api/templates/:id
app.put('/api/templates/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const payload = buildTemplatePayload(req.body, {
      ...existing,
      defaultTags: JSON.parse(existing.defaultTags || '[]'),
    });
    if (payload.error) return res.status(400).json({ error: payload.error });

    db.prepare(
      'UPDATE templates SET name = ?, defaultDescription = ?, defaultTags = ?, defaultAssignee = ?, defaultPriority = ? WHERE id = ?'
    ).run(payload.name, payload.defaultDescription, JSON.stringify(payload.defaultTags), payload.defaultAssignee, payload.defaultPriority, req.params.id);

    res.json({
      id: existing.id,
      projectId: existing.projectId,
      createdAt: existing.createdAt,
      ...payload,
    });
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
// Supports pagination via ?limit=200&offset=0 query params.
// Returns { total, limit, offset, items: [...] } when limit is specified,
// or a plain array for backward compatibility when limit is omitted.
app.get('/api/tasks', (req, res) => {
  try {
    const projectId = req.query.projectId || 'default';
    const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 200));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    // Lock expiry is handled by background cleanup (see setInterval below) — no UPDATE here

    // ?tag=<value> — filter in JS after fetch (safe: avoids SQL LIKE injection / ReDoS).
    // Tags are stored as JSON arrays; use exact Array.includes() match.
    const filterTag = req.query.tag !== undefined ? req.query.tag : null;

    let rows;
    let total;
    if (filterTag !== null) {
      // Tag filter requires in-JS processing; paginate after filtering.
      const allRows = db.prepare("SELECT * FROM tasks WHERE projectId = ?").all(projectId);
      const filteredRows = allRows.filter(row => {
        try {
          return JSON.parse(row.tags || '[]').includes(filterTag);
        } catch {
          return false;
        }
      });
      total = filteredRows.length;
      rows = filteredRows.slice(offset, offset + limit);
    } else {
      total = db.prepare("SELECT COUNT(*) AS cnt FROM tasks WHERE projectId = ?").get(projectId).cnt;
      rows = db.prepare("SELECT * FROM tasks WHERE projectId = ? LIMIT ? OFFSET ?").all(projectId, limit, offset);
    }

    // Compute blocked status against the full project's done set, not just this page.
    const doneIds = new Set(
      db.prepare("SELECT id FROM tasks WHERE projectId = ? AND \"column\" = 'done'").all(projectId).map(r => r.id)
    );

    const items = rows.map(row => ({
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
    }));

    res.json({ total, limit, offset, items });
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

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.projectId || 'default');
    const now = new Date().toISOString();
    const expiresAt = getTaskLockExpiryIso(project);

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

// POST /api/tasks/:id/complete — atomically move to done, release lock, and optionally append handoff note
app.post('/api/tasks/:id/complete', (req, res) => {
  try {
    const agentSessionId = typeof req.body.agentSessionId === 'string' ? req.body.agentSessionId.trim() : '';
    const handoffMessage = typeof req.body.message === 'string' ? req.body.message.trim() : '';

    if (!agentSessionId) {
      return res.status(400).json({ error: 'agentSessionId is required and must be a non-empty string' });
    }

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    if (existing.lockedBy !== agentSessionId) {
      return res.status(403).json({ error: 'Not the lock owner' });
    }

    const updated = {
      ...existing,
      tags: JSON.parse(existing.tags || '[]'),
      subtasks: existing.subtasks ? JSON.parse(existing.subtasks) : null,
      blockedBy: existing.blockedBy ? JSON.parse(existing.blockedBy) : [],
      column: 'done',
      lockedBy: null,
      lockedAt: null,
      lockExpiresAt: null,
    };

    let promotedWaveTasks = [];
    let wavePromotionInfo = null;
    let unblockedTasks = [];

    const completeTask = db.transaction(() => {
      db.prepare('UPDATE tasks SET "column" = ?, lockedBy = NULL, lockedAt = NULL, lockExpiresAt = NULL WHERE id = ?')
        .run('done', existing.id);

      if (handoffMessage) {
        const log = existing.handoffLog ? JSON.parse(existing.handoffLog) : [];
        log.push({
          agentId: agentSessionId,
          timestamp: new Date().toISOString(),
          message: handoffMessage,
        });
        db.prepare('UPDATE tasks SET handoffLog = ? WHERE id = ?').run(JSON.stringify(log), existing.id);
      }

      const now = new Date().toISOString();
      const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      db.prepare(
        'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(actId, existing.id, 'move', `Moved from ${COL_LABELS[existing.column] || existing.column} → ${COL_LABELS.done}`, 'System', now);

      db.prepare(
        'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(existing.id, existing.title, existing.column, 'done', existing.assignee || 'System', now, existing.projectId || 'default');

      if (existing.recurring) {
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

      if (existing.wave != null) {
        const projectId = existing.projectId || 'default';
        const waveTasks = db.prepare('SELECT id, "column" FROM tasks WHERE projectId = ? AND wave = ?').all(projectId, existing.wave);
        const allDone = waveTasks.every(t => t.id === existing.id ? true : t.column === 'done');
        if (allDone) {
          const nextWaveTasks = db.prepare('SELECT id FROM tasks WHERE projectId = ? AND wave = ? AND "column" = \'idea\'').all(projectId, existing.wave + 1);
          if (nextWaveTasks.length > 0) {
            const promoteStmt = db.prepare('UPDATE tasks SET "column" = \'backlog\' WHERE id = ?');
            for (const t of nextWaveTasks) promoteStmt.run(t.id);
            promotedWaveTasks = nextWaveTasks;
          }
          wavePromotionInfo = { wave: existing.wave, nextWave: existing.wave + 1, promotedCount: nextWaveTasks.length, projectId };
        }
      }

      const unblocked = db.prepare('SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?').all(existing.id);
      for (const dep of unblocked) {
        const blockedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(dep.blocked_id);
        if (blockedTask) {
          const remainingBlockers = db.prepare("SELECT td.blocker_id FROM task_dependencies td INNER JOIN tasks t ON t.id = td.blocker_id WHERE td.blocked_id = ? AND t.column != 'done'").all(dep.blocked_id);
          if (remainingBlockers.length === 0) {
            unblockedTasks.push({ taskId: dep.blocked_id, task: blockedTask });
          }
        }
      }
    });

    completeTask();

    const finalTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(existing.id);
    const responseTask = {
      ...finalTask,
      tags: JSON.parse(finalTask.tags || '[]'),
      subtasks: finalTask.subtasks ? JSON.parse(finalTask.subtasks) : null,
      blockedBy: finalTask.blockedBy ? JSON.parse(finalTask.blockedBy) : [],
      handoffLog: finalTask.handoffLog ? JSON.parse(finalTask.handoffLog) : [],
    };

    sseBroadcast(responseTask.projectId || 'default', 'task.updated', { task: responseTask });
    fireWebhook(responseTask.projectId || 'default', 'task.updated', { task: { ...responseTask, tags: JSON.stringify(responseTask.tags) } });
    if (wavePromotionInfo) {
      fireWebhook(wavePromotionInfo.projectId, 'layer.unlocked', wavePromotionInfo);
    }
    for (const u of unblockedTasks) {
      fireWebhook(u.task.projectId || 'default', 'task.unblocked', { taskId: u.taskId, task: u.task });
    }

    res.json(responseTask);
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

    // Validate blockedBy IDs exist and belong to the same project before inserting
    const taskProjectId = req.body.projectId || 'default';
    for (const blockerId of blockedByArr) {
      const blockerRow = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(blockerId);
      if (!blockerRow) {
        return res.status(400).json({ error: `Blocker task ${blockerId} does not exist` });
      }
      if (blockerRow.projectId !== taskProjectId) {
        return res.status(400).json({ error: `Blocker task ${blockerId} belongs to a different project and cannot block this task` });
      }
    }

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

    // Sync blockedBy to task_dependencies (already validated above)
    for (const blockerId of blockedByArr) {
      db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, task.id);
    }

    // Log card creation
    const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    db.prepare(
      'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(actId, task.id, 'created', `Card created in ${COL_LABELS[task.column] || task.column}`, task.assignee, task.createdAt);

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

  // Validate blockedBy IDs exist and belong to the same project
  if (req.body.blockedBy !== undefined) {
    const taskProjectId = updated.projectId || existing.projectId || 'default';
    for (const blockerId of updated.blockedBy) {
      const blockerRow = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(blockerId);
      if (!blockerRow) {
        return res.status(400).json({ error: `Blocker task ${blockerId} does not exist` });
      }
      if (blockerRow.projectId !== taskProjectId) {
        return res.status(400).json({ error: `Blocker task ${blockerId} belongs to a different project and cannot block this task` });
      }
    }
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
        'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(existing.id, existing.title, existing.column, req.body.column, updated.assignee || 'System', now, updated.projectId || existing.projectId || 'default');

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

  // Fire external side effects outside the transaction.
  sseBroadcast(updated.projectId || 'default', 'task.updated', { task: updated });
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

// PATCH /api/tasks/:id — partial update (only supplied fields)
app.patch('/api/tasks/:id', (req, res) => {
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

    const ALLOWED_PATCH_FIELDS = ['title', 'description', 'assignee', 'priority', 'column', 'tags', 'dueDate', 'recurring', 'subtasks', 'wave', 'blockedBy', 'sortOrder'];

    // Collect only the fields the caller actually sent
    const patches = {};
    for (const field of ALLOWED_PATCH_FIELDS) {
      if (req.body[field] !== undefined) patches[field] = req.body[field];
    }

    if (Object.keys(patches).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Validate blockedBy IDs if provided
    if (patches.blockedBy !== undefined) {
      patches.blockedBy = Array.isArray(patches.blockedBy) ? patches.blockedBy : [];
      const taskProjectId = patches.projectId || existing.projectId || 'default';
      for (const blockerId of patches.blockedBy) {
        const blockerRow = db.prepare('SELECT id, projectId FROM tasks WHERE id = ?').get(blockerId);
        if (!blockerRow) {
          return res.status(400).json({ error: `Blocker task ${blockerId} does not exist` });
        }
        if (blockerRow.projectId !== taskProjectId) {
          return res.status(400).json({ error: `Blocker task ${blockerId} belongs to a different project and cannot block this task` });
        }
      }
    }

    // Build dynamic UPDATE — only touch supplied columns
    const setClauses = [];
    const params = [];

    for (const [field, value] of Object.entries(patches)) {
      if (field === 'tags') {
        setClauses.push('tags = ?');
        params.push(JSON.stringify(Array.isArray(value) ? value : []));
      } else if (field === 'subtasks') {
        setClauses.push('subtasks = ?');
        params.push(value ? JSON.stringify(value) : null);
      } else if (field === 'blockedBy') {
        setClauses.push('blockedBy = ?');
        params.push(JSON.stringify(value));
      } else if (field === 'column') {
        setClauses.push('"column" = ?');
        params.push(value);
      } else {
        setClauses.push(`${field} = ?`);
        params.push(value ?? null);
      }
    }

    params.push(req.params.id);

    // Track side-effect data for after the transaction
    let promotedWaveTasks = [];
    let wavePromotionInfo = null;
    let unblockedTasks = [];

    const patchTask = db.transaction(() => {
      db.prepare(`UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);

      // Sync blockedBy to task_dependencies if changed
      if (patches.blockedBy !== undefined) {
        db.prepare('DELETE FROM task_dependencies WHERE blocked_id = ?').run(existing.id);
        for (const blockerId of patches.blockedBy) {
          if (blockerId !== existing.id) {
            db.prepare('INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id) VALUES (?, ?)').run(blockerId, existing.id);
          }
        }
      }

      // Auto-log column changes
      if (patches.column && patches.column !== existing.column) {
        const now = new Date().toISOString();
        const actId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
        db.prepare(
          'INSERT INTO card_activity (id, taskId, type, content, author, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(actId, existing.id, 'move', `Moved from ${COL_LABELS[existing.column] || existing.column} → ${COL_LABELS[patches.column] || patches.column}`, 'System', now);
        db.prepare(
          'INSERT INTO notifications (task_id, task_title, from_col, to_col, changed_by, created_at, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(existing.id, existing.title, existing.column, patches.column, patches.assignee || existing.assignee || 'System', now, existing.projectId || 'default');

        // Recurring task: auto-create new card when moved to done
        if (patches.column === 'done' && existing.recurring) {
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

        // Wave auto-promotion
        const effectiveWave = patches.wave !== undefined ? patches.wave : existing.wave;
        if (patches.column === 'done' && effectiveWave != null) {
          const projectId = existing.projectId || 'default';
          const waveN = effectiveWave;
          const waveTasks = db.prepare("SELECT id, \"column\" FROM tasks WHERE projectId = ? AND wave = ?").all(projectId, waveN);
          const allDone = waveTasks.every(t => t.id === existing.id ? true : t.column === 'done');
          if (allDone) {
            const nextWaveTasks = db.prepare("SELECT id FROM tasks WHERE projectId = ? AND wave = ? AND \"column\" = 'idea'").all(projectId, waveN + 1);
            if (nextWaveTasks.length > 0) {
              const promoteStmt = db.prepare("UPDATE tasks SET \"column\" = 'backlog' WHERE id = ?");
              for (const t of nextWaveTasks) promoteStmt.run(t.id);
              promotedWaveTasks = nextWaveTasks;
            }
            wavePromotionInfo = { wave: waveN, nextWave: waveN + 1, promotedCount: nextWaveTasks ? nextWaveTasks.length : 0, projectId };
          }
        }

        // Collect unblocked tasks
        if (patches.column === 'done') {
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
    patchTask();

    // Re-read the updated task to return it
    const result = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    const response = {
      ...result,
      tags: JSON.parse(result.tags),
      subtasks: result.subtasks ? JSON.parse(result.subtasks) : null,
      blockedBy: result.blockedBy ? JSON.parse(result.blockedBy) : [],
    };

    // Fire external side effects outside the transaction
    sseBroadcast(existing.projectId || 'default', 'task.updated', { task: response });
    if (patches.column && patches.column !== existing.column) {
      fireWebhook(existing.projectId || 'default', 'task.updated', { task: { ...response, tags: JSON.stringify(response.tags) } });
      if (wavePromotionInfo) {
        fireWebhook(wavePromotionInfo.projectId, 'layer.unlocked', wavePromotionInfo);
      }
      for (const u of unblockedTasks) {
        fireWebhook(u.task.projectId || 'default', 'task.unblocked', { taskId: u.taskId, task: u.task });
      }
    }

    res.json(response);
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
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(task.projectId || 'default');
    const agentConfig = parseProjectAgentConfig(project);
    const validatedAgentModel = getValidatedAgentModel(agentConfig);

    if (agentConfig.model && !validatedAgentModel) {
      return res.status(400).json({ error: 'Invalid project agent model configuration' });
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
    const safeTaskDescription = truncateSpawnTaskDescription(task.description);
    const taskDetails = [
      `# Task: ${task.title}`,
      safeTaskDescription ? `\n## Description\n${safeTaskDescription}` : '',
      `\n## Card ID\n${task.id}`,
      `\n## Project\n${task.projectId || 'default'}`,
      `\n## Priority\n${task.priority}`,
      task.tags ? `\n## Tags\n${JSON.parse(task.tags || '[]').join(', ')}` : '',
    ].join('');

    const taskPrompt = resolveTemplatePlaceholders(`Read ${DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN} first.\n\n${taskDetails}`);

    // Spawn via openclaw agent CLI as a detached background process.
    // The gateway uses WebSocket RPC (not HTTP REST) for session spawning, so we
    // invoke the CLI directly. We fire-and-forget and return a session key immediately.
    const os = require('os');
    const sessionKey = generateAgentSessionId();

    // Spawn openclaw agent as a detached background process (fire-and-forget)
    const { spawn } = require('child_process');
    const agentArgs = [
      'agent',
      '--session-id', sessionKey,
      '--message', taskPrompt,
    ];
    if (validatedAgentModel) agentArgs.push('--agent', validatedAgentModel);

    const env = { ...process.env, HOME: require('os').homedir() };
    if (authToken) env.OPENCLAW_TOKEN = authToken;

    const child = spawn('/opt/homebrew/bin/openclaw', agentArgs, {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();

    // Track the spawned process in the in-memory registry
    agentProcesses.set(task.id, {
      pid: child.pid,
      sessionKey,
      startTime: now.toISOString(),
    });

    // Clean up registry entry when process exits
    child.on('exit', () => {
      const entry = agentProcesses.get(task.id);
      if (entry && entry.pid === child.pid) {
        agentProcesses.delete(task.id);
      }
    });

    // Lock the card and store agent session ID
    const expiresAt = getTaskLockExpiryIso(project);
    const nowIso = now.toISOString();
    db.prepare('UPDATE tasks SET lockedBy = ?, lockedAt = ?, lockExpiresAt = ?, agentSessionId = ?, agentStartedAt = ?, "column" = ? WHERE id = ?')
      .run(sessionKey, nowIso, expiresAt, sessionKey, nowIso, 'in-progress', task.id);

    writeAuditLog(req, 'task.spawn', task.id, {
      projectId: task.projectId || 'default',
      sessionKey,
      title: task.title,
      model: validatedAgentModel || null,
    });

    res.json({ sessionKey, sessionId: sessionKey, taskId: task.id, status: 'spawned' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/tasks/:id/agent-process — check if a spawned agent process is alive
app.get('/api/tasks/:id/agent-process', (req, res) => {
  try {
    const task = db.prepare('SELECT id, lockedBy, lockExpiresAt, agentSessionId, agentStartedAt FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const entry = agentProcesses.get(task.id);
    if (!entry) {
      return res.json({
        taskId: task.id,
        tracked: false,
        alive: false,
        lockedBy: task.lockedBy || null,
        lockExpiresAt: task.lockExpiresAt || null,
        agentSessionId: task.agentSessionId || null,
        agentStartedAt: task.agentStartedAt || null,
      });
    }

    // Check if process is still alive
    let alive = false;
    try {
      process.kill(entry.pid, 0); // signal 0 = test existence
      alive = true;
    } catch (e) {
      // Process not found — clean up registry
      agentProcesses.delete(task.id);
    }

    res.json({
      taskId: task.id,
      tracked: true,
      alive,
      pid: entry.pid,
      sessionKey: entry.sessionKey,
      startTime: entry.startTime,
      lockedBy: task.lockedBy || null,
      lockExpiresAt: task.lockExpiresAt || null,
      agentSessionId: task.agentSessionId || null,
      agentStartedAt: task.agentStartedAt || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/tasks/:id/agent-process — kill a spawned agent process and release the lock
app.delete('/api/tasks/:id/agent-process', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const entry = agentProcesses.get(task.id);
    if (!entry) {
      return res.status(404).json({ error: 'No tracked agent process for this task' });
    }

    // Kill the process
    let killed = false;
    try {
      process.kill(entry.pid, 'SIGTERM');
      killed = true;
    } catch (e) {
      // Already dead — that's fine
    }

    // Remove from registry
    agentProcesses.delete(task.id);

    // Release the lock on the card
    db.prepare('UPDATE tasks SET lockedBy = NULL, lockedAt = NULL, lockExpiresAt = NULL WHERE id = ?')
      .run(task.id);

    writeAuditLog(req, 'task.agent-process.kill', task.id, {
      pid: entry.pid,
      sessionKey: entry.sessionKey,
      killed,
    });

    res.json({
      taskId: task.id,
      pid: entry.pid,
      killed,
      lockReleased: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/tasks/:id/handoff — get handoff log entries for a task (paginated)
// Query params: ?limit=100&offset=0 (default limit 100, max 500)
app.get('/api/tasks/:id/handoff', (req, res) => {
  try {
    const task = db.prepare('SELECT handoffLog FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const log = task.handoffLog ? JSON.parse(task.handoffLog) : [];
    const total = log.length;
    const items = log.slice(offset, offset + limit);
    res.json({ total, limit, offset, items });
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
    const task = db.prepare('SELECT id, lockedBy, lockExpiresAt FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Not found' });

    const agentSessionId = typeof req.body.agentSessionId === 'string' && req.body.agentSessionId.trim()
      ? req.body.agentSessionId.trim()
      : null;
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    const now = new Date();
    const hasActiveLock = Boolean(task.lockedBy && task.lockExpiresAt && new Date(task.lockExpiresAt) > now);

    if (!message) return res.status(400).json({ error: 'message required' });
    if (Buffer.byteLength(message, 'utf8') > MAX_AGENT_LOG_MESSAGE_BYTES) {
      return res.status(413).json({ error: 'message too large', maxBytes: MAX_AGENT_LOG_MESSAGE_BYTES });
    }
    if (hasActiveLock && agentSessionId !== task.lockedBy) {
      return res.status(403).json({ error: 'Only the lock owner can append logs while a task is locked' });
    }

    const entry = {
      taskId: req.params.id,
      agentSessionId,
      level: ['info', 'warn', 'error'].includes(req.body.level) ? req.body.level : 'info',
      message,
      timestamp: now.toISOString(),
    };

    const result = db.prepare(
      'INSERT INTO agent_logs (taskId, agentSessionId, level, message, timestamp) VALUES (?, ?, ?, ?, ?)'
    ).run(entry.taskId, entry.agentSessionId, entry.level, entry.message, entry.timestamp);

    const logEntry = { id: result.lastInsertRowid, ...entry };
    const taskRow = db.prepare('SELECT projectId FROM tasks WHERE id = ?').get(req.params.id);
    sseBroadcast(taskRow?.projectId || 'default', 'log.created', { log: logEntry });

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

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT id, title, projectId, assignee, priority, "column" FROM tasks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    writeAuditLog(req, 'task.delete', req.params.id, {
      projectId: existing.projectId || 'default',
      title: existing.title,
      assignee: existing.assignee,
      priority: existing.priority,
      column: existing.column,
    });
    sseBroadcast(existing.projectId || 'default', 'task.deleted', { taskId: req.params.id });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/tasks/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get activity/comments for a task (paginated)
// Query params: ?limit=100&offset=0 (default limit 100, max 500)
app.get('/api/tasks/:id/activity', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const countRow = db.prepare('SELECT COUNT(*) as count FROM card_activity WHERE taskId = ?').get(req.params.id);
    const total = countRow ? countRow.count : 0;
    const items = db.prepare('SELECT * FROM card_activity WHERE taskId = ? ORDER BY createdAt ASC LIMIT ? OFFSET ?').all(req.params.id, limit, offset);
    res.json({ total, limit, offset, items });
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
// Query params: ?projectId= (filter by project), ?limit= (default 50, max 200), ?offset= (default 0)
app.get('/api/notifications', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const { projectId } = req.query;
    let rows, total;
    if (projectId) {
      rows = db.prepare(
        'SELECT * FROM notifications WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(projectId, limit, offset);
      total = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE project_id = ?').get(projectId).count;
    } else {
      rows = db.prepare(
        'SELECT * FROM notifications ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset);
      total = db.prepare('SELECT COUNT(*) as count FROM notifications').get().count;
    }
    res.json({ total, limit, offset, items: rows });
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

// ─── Server-Sent Events ───────────────────────────────────────────────────────
// GET /api/events?projectId=X
// Streams task.created, task.updated, task.deleted, and log.created events.
app.get('/api/events', (req, res) => {
  const projectId = req.query.projectId || 'default';

  if (getProjectSseConnectionCount(projectId) >= MAX_PROJECT_SSE_CONNECTIONS) {
    return res.status(503).json({
      error: 'Too many SSE connections for project',
      projectId,
      limit: MAX_PROJECT_SSE_CONNECTIONS,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  const closeConnection = () => {
    if (closed) return;
    closed = true;
    sseUnsubscribe(projectId, res);
  };

  const heartbeat = setInterval(() => {
    if (res.destroyed || res.writableEnded) {
      closeConnection();
      return;
    }
    try {
      res.write(': heartbeat\n\n');
    } catch (err) {
      closeConnection();
    }
  }, 25000);

  sseSubscribe(projectId, res, { heartbeat });

  res.on('close', closeConnection);
  res.on('error', closeConnection);
  res.on('finish', closeConnection);

  try {
    res.write(`event: connected\ndata: ${JSON.stringify({ projectId, ts: new Date().toISOString() })}\n\n`);
  } catch (err) {
    closeConnection();
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
    writeAuditLog(req, 'webhook.create', hook.id, {
      projectId: hook.projectId,
      url: hook.url,
      events: hook.events,
      secretGenerated: !req.body.secret,
    });
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
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const requestedProjectId = req.query.projectId || 'default';
    if (row.projectId !== requestedProjectId) {
      return res.status(404).json({ error: 'Not found' });
    }

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
    writeAuditLog(req, 'webhook.rotate-secret', req.params.id, {
      projectId: row.projectId,
      url: row.url,
      events: JSON.parse(row.events || '[]'),
    });
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

// ─── Startup: seed default 'agent-task' template for projects that have none ──
(function seedDefaultTemplates() {
  const DEFAULT_DESCRIPTION = getDefaultAgentTemplateDescription();
  const legacySubagentsPath = '/Users/mike/.openclaw/workspace/SUBAGENTS.md';
  const legacyAgentPhone = '+18183121807';
  db.prepare(
    `UPDATE templates
     SET defaultDescription = replace(
       replace(defaultDescription, ?, ?),
       ?, ?
     )
     WHERE defaultDescription LIKE '%' || ? || '%'
        OR defaultDescription LIKE '%' || ? || '%'`
  ).run(
    legacySubagentsPath,
    DEFAULT_TEMPLATE_SUBAGENTS_PATH_TOKEN,
    legacyAgentPhone,
    DEFAULT_TEMPLATE_AGENT_PHONE_TOKEN,
    legacySubagentsPath,
    legacyAgentPhone
  );

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
trackInterval(() => {
  expireStaleLocksStmt.run();
}, 60000);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Kanban board running at http://127.0.0.1:${PORT}`);
});

server.on('connection', (socket) => {
  openSockets.add(socket);
  socket.on('close', () => openSockets.delete(socket));
});

async function gracefulShutdown(signal) {
  if (shutdownPromise) return shutdownPromise;

  isShuttingDown = true;
  shutdownPromise = (async () => {
    console.log(`[kanban] Received ${signal}, starting graceful shutdown...`);

    for (const handle of intervalHandles) {
      clearInterval(handle);
    }
    intervalHandles.clear();

    await new Promise((resolve) => {
      server.close((err) => {
        if (err) {
          console.error('[kanban] Error while closing HTTP server:', err);
        }
        resolve();
      });

      for (const socket of openSockets) {
        socket.end();
      }

      if (typeof server.closeIdleConnections === 'function') {
        server.closeIdleConnections();
      }
    });

    await waitForActiveRequestsToDrain(10000);

    for (const socket of openSockets) {
      socket.destroy();
    }

    try {
      db.close();
      console.log('[kanban] SQLite connection closed.');
      process.exit(0);
    } catch (err) {
      console.error('[kanban] Error while closing SQLite connection:', err);
      process.exit(1);
    }
  })();

  return shutdownPromise;
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM').catch((err) => {
    console.error('[kanban] Graceful shutdown failed:', err);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT').catch((err) => {
    console.error('[kanban] Graceful shutdown failed:', err);
    process.exit(1);
  });
});
