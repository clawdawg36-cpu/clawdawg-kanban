# 🐾 ClawDawg Kanban

A modern, sleek, dark-themed Kanban board web app for tracking tasks between Mike and ClawDawg (his AI assistant). Built with Node.js, Express, and SQLite.

## Features

- 🎨 **Dark, premium UI** — Inter font, smooth animations, subtle gradients
- 🖱️ **Drag & drop** — move cards between columns effortlessly
- 📋 **Columns** — Backlog, In Progress, In Review, Done
- 🏷️ **Cards** — title, description, assignee (Mike or ClawDawg), priority, tags, created date
- 🔍 **Filter by assignee**
- 💾 **SQLite persistence** with WAL mode for safe concurrent writes
- ⚡ **Parallel task processing** — ClawDawg picks up and processes multiple tasks simultaneously via sub-agents

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`) with WAL mode
- **Frontend:** Vanilla HTML/CSS/JS — no build step required

## Getting Started

```bash
# Install dependencies
npm install

# Start the server
node server.js
```

Then open [http://localhost:3456](http://localhost:3456) in your browser.

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | Get all tasks |
| POST | `/api/tasks` | Create a new task |
| PUT | `/api/tasks/:id` | Update a task (e.g. move columns) |
| DELETE | `/api/tasks/:id` | Delete a task |

## Task Schema

```json
{
  "id": "unique-id",
  "title": "Task title",
  "description": "Task description",
  "assignee": "ClawDawg | Mike",
  "priority": "low | medium | high | urgent",
  "tags": ["tag1", "tag2"],
  "column": "backlog | in-progress | in-review | done",
  "createdAt": "2026-03-19T00:00:00.000Z"
}
```

## How It Works

ClawDawg monitors the board automatically. Any card assigned to **ClawDawg** in the **Backlog** column gets picked up, worked on, and moved to **Done** — with a summary sent back to Mike. Multiple tasks are processed in parallel.

Mike can add tasks for ClawDawg directly on the board, and ClawDawg can add tasks for Mike when input or approval is needed.

## Database Backup & Restore

The server automatically backs up the SQLite database every **6 hours** to `kanban.db.bak` in the project root (first backup runs 30 seconds after startup).

### Manual backup

```bash
# Copy the live DB while the server is running — better-sqlite3 handles this safely via its backup API.
# Or just copy the file while the server is stopped:
cp kanban.db kanban.db.bak
```

### Restore from backup

```bash
# Stop the server first, then:
cp kanban.db.bak kanban.db
node server.js
```

### If the database is corrupted

If the server refuses to start with a corruption error:

1. Stop the server
2. Restore from backup: `cp kanban.db.bak kanban.db`
3. Restart: `node server.js`

If no backup exists, remove the corrupted file to start fresh (all data will be lost):

```bash
rm kanban.db
node server.js
```

> **Note:** `kanban.db`, `kanban.db.bak`, `kanban.db-shm`, and `kanban.db-wal` are gitignored and will never be committed.

## Database Backup & Restore

The server automatically backs up the SQLite database every **6 hours** to `kanban.db.bak` in the project root (first backup runs 30 seconds after startup).

### Manual backup

```bash
# Copy the file while the server is stopped:
cp kanban.db kanban.db.bak
```

### Restore from backup

```bash
# Stop the server first, then:
cp kanban.db.bak kanban.db
node server.js
```

### If the database is corrupted

If the server refuses to start with a corruption error:

1. Stop the server
2. Restore from backup: `cp kanban.db.bak kanban.db`
3. Restart: `node server.js`

If no backup exists, remove the corrupted file to start fresh (all data will be lost):

```bash
rm kanban.db
node server.js
```

> **Note:** `kanban.db`, `kanban.db.bak`, `kanban.db-shm`, and `kanban.db-wal` are gitignored and will never be committed.

---

*Built by ClawDawg 🐾 — Mike's AI assistant*
