const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'lobsty-board.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      priority TEXT NOT NULL DEFAULT 'medium',
      position INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assignee TEXT DEFAULT NULL,
      FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#646cff',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_labels (
      task_id INTEGER NOT NULL,
      label_id INTEGER NOT NULL,
      PRIMARY KEY (task_id, label_id),
      FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      FOREIGN KEY (label_id) REFERENCES labels (id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
      UNIQUE(task_id, url)
    )
  `);

  // Migrate: add new columns if missing
  const cols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!cols.includes('due_date')) db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT DEFAULT NULL");
  if (!cols.includes('archived')) db.exec("ALTER TABLE tasks ADD COLUMN archived INTEGER DEFAULT 0");
  if (!cols.includes('archived_at')) db.exec("ALTER TABLE tasks ADD COLUMN archived_at DATETIME DEFAULT NULL");
  if (!cols.includes('done_at')) db.exec("ALTER TABLE tasks ADD COLUMN done_at DATETIME DEFAULT NULL");

  const pcols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
  if (!pcols.includes('color')) db.exec("ALTER TABLE projects ADD COLUMN color TEXT DEFAULT '#6366f1'");

  // Now create indexes (after columns exist)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks (project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks (priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_archived ON tasks (archived);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);
    CREATE INDEX IF NOT EXISTS idx_task_labels_task_id ON task_labels (task_id);
    CREATE INDEX IF NOT EXISTS idx_task_labels_label_id ON task_labels (label_id);
    CREATE INDEX IF NOT EXISTS idx_task_docs_task_id ON task_docs (task_id);
  `);

  // Set done_at for existing done tasks
  db.exec("UPDATE tasks SET done_at = updated_at WHERE status = 'done' AND done_at IS NULL AND archived = 0");

  console.log('Database initialized successfully');
}

function autoArchiveDoneTasks() {
  const result = db.prepare(`
    UPDATE tasks SET archived = 1, archived_at = CURRENT_TIMESTAMP
    WHERE status = 'done' AND archived = 0
    AND done_at IS NOT NULL
    AND done_at <= datetime('now', '-7 days')
  `).run();
  if (result.changes > 0) {
    console.log(`Auto-archived ${result.changes} completed task(s)`);
  }
  return result.changes;
}

module.exports = { db, initDatabase, autoArchiveDoneTasks };
