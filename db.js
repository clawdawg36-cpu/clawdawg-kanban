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
    createdAt TEXT NOT NULL
  )
`);

// Migrate existing tasks from tasks.json on first run
if (fs.existsSync(TASKS_JSON)) {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get().cnt;
  if (count === 0) {
    const tasks = JSON.parse(fs.readFileSync(TASKS_JSON, 'utf8'));
    const insert = db.prepare(
      'INSERT OR IGNORE INTO tasks (id, title, description, assignee, priority, tags, "column", createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const migrate = db.transaction((tasks) => {
      for (const t of tasks) {
        insert.run(t.id, t.title, t.description || '', t.assignee || 'Mike', t.priority || 'medium', JSON.stringify(t.tags || []), t.column || 'backlog', t.createdAt);
      }
    });
    migrate(tasks);
    console.log(`Migrated ${tasks.length} task(s) from tasks.json`);
  }
}

module.exports = db;
