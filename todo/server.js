const express = require('express');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://lobsty:lobsty2026@postgres:5432/lobsty_main'
});

// Init DB
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      done BOOLEAN DEFAULT false,
      priority VARCHAR(10) DEFAULT 'none',
      category VARCHAR(20) DEFAULT '',
      due VARCHAR(10) DEFAULT '',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      completed_at BIGINT,
      sort_order INT DEFAULT 0,
      subtasks JSONB DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS subtasks JSONB DEFAULT '[]'::jsonb`).catch(() => {});
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0`).catch(() => {});
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurring VARCHAR(20) DEFAULT ''`).catch(() => {});
  await pool.query(`ALTER TABLE todos ADD COLUMN IF NOT EXISTS recurring_interval VARCHAR(20) DEFAULT ''`).catch(() => {});
}

// Calculate next due date based on recurring type
function calcNextDue(currentDue, recurring, recurringInterval) {
  const base = currentDue ? new Date(currentDue + 'T00:00:00') : new Date();
  base.setHours(0, 0, 0, 0);
  // If base is in the past, start from today
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (base < today) base.setTime(today.getTime());

  switch (recurring) {
    case 'daily':
      base.setDate(base.getDate() + 1);
      break;
    case 'weekdays': {
      base.setDate(base.getDate() + 1);
      while (base.getDay() === 0 || base.getDay() === 6) {
        base.setDate(base.getDate() + 1);
      }
      break;
    }
    case 'weekly':
      base.setDate(base.getDate() + 7);
      break;
    case 'monthly':
      base.setMonth(base.getMonth() + 1);
      break;
    case 'custom': {
      if (!recurringInterval) { base.setDate(base.getDate() + 1); break; }
      const num = parseInt(recurringInterval) || 1;
      const unit = recurringInterval.slice(-1);
      if (unit === 'w') base.setDate(base.getDate() + num * 7);
      else if (unit === 'm') base.setMonth(base.getMonth() + num);
      else base.setDate(base.getDate() + num); // default days
      break;
    }
    default:
      base.setDate(base.getDate() + 1);
  }
  return base.getFullYear() + '-' + String(base.getMonth() + 1).padStart(2, '0') + '-' + String(base.getDate()).padStart(2, '0');
}

// Serve static
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Get all todos
app.get('/api/todos', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM todos ORDER BY sort_order ASC, id DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Create todo
app.post('/api/todos', async (req, res) => {
  try {
    const { text, priority = 'none', category = '', due = '', recurring = '', recurring_interval = '' } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO todos (text, priority, category, due, subtasks, recurring, recurring_interval) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [text, priority, category, due, '[]', recurring, recurring_interval]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Update todo
app.patch('/api/todos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { done, sort_order, recurring, recurring_interval } = req.body;

    if (sort_order !== undefined) {
      const { rows } = await pool.query('UPDATE todos SET sort_order=$1 WHERE id=$2 RETURNING *', [sort_order, id]);
      return res.json(rows[0]);
    }

    // Update recurring settings if provided (without changing done status)
    if (done === undefined && (recurring !== undefined || recurring_interval !== undefined)) {
      const current = (await pool.query('SELECT * FROM todos WHERE id=$1', [id])).rows[0];
      if (!current) return res.status(404).json({ error: 'not found' });
      const newRecurring = recurring !== undefined ? recurring : current.recurring;
      const newInterval = recurring_interval !== undefined ? recurring_interval : current.recurring_interval;
      const { rows } = await pool.query(
        'UPDATE todos SET recurring=$1, recurring_interval=$2 WHERE id=$3 RETURNING *',
        [newRecurring, newInterval, id]
      );
      return res.json(rows[0]);
    }

    if (done === undefined) return res.json({ error: 'nothing to update' });

    const completedAt = done ? Date.now() : null;
    const { rows } = await pool.query(
      'UPDATE todos SET done=$1, completed_at=$2 WHERE id=$3 RETURNING *',
      [done, completedAt, id]
    );
    const todo = rows[0];

    // If completing a recurring todo, spawn the next one
    if (done && todo.recurring) {
      const nextDue = calcNextDue(todo.due, todo.recurring, todo.recurring_interval);
      const { rows: spawnedRows } = await pool.query(
        'INSERT INTO todos (text, priority, category, due, subtasks, recurring, recurring_interval) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
        [todo.text, todo.priority, todo.category, nextDue, '[]', todo.recurring, todo.recurring_interval]
      );
      return res.json({ ...todo, spawned: spawnedRows[0] });
    }

    res.json(todo);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete todo
app.delete('/api/todos/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM todos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear done
app.delete('/api/todos', async (req, res) => {
  try {
    await pool.query('DELETE FROM todos WHERE done=true');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Bulk reorder
app.post('/api/todos/reorder', async (req, res) => {
  try {
    const { orders } = req.body;
    for (const o of orders) {
      await pool.query('UPDATE todos SET sort_order=$1 WHERE id=$2', [o.sort_order, o.id]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- Subtask endpoints ---
app.post('/api/todos/:id/subtasks', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;
    const subtask = { id: uuidv4(), text, done: false };
    const { rows } = await pool.query(
      `UPDATE todos SET subtasks = subtasks || $1::jsonb WHERE id=$2 RETURNING *`,
      [JSON.stringify([subtask]), id]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/todos/:id/subtasks/:subtaskId', async (req, res) => {
  try {
    const { id, subtaskId } = req.params;
    const { done, text } = req.body;
    const { rows } = await pool.query('SELECT subtasks FROM todos WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    let subtasks = rows[0].subtasks || [];
    subtasks = subtasks.map(s => {
      if (s.id === subtaskId) {
        if (done !== undefined) s.done = done;
        if (text !== undefined) s.text = text;
      }
      return s;
    });
    const result = await pool.query(
      'UPDATE todos SET subtasks=$1::jsonb WHERE id=$2 RETURNING *',
      [JSON.stringify(subtasks), id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/todos/:id/subtasks/:subtaskId', async (req, res) => {
  try {
    const { id, subtaskId } = req.params;
    const { rows } = await pool.query('SELECT subtasks FROM todos WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const subtasks = (rows[0].subtasks || []).filter(s => s.id !== subtaskId);
    const result = await pool.query(
      'UPDATE todos SET subtasks=$1::jsonb WHERE id=$2 RETURNING *',
      [JSON.stringify(subtasks), id]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Todo server on port ${PORT}`));
}).catch(e => { console.error('DB init failed:', e); process.exit(1); });
