const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'kanban.db');
const TASKS_JSON = path.join(__dirname, 'tasks.json');

// Open the database — wrap in try/catch so permission errors and corruption
// produce a clear diagnostic instead of a raw stack trace.
let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  console.error(`[kanban] FATAL: could not open database at ${DB_PATH}`);
  console.error(`[kanban] Reason: ${err.message}`);
  console.error('[kanban] Check file permissions, disk space, or restore from kanban.db.bak');
  process.exit(1);
}

db.pragma('journal_mode = WAL');

// Integrity check — warn if the database is corrupt but don't hard-exit;
// the server can still serve stale data while the operator decides what to do.
try {
  const results = db.pragma('integrity_check');
  const ok = results.length === 1 && results[0].integrity_check === 'ok';
  if (!ok) {
    console.warn('[kanban] WARNING: PRAGMA integrity_check returned problems:');
    results.forEach(r => console.warn('  ', r.integrity_check));
    console.warn('[kanban] Consider restoring from kanban.db.bak and restarting.');
  }
} catch (err) {
  console.warn(`[kanban] WARNING: could not run integrity_check: ${err.message}`);
}

// Projects table
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6c5ce7',
    emoji TEXT DEFAULT '📋',
    createdAt TEXT NOT NULL
  )
`);

// Valid column values: 'idea', 'backlog', 'in-progress', 'in-review', 'done'
// NOTE: 'idea' is a pre-backlog stage for tasks still being refined.
// The ClawDawg cron task worker must NEVER pick up tasks in the 'idea' column;
// only tasks in 'backlog' are eligible for automated processing.
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    assignee TEXT DEFAULT 'Mike',
    priority TEXT DEFAULT 'medium',
    tags TEXT DEFAULT '[]',
    "column" TEXT DEFAULT 'backlog',
    createdAt TEXT NOT NULL,
    dueDate TEXT DEFAULT NULL
  )
`);

