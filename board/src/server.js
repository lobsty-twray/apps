const express = require('express');
const cors = require('cors');
const path = require('path');
const { db, initDatabase } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Initialize database
initDatabase();

// Projects API
app.get('/api/projects', (req, res) => {
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json(projects);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects', (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    
    const stmt = db.prepare('INSERT INTO projects (name, description) VALUES (?, ?)');
    const result = stmt.run(name, description);
    
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(project);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Project name already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

app.get('/api/projects/:id', (req, res) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const { name, description } = req.body;
    const stmt = db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(name, description, req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    res.json(project);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM projects WHERE id = ?');
    const result = stmt.run(req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }
    
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Tasks API
app.get('/api/projects/:id/tasks', (req, res) => {
  try {
    const tasks = db.prepare(`
      SELECT t.*, GROUP_CONCAT(l.name) as labels, GROUP_CONCAT(l.color) as label_colors
      FROM tasks t
      LEFT JOIN task_labels tl ON t.id = tl.task_id
      LEFT JOIN labels l ON tl.label_id = l.id
      WHERE t.project_id = ?
      GROUP BY t.id
      ORDER BY t.status, t.position, t.created_at
    `).all(req.params.id);
    
    // Parse labels and colors
    tasks.forEach(task => {
      task.labels = task.labels ? task.labels.split(',') : [];
      task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
    });
    
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/projects/:id/tasks', (req, res) => {
  try {
    const { title, description, priority = 'medium', status = 'backlog', labels = [] } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Task title is required' });
    }
    
    const stmt = db.prepare('INSERT INTO tasks (project_id, title, description, priority, status) VALUES (?, ?, ?, ?, ?)');
    const result = stmt.run(req.params.id, title, description, priority, status);
    
    // Add labels if provided
    if (labels.length > 0) {
      const labelStmt = db.prepare('INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)');
      labels.forEach(labelId => {
        labelStmt.run(result.lastInsertRowid, labelId);
      });
    }
    
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = db.prepare(`
      SELECT t.*, GROUP_CONCAT(l.name) as labels, GROUP_CONCAT(l.color) as label_colors
      FROM tasks t
      LEFT JOIN task_labels tl ON t.id = tl.task_id
      LEFT JOIN labels l ON tl.label_id = l.id
      WHERE t.id = ?
      GROUP BY t.id
    `).get(req.params.id);
    
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    task.labels = task.labels ? task.labels.split(',') : [];
    task.label_colors = task.label_colors ? task.label_colors.split(',') : [];
    
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/tasks/:id', (req, res) => {
  try {
    const { title, description, priority, labels = [] } = req.body;
    const stmt = db.prepare('UPDATE tasks SET title = ?, description = ?, priority = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(title, description, priority, req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    // Update labels
    db.prepare('DELETE FROM task_labels WHERE task_id = ?').run(req.params.id);
    if (labels.length > 0) {
      const labelStmt = db.prepare('INSERT INTO task_labels (task_id, label_id) VALUES (?, ?)');
      labels.forEach(labelId => {
        labelStmt.run(req.params.id, labelId);
      });
    }
    
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/tasks/:id/move', (req, res) => {
  try {
    const { status, position } = req.body;
    const stmt = db.prepare('UPDATE tasks SET status = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const result = stmt.run(status, position || 0, req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    res.json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/tasks/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
    const result = stmt.run(req.params.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Task not found' });
    }
    
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Labels API
app.get('/api/labels', (req, res) => {
  try {
    const labels = db.prepare('SELECT * FROM labels ORDER BY name').all();
    res.json(labels);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/labels', (req, res) => {
  try {
    const { name, color = '#646cff' } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Label name is required' });
    }
    
    const stmt = db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)');
    const result = stmt.run(name, color);
    
    const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(label);
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: 'Label name already exists' });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Create data directory if it doesn't exist
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

app.listen(PORT, () => {
  console.log(`🦞 Lobsty Board running on port ${PORT}`);
});
