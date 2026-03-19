const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'kanban.db');
const TASKS_JSON = path.join(__dirname, 'tasks.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

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

// Migrate: add dueDate column if it doesn't exist (for existing databases)
const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!cols.includes('dueDate')) {
  db.exec('ALTER TABLE tasks ADD COLUMN dueDate TEXT DEFAULT NULL');
  console.log('Migrated: added dueDate column to tasks table');
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

module.exports = db;