// Activity / Comments table
db.exec(`
  CREATE TABLE IF NOT EXISTS card_activity (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT DEFAULT 'System',
    createdAt TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

// Task dependencies table
db.exec(`
  CREATE TABLE IF NOT EXISTS task_dependencies (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    FOREIGN KEY (blocker_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY (blocked_id) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

// Migrate: add columns if they don't exist (for existing databases)
const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!cols.includes('dueDate')) {
  db.exec('ALTER TABLE tasks ADD COLUMN dueDate TEXT DEFAULT NULL');
  console.log('Migrated: added dueDate column to tasks table');
}
if (!cols.includes('recurring')) {
  db.exec('ALTER TABLE tasks ADD COLUMN recurring TEXT DEFAULT NULL');
  console.log('Migrated: added recurring column to tasks table');
}
if (!cols.includes('subtasks')) {
  db.exec('ALTER TABLE tasks ADD COLUMN subtasks TEXT DEFAULT NULL');
  console.log('Migrated: added subtasks column to tasks table');
}
if (!cols.includes('projectId')) {
  db.exec('ALTER TABLE tasks ADD COLUMN projectId TEXT DEFAULT NULL');
  console.log('Migrated: added projectId column to tasks table');
}
if (!cols.includes('lockedBy')) {
  db.exec('ALTER TABLE tasks ADD COLUMN lockedBy TEXT DEFAULT NULL');
  console.log('Migrated: added lockedBy column to tasks table');
}
if (!cols.includes('lockedAt')) {
  db.exec('ALTER TABLE tasks ADD COLUMN lockedAt TEXT DEFAULT NULL');
  console.log('Migrated: added lockedAt column to tasks table');
}
if (!cols.includes('lockExpiresAt')) {
  db.exec('ALTER TABLE tasks ADD COLUMN lockExpiresAt TEXT DEFAULT NULL');
  console.log('Migrated: added lockExpiresAt column to tasks table');
}
if (!cols.includes('blockedBy')) {
  db.exec("ALTER TABLE tasks ADD COLUMN blockedBy TEXT DEFAULT '[]'");
  console.log('Migrated: added blockedBy column to tasks table');
}
if (!cols.includes('wave')) {
  db.exec('ALTER TABLE tasks ADD COLUMN wave INTEGER DEFAULT NULL');
  console.log('Migrated: added wave column to tasks table');
}
if (!cols.includes('handoffLog')) {
  db.exec("ALTER TABLE tasks ADD COLUMN handoffLog TEXT DEFAULT '[]'");
  console.log('Migrated: added handoffLog column to tasks table');
}
if (!cols.includes('agentSessionId')) {
  db.exec('ALTER TABLE tasks ADD COLUMN agentSessionId TEXT DEFAULT NULL');
  console.log('Migrated: added agentSessionId column to tasks table');
}
if (!cols.includes('agentStartedAt')) {
  db.exec('ALTER TABLE tasks ADD COLUMN agentStartedAt TEXT DEFAULT NULL');
  console.log('Migrated: added agentStartedAt column to tasks table');
}
if (!cols.includes('sortOrder')) {
  db.exec('ALTER TABLE tasks ADD COLUMN sortOrder REAL DEFAULT NULL');
  // Seed existing tasks with sortOrder = rowid so relative ordering is preserved
  db.exec("UPDATE tasks SET sortOrder = rowid WHERE sortOrder IS NULL");
  console.log('Migrated: added sortOrder column to tasks table');
}

// Ensure default project exists and assign orphaned tasks to it
const defaultProject = db.prepare("SELECT id FROM projects WHERE id = 'default'").get();
if (!defaultProject) {
  db.prepare(
    "INSERT INTO projects (id, name, color, emoji, createdAt) VALUES ('default', 'Kanban Board', '#6c5ce7', '📋', ?)"
  ).run(new Date().toISOString());
  console.log('Created default project');
}
// Assign all tasks with NULL projectId to default project
const unassigned = db.prepare("UPDATE tasks SET projectId = 'default' WHERE projectId IS NULL").run();
if (unassigned.changes > 0) {
  console.log(`Assigned ${unassigned.changes} task(s) to default project`);
}

// Migrate existing tasks from tasks.json on first run
if (fs.existsSync(TASKS_JSON)) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get().cnt;
  if (count === 0) {
    const tasks = JSON.parse(fs.readFileSync(TASKS_JSON, 'utf8'));
    const insert = db.prepare(
      'INSERT OR IGNORE INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt, dueDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const migrate = db.transaction((tasks) => {
      for (const t of tasks) {
        insert.run(t.id, t.title, t.description || '', t.assignee || 'Mike', t.priority || 'medium', JSON.stringify(t.tags || []), t.column || 'backlog', t.createdAt, t.dueDate || null);
      }
    });
    migrate(tasks);
    console.log(`Migrated ${tasks.length} task(s) from tasks.json`);
  }
}

// Attachments table
db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    path TEXT NOT NULL,
    mimetype TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    uploadedAt TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

// Templates table
db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    defaultDescription TEXT DEFAULT '',
    defaultTags TEXT DEFAULT '[]',
    defaultAssignee TEXT DEFAULT 'Mike',
    defaultPriority TEXT DEFAULT 'medium',
    createdAt TEXT NOT NULL
  )
`);

// Migrate: add agentConfig column to projects if it doesn't exist
const projCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
if (!projCols.includes('agentConfig')) {
  db.exec("ALTER TABLE projects ADD COLUMN agentConfig TEXT DEFAULT NULL");
  console.log('Migrated: added agentConfig column to projects table');
}

// Notifications table
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    task_title TEXT NOT NULL,
    from_col TEXT NOT NULL,
    to_col TEXT NOT NULL,
    changed_by TEXT DEFAULT 'Mike',
    created_at TEXT NOT NULL,
    is_read INTEGER DEFAULT 0
  )
`);

// Webhooks table
db.exec(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT DEFAULT '[]',
    secret TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL,
    failCount INTEGER DEFAULT 0,
    lastFailedAt TEXT DEFAULT NULL
  )
