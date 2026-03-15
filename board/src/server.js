const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { db, initDatabase, autoArchiveDoneTasks } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

initDatabase();

// Run auto-archive on startup and every hour
autoArchiveDoneTasks();
setInterval(autoArchiveDoneTasks, 60 * 60 * 1000);

// ── Projects API ──
app.get('/api/projects', (req, res) => {
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json(projects);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, description, color = '#6366f1' } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });
    const stmt = db.prepare('INSERT INTO projects (name, description, color) VALUES (?, ?, ?)');
    const result = stmt.run(name, description, color);
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Project name already exists' });
    } else { res.status(500).json({ error: error.message }); }
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const { name, description, color } = req.body;
    const stmt = db.prepare('UPDATE projects SET name = ?, description = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(name, description, color || '#6366f1', req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    res.json(project);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
    res.status(204).send();
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Tasks API ──
const TASK_SELECT = `
  SELECT t.*, p.name as project_name, p.color as project_color,
         GROUP_CONCAT(DISTINCT l.name) as labels,
         GROUP_CONCAT(DISTINCT l.color) as label_colors,
         (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id) as subtask_count,
         (SELECT COUNT(*) FROM subtasks WHERE task_id = t.id AND completed = 1) as subtask_done
  FROM tasks t
  LEFT JOIN projects p ON t.project_id = p.id
  LEFT JOIN task_labels tl ON t.id = tl.task_id
  LEFT JOIN labels l ON tl.label_id = l.id
`;

app.get('/api/projects/:id/tasks', (req, res) => {
  try {
    const tasks = db.prepare(`
      ${TASK_SELECT}
      WHERE t.project_id = ? AND t.archived = 0
      GROUP BY t.id
      ORDER BY t.status, t.position, t.created_at
    `).all(req.params.id);

    const docsStmt = db.prepare('SELECT id, url, title FROM task_docs WHERE task_id = ? ORDER BY created_at');
    tasks.forEach(task => {
      task.labels = task.labels ? task.labels.split(',') : [];
      task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
      task.docs = docsStmt.all(task.id);
    });
    res.json(tasks);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/projects/:id/tasks', (req, res) => {
  try {
    const { title, description, priority = "medium", status = "backlog", labels = [], assignee = null, due_date = null } = req.body;
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    const done_at = status === 'done' ? new Date().toISOString() : null;
    const stmt = db.prepare('INSERT INTO tasks (project_id, title, description, priority, status, assignee, due_date, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const result = stmt.run(req.params.id, title, description, priority, status, assignee, due_date, done_at);

    if (labels.length > 0) {
      const labelStmt = db.prepare('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)');
      labels.forEach(labelId => labelStmt.run(result.lastInsertRowid, labelId));
    }
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = db.prepare(`
      ${TASK_SELECT}
      WHERE t.id = ?
      GROUP BY t.id
    `).get(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    task.labels = task.labels ? task.labels.split(',') : [];
    task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
    task.docs = db.prepare('SELECT id, url, title FROM task_docs WHERE task_id = ? ORDER BY created_at').all(task.id);
    res.json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const { title, description, priority, labels = [], assignee = null, due_date = null } = req.body;
    const stmt = db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ?, assignee = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(title, description, priority, assignee, due_date || null, req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });

    db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(req.params.id);
    if (labels.length > 0) {
      const labelStmt = db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)');
      labels.forEach(labelId => labelStmt.run(req.params.id, labelId));
    }
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/tasks/:id/move', (req, res) => {
  try {
    const { status, position } = req.body;
    // Track when task moves to done
    const existing = db.prepare('SELECT status FROM tasks WHERE id = ?').get(req.params.id);
    let done_at_update = '';
    const params = [status, position || 0];
    if (status === 'done' && existing && existing.status !== 'done') {
      done_at_update = ', done_at = CURRENT_TIMESTAMP';
    } else if (status !== 'done') {
      done_at_update = ', done_at = NULL';
    }
    const stmt = db.prepare(`UPDATE tasks SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP${done_at_update} WHERE id = ?`);
    params.push(req.params.id);
    const result = stmt.run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    res.status(204).send();
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Archive API ──
app.get('/api/archive', (req, res) => {
  try {
    const tasks = db.prepare(`
      ${TASK_SELECT}
      WHERE t.archived = 1
      GROUP BY t.id
      ORDER BY t.archived_at DESC
    `).all();
    const docsStmt = db.prepare('SELECT id, url, title FROM task_docs WHERE task_id = ? ORDER BY created_at');
    tasks.forEach(task => {
      task.labels = task.labels ? task.labels.split(',') : [];
      task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
      task.docs = docsStmt.all(task.id);
    });
    res.json(tasks);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/tasks/:id/restore', (req, res) => {
  try {
    const stmt = db.prepare('UPDATE tasks SET archived = 0, archived_at = NULL, status = ?, done_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(req.body.status || 'todo', req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/tasks/:id/archive', (req, res) => {
  try {
    const stmt = db.prepare('UPDATE tasks SET archived = 1, archived_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Task not found' });
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Calendar API ──
app.get('/api/calendar', (req, res) => {
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'year and month required' });
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonth = parseInt(month) === 12 ? 1 : parseInt(month) + 1;
    const nextYear = parseInt(month) === 12 ? parseInt(year) + 1 : parseInt(year);
    const endDate = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;

    const tasks = db.prepare(`
      ${TASK_SELECT}
      WHERE t.due_date >= ? AND t.due_date < ? AND t.archived = 0
      GROUP BY t.id
      ORDER BY t.due_date, t.priority
    `).all(startDate, endDate);

    tasks.forEach(task => {
      task.labels = task.labels ? task.labels.split(',') : [];
      task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
    });
    res.json(tasks);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Task Docs API ──
app.post('/api/tasks/:id/docs', (req, res) => {
  try {
    const { url, title } = req.body;
    if (!url || !title) return res.status(400).json({ error: 'URL and title are required' });
    const stmt = db.prepare('INSERT OR IGNORE INTO task_docs (task_id, url, title) VALUES (?, ?, ?)');
    const result = stmt.run(req.params.id, url, title);
    if (result.changes === 0) return res.status(409).json({ error: 'Doc already linked' });
    const doc = db.prepare('SELECT * FROM task_docs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(doc);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/tasks/:taskId/docs/:docId', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM task_docs WHERE id = ? AND task_id = ?').run(req.params.docId, req.params.taskId);
    if (result.changes === 0) return res.status(404).json({ error: 'Doc link not found' });
    res.status(204).send();
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ── Labels API ──
app.get('/api/labels', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM labels ORDER BY name').all());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/labels', (req, res) => {
  try {
    const { name, color = '#646cff' } = req.body;
    if (!name) return res.status(400).json({ error: 'Label name is required' });
    const stmt = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)');
    const result = stmt.run(name, color);
    const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(label);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Label name already exists' });
    } else { res.status(500).json({ error: error.message }); }
  }
});

// ── Trigger archive manually ──
app.post('/api/archive/run', (req, res) => {
  try {
    const count = autoArchiveDoneTasks();
    res.json({ archived: count });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });


// Global search endpoint (internal, no auth)
// ── Stats API ──
app.get('/api/stats', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Monday of this week
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + mondayOffset);
    thisMonday.setHours(0, 0, 0, 0);
    const nextMonday = new Date(thisMonday);
    nextMonday.setDate(thisMonday.getDate() + 7);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);

    const fmt = d => d.toISOString().slice(0, 10);
    const thisMon = fmt(thisMonday);
    const nextMon = fmt(nextMonday);
    const lastMon = fmt(lastMonday);

    // Total active (non-archived, non-done)
    const totalTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE archived = 0 AND status != 'done'").get().c;

    // By status
    const statusRows = db.prepare("SELECT status, COUNT(*) as c FROM tasks WHERE archived = 0 GROUP BY status").all();
    const byStatus = {};
    statusRows.forEach(r => { byStatus[r.status] = r.c; });

    // By priority
    const prioRows = db.prepare("SELECT priority, COUNT(*) as c FROM tasks WHERE archived = 0 AND status != 'done' GROUP BY priority").all();
    const byPriority = {};
    prioRows.forEach(r => { byPriority[r.priority] = r.c; });

    // Overdue
    const overdueTasks = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE due_date < ? AND status != 'done' AND archived = 0").get(today).c;

    // Completed this week (done_at in [thisMonday, nextMonday))
    const completedThisWeek = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE done_at >= ? AND done_at < ? AND status = 'done'").get(thisMon, nextMon).c;

    // Completed last week
    const completedLastWeek = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE done_at >= ? AND done_at < ? AND status = 'done'").get(lastMon, thisMon).c;

    // Average completion days
    const avgRow = db.prepare("SELECT AVG(julianday(done_at) - julianday(created_at)) as avg_days FROM tasks WHERE done_at IS NOT NULL AND status = 'done'").get();
    const averageCompletionDays = avgRow.avg_days ? Math.round(avgRow.avg_days * 10) / 10 : 0;

    // Projects
    const projects = db.prepare(`
      SELECT p.id, p.name, p.color,
        COUNT(t.id) as total,
        SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN t.status = 'in-progress' THEN 1 ELSE 0 END) as inProgress,
        SUM(CASE WHEN t.due_date < ? AND t.status != 'done' AND t.archived = 0 THEN 1 ELSE 0 END) as overdue
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id AND t.archived = 0
      GROUP BY p.id
      ORDER BY p.name
    `).all(today);

    res.json({
      overview: { totalTasks, byStatus, byPriority, overdueTasks, completedThisWeek, completedLastWeek, averageCompletionDays },
      projects
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get("/api/search", (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.json([]);
    const tasks = db.prepare("SELECT t.id, t.title, t.description, t.status, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE (t.title LIKE ? OR t.description LIKE ?) AND t.archived = 0 LIMIT 10").all("%" + q + "%", "%" + q + "%");
    res.json(tasks);
  } catch (error) { res.json([]); }
});


// ── Subtasks API ──
app.get('/api/tasks/:id/subtasks', (req, res) => {
  try {
    const subtasks = db.prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY position, id').all(req.params.id);
    res.json(subtasks);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/tasks/:id/subtasks', (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'Subtask title is required' });
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) as mp FROM subtasks WHERE task_id = ?').get(req.params.id).mp;
    const stmt = db.prepare('INSERT INTO subtasks (task_id, title, position) VALUES (?, ?, ?)');
    const result = stmt.run(req.params.id, title, maxPos + 1);
    const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(subtask);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/subtasks/:id', (req, res) => {
  try {
    const { title, completed } = req.body;
    const existing = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Subtask not found' });
    const newTitle = title !== undefined ? title : existing.title;
    const newCompleted = completed !== undefined ? (completed ? 1 : 0) : existing.completed;
    db.prepare('UPDATE subtasks SET title = ?, completed = ? WHERE id = ?').run(newTitle, newCompleted, req.params.id);
    const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
    res.json(subtask);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/subtasks/:id', (req, res) => {
  try {
    const result = db.prepare('DELETE FROM subtasks WHERE id = ?').run(req.params.id);
    if (result.changes === 0) return res.status(404).json({ error: 'Subtask not found' });
    res.status(204).send();
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/subtasks/:id/toggle', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Subtask not found' });
    const newVal = existing.completed ? 0 : 1;
    db.prepare('UPDATE subtasks SET completed = ? WHERE id = ?').run(newVal, req.params.id);
    const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
    res.json(subtask);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, () => {
  console.log(`🦞 Lobsty Board running on port ${PORT}`);
});
