const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const DB_PATH = path.join(__dirname, 'kanban.db');
const TASKS_JSON = path.join(__dirname, 'tasks.json');

const BACKUP_DIR = path.join(__dirname, 'backups');
const BACKUP_BASENAME = 'kanban.db.bak';
const BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BACKUP_RETENTION = Math.max(1, Number.parseInt(process.env.KANBAN_BACKUP_KEEP || '5', 10) || 5);
const BACKUP_SYNC_BIN = (process.env.KANBAN_BACKUP_SYNC_BIN || '').trim();
const BACKUP_SYNC_ARGS = (() => {
  if (!process.env.KANBAN_BACKUP_SYNC_ARGS_JSON) return null;
  try {
    const parsed = JSON.parse(process.env.KANBAN_BACKUP_SYNC_ARGS_JSON);
    return Array.isArray(parsed) ? parsed.map(v => String(v)) : null;
  } catch (err) {
    console.warn(`[kanban] WARNING: could not parse KANBAN_BACKUP_SYNC_ARGS_JSON: ${err.message}`);
    return null;
  }
})();

function formatBackupTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function listRotatedBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(name => name.startsWith(`${BACKUP_BASENAME}.`))
    .sort()
    .map(name => path.join(BACKUP_DIR, name));
}

function pruneOldBackups() {
  const backups = listRotatedBackups();
  const staleBackups = backups.slice(0, Math.max(0, backups.length - BACKUP_RETENTION));
  for (const backupPath of staleBackups) {
    try {
      fs.unlinkSync(backupPath);
      console.log(`[kanban] Pruned old backup ${path.basename(backupPath)}`);
    } catch (err) {
      console.warn(`[kanban] WARNING: failed to prune old backup ${backupPath}: ${err.message}`);
    }
  }
}

function syncBackupOffHost(backupPath) {
  if (!BACKUP_SYNC_BIN) return;
  if (!BACKUP_SYNC_ARGS || BACKUP_SYNC_ARGS.length === 0) {
    console.warn('[kanban] WARNING: KANBAN_BACKUP_SYNC_BIN is set but KANBAN_BACKUP_SYNC_ARGS_JSON is missing or invalid; skipping off-host sync');
    return;
  }

  const backupName = path.basename(backupPath);
  const args = BACKUP_SYNC_ARGS.map(arg => arg.replaceAll('{file}', backupPath).replaceAll('{name}', backupName));
  try {
    execFileSync(BACKUP_SYNC_BIN, args, { stdio: 'pipe' });
    console.log(`[kanban] Synced backup off-host via ${BACKUP_SYNC_BIN}: ${backupName}`);
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    console.warn(`[kanban] WARNING: off-host backup sync failed for ${backupName}: ${stderr || err.message}`);
  }
}

const TASKS_SCHEMA_V1_COLUMNS = [
  'dueDate',
  'recurring',
  'subtasks',
  'projectId',
  'lockedBy',
  'lockedAt',
  'lockExpiresAt',
  'blockedBy',
  'wave',
  'handoffLog',
  'agentSessionId',
  'agentStartedAt',
];
const LATEST_SCHEMA_VERSION = 5;

// Open the database with error handling — better-sqlite3 throws synchronously
// on corruption or permission errors, so we catch and exit gracefully.
let db;
try {
  db = new Database(DB_PATH);
} catch (err) {
  console.error(`[kanban] Fatal: could not open database at ${DB_PATH}`);
  console.error(`[kanban] Reason: ${err.message}`);
  console.error('[kanban] Check file permissions, available disk space, or whether the file is corrupted.');
  console.error(`[kanban] If the database is corrupted, try restoring from the most recent rotated backup in ${BACKUP_DIR}.`);
  process.exit(1);
}

db.pragma('journal_mode = WAL');