`);

// Migrate: add failCount and lastFailedAt columns to webhooks if missing
const webhookCols = db.prepare("PRAGMA table_info(webhooks)").all().map(c => c.name);
if (!webhookCols.includes('failCount')) {
  db.exec('ALTER TABLE webhooks ADD COLUMN failCount INTEGER DEFAULT 0');
  console.log('Migrated: added failCount column to webhooks table');
}
if (!webhookCols.includes('lastFailedAt')) {
  db.exec('ALTER TABLE webhooks ADD COLUMN lastFailedAt TEXT DEFAULT NULL');
  console.log('Migrated: added lastFailedAt column to webhooks table');
}

// Agent logs table
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    taskId TEXT NOT NULL,
    agentSessionId TEXT DEFAULT NULL,
    level TEXT DEFAULT 'info',
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

// Handoff log table — replaces the handoffLog JSON blob in tasks
// Each row is one handoff note from one agent for one task.
db.exec(`
  CREATE TABLE IF NOT EXISTS handoff_log (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    agentId TEXT DEFAULT 'unknown',
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (taskId) REFERENCES tasks(id) ON DELETE CASCADE
  )
`);

// Index for fast per-task lookups
db.exec(`CREATE INDEX IF NOT EXISTS idx_handoff_log_taskId ON handoff_log(taskId)`);

// One-time migration: move any existing handoffLog JSON blobs into the new table.
// Safe to run on every startup — only processes rows that haven't been migrated yet
// (tasks whose handoffLog is a non-empty JSON array AND whose taskId has no rows in handoff_log).
(function migrateHandoffLogs() {
  const tasks = db.prepare("SELECT id, handoffLog FROM tasks WHERE handoffLog IS NOT NULL AND handoffLog != '[]' AND handoffLog != ''").all();
  const cryptoMod = require('crypto');
  const insertEntry = db.prepare('INSERT OR IGNORE INTO handoff_log (id, taskId, agentId, message, timestamp) VALUES (?, ?, ?, ?, ?)');
  const migrate = db.transaction((tasks) => {
    for (const task of tasks) {
      // Skip if already migrated
      const existing = db.prepare('SELECT COUNT(*) AS cnt FROM handoff_log WHERE taskId = ?').get(task.id);
      if (existing.cnt > 0) continue;
      let entries;
      try { entries = JSON.parse(task.handoffLog); } catch(e) { continue; }
      if (!Array.isArray(entries) || entries.length === 0) continue;
      for (const entry of entries) {
        const entryId = cryptoMod.randomBytes(8).toString('hex');
        insertEntry.run(
          entryId,
          task.id,
          entry.agentId || 'unknown',
          entry.message || '',
          entry.timestamp || new Date().toISOString()
        );
      }
      console.log(`Migrated ${entries.length} handoff entry/entries for task ${task.id}`);
    }
  });
  migrate(tasks);
})();

// Indexes for common query patterns
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
  CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks("column");
  CREATE INDEX IF NOT EXISTS idx_tasks_wave ON tasks(wave);
  CREATE INDEX IF NOT EXISTS idx_card_activity_taskId ON card_activity(taskId);
  CREATE INDEX IF NOT EXISTS idx_agent_logs_taskId ON agent_logs(taskId);
  CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked_id ON task_dependencies(blocked_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_task_id ON notifications(task_id);
`);

// Periodic backup — runs every 6 hours using better-sqlite3's native backup API.
// Writes to kanban.db.bak in the same directory.
const BACKUP_PATH = path.join(__dirname, 'kanban.db.bak');
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function runBackup() {
  db.backup(BACKUP_PATH)
    .then(() => {
      console.log(`[kanban] Database backed up to ${BACKUP_PATH}`);
    })
    .catch((err) => {
      console.warn(`[kanban] WARNING: database backup failed: ${err.message}`);
    });
}

// Run once at startup (deferred 30s so the server is fully initialised),
// then on the interval.
setTimeout(() => {
  runBackup();
  setInterval(runBackup, BACKUP_INTERVAL_MS);
}, 30_000);

module.exports = db;