// Integrity check — runs quickly on startup and warns if the DB looks unhealthy.
try {
  const rows = db.pragma('integrity_check');
  const result = rows[0]?.integrity_check ?? rows[0]?.['integrity_check'];
  if (result !== 'ok') {
    console.warn(`[kanban] WARNING: PRAGMA integrity_check returned: ${JSON.stringify(rows)}`);
    console.warn(`[kanban] The database may be corrupted. Consider restoring from the most recent rotated backup in ${BACKUP_DIR}.`);
  }
} catch (err) {
  console.warn(`[kanban] WARNING: integrity_check failed: ${err.message}`);
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

function getTableColumns(tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
}

function getUserVersion() {
  return db.pragma('user_version', { simple: true });
}

function setUserVersion(version) {
  db.pragma(`user_version = ${version}`);
}

function detectLegacySchemaVersion() {
  const taskCols = getTableColumns('tasks');
  const projectCols = getTableColumns('projects');
  const notificationCols = getTableColumns('notifications');

  let version = 0;
  if (TASKS_SCHEMA_V1_COLUMNS.every(col => taskCols.includes(col))) version = 1;
  if (projectCols.includes('agentConfig')) version = 2;
  if (notificationCols.includes('project_id')) version = 3;
  return version;
}

const migrations = [
  {
    version: 1,
    apply() {
      const cols = getTableColumns('tasks');
      const addColumn = (name, sql, message) => {
        if (!cols.includes(name)) {
          db.exec(sql);
          console.log(message);
        }
      };

      addColumn('dueDate', 'ALTER TABLE tasks ADD COLUMN dueDate TEXT DEFAULT NULL', 'Migrated: added dueDate column to tasks table');
      addColumn('recurring', 'ALTER TABLE tasks ADD COLUMN recurring TEXT DEFAULT NULL', 'Migrated: added recurring column to tasks table');
      addColumn('subtasks', 'ALTER TABLE tasks ADD COLUMN subtasks TEXT DEFAULT NULL', 'Migrated: added subtasks column to tasks table');
      addColumn('projectId', 'ALTER TABLE tasks ADD COLUMN projectId TEXT DEFAULT NULL', 'Migrated: added projectId column to tasks table');
      addColumn('lockedBy', 'ALTER TABLE tasks ADD COLUMN lockedBy TEXT DEFAULT NULL', 'Migrated: added lockedBy column to tasks table');
      addColumn('lockedAt', 'ALTER TABLE tasks ADD COLUMN lockedAt TEXT DEFAULT NULL', 'Migrated: added lockedAt column to tasks table');
      addColumn('lockExpiresAt', 'ALTER TABLE tasks ADD COLUMN lockExpiresAt TEXT DEFAULT NULL', 'Migrated: added lockExpiresAt column to tasks table');
      addColumn('blockedBy', "ALTER TABLE tasks ADD COLUMN blockedBy TEXT DEFAULT '[]'", 'Migrated: added blockedBy column to tasks table');
      addColumn('wave', 'ALTER TABLE tasks ADD COLUMN wave INTEGER DEFAULT NULL', 'Migrated: added wave column to tasks table');
      addColumn('handoffLog', "ALTER TABLE tasks ADD COLUMN handoffLog TEXT DEFAULT '[]'", 'Migrated: added handoffLog column to tasks table');
      addColumn('agentSessionId', 'ALTER TABLE tasks ADD COLUMN agentSessionId TEXT DEFAULT NULL', 'Migrated: added agentSessionId column to tasks table');
      addColumn('agentStartedAt', 'ALTER TABLE tasks ADD COLUMN agentStartedAt TEXT DEFAULT NULL', 'Migrated: added agentStartedAt column to tasks table');
    },
  },
  {
    version: 2,
    apply() {
      const projCols = getTableColumns('projects');
      if (!projCols.includes('agentConfig')) {
        db.exec("ALTER TABLE projects ADD COLUMN agentConfig TEXT DEFAULT NULL");
        console.log('Migrated: added agentConfig column to projects table');
      }
    },
  },
  {
    version: 3,
    apply() {
      const notificationCols = getTableColumns('notifications');
      if (!notificationCols.includes('project_id')) {
        db.exec("ALTER TABLE notifications ADD COLUMN project_id TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_notifications_project_id ON notifications(project_id)");
        db.exec("UPDATE notifications SET project_id = (SELECT projectId FROM tasks WHERE tasks.id = notifications.task_id) WHERE project_id IS NULL");
        console.log('Migrated: added project_id column to notifications table');
      }
    },
  },
  {
    version: 4,
    apply() {
      const templateCols = getTableColumns('templates');
      if (!templateCols.includes('defaultColumn')) {
        db.exec("ALTER TABLE templates ADD COLUMN defaultColumn TEXT DEFAULT 'backlog'");
        console.log('Migrated: added defaultColumn column to templates table');
      }
    },
  },
  {
    version: 5,
    apply() {
      const cols = getTableColumns('tasks');
      if (!cols.includes('startAfter')) {
        db.exec('ALTER TABLE tasks ADD COLUMN startAfter TEXT DEFAULT NULL');
        console.log('Migrated: added startAfter column to tasks table');
      }
    },
  },
];

const applyMigrations = db.transaction(() => {
  let currentVersion = getUserVersion();

  if (currentVersion === 0) {
    const detectedVersion = detectLegacySchemaVersion();
    if (detectedVersion > 0) {
      setUserVersion(detectedVersion);
      currentVersion = detectedVersion;
      console.log(`Backfilled schema version to ${detectedVersion}`);
    }
  }

  for (const migration of migrations) {
    if (currentVersion < migration.version) {
      migration.apply();
      setUserVersion(migration.version);
      currentVersion = migration.version;
      console.log(`Schema version is now ${migration.version}`);
    }
  }

  if (currentVersion !== LATEST_SCHEMA_VERSION) {
    setUserVersion(LATEST_SCHEMA_VERSION);
  }
});

applyMigrations();

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

// Webhooks table
db.exec(`
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT DEFAULT '[]',
    secret TEXT DEFAULT NULL,
    createdAt TEXT NOT NULL
  )
`);

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
// Indexes for common query patterns
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tasks_projectId ON tasks(projectId);
  CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks("column");
  CREATE INDEX IF NOT EXISTS idx_tasks_wave ON tasks(wave);
  CREATE INDEX IF NOT EXISTS idx_card_activity_taskId ON card_activity(taskId);
  CREATE INDEX IF NOT EXISTS idx_agent_logs_taskId ON agent_logs(taskId);
  CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked_id ON task_dependencies(blocked_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_task_id ON notifications(task_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_project_id ON notifications(project_id);
`);


async function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, `${BACKUP_BASENAME}.${formatBackupTimestamp()}`);
    await db.backup(backupPath);
    console.log(`[kanban] Backup complete: ${backupPath}`);
    pruneOldBackups();
    syncBackupOffHost(backupPath);
    return backupPath;
  } catch (err) {
    console.warn(`[kanban] WARNING: backup failed: ${err.message}`);
    return null;
  }
}

const startupBackupTimer = setTimeout(() => {
  runBackup().catch(err => console.warn(`[kanban] WARNING: startup backup failed: ${err.message}`));
}, 30 * 1000);
if (typeof startupBackupTimer.unref === 'function') startupBackupTimer.unref();
const backupInterval = setInterval(() => {
  runBackup().catch(err => console.warn(`[kanban] WARNING: scheduled backup failed: ${err.message}`));
}, BACKUP_INTERVAL_MS);
if (typeof backupInterval.unref === 'function') backupInterval.unref();

db.runBackup = runBackup;
db.getBackupDir = () => BACKUP_DIR;
db.getBackupRetention = () => BACKUP_RETENTION;

module.exports = db;
