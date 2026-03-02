const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@localhost:5432/drafts';
const JWT_SECRET = process.env.JWT_SECRET || 'drafts-dev-secret-2026';

let pool;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database Init ───────────────────────────────────────────────────────────

async function initDatabase() {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const result = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } finally {
    await adminPool.end();
  }

  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('admin', 'creator', 'user')),
        avatar_color VARCHAR(7) DEFAULT '#6366f1',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS drafts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        content TEXT DEFAULT '',
        type VARCHAR(20) NOT NULL CHECK (type IN ('email', 'todo', 'idea', 'note', 'script')),
        status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'review', 'approved', 'done', 'rejected')),
        priority VARCHAR(10) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
        tags TEXT[] DEFAULT '{}',
        category VARCHAR(100) DEFAULT '',
        metadata JSONB DEFAULT '{}',
        created_by INTEGER REFERENCES users(id),
        assigned_to INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS draft_history (
        id SERIAL PRIMARY KEY,
        draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        action VARCHAR(50) NOT NULL,
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
      CREATE INDEX IF NOT EXISTS idx_drafts_type ON drafts(type);
      CREATE INDEX IF NOT EXISTS idx_drafts_priority ON drafts(priority);
      CREATE INDEX IF NOT EXISTS idx_drafts_created_by ON drafts(created_by);
      CREATE INDEX IF NOT EXISTS idx_drafts_assigned_to ON drafts(assigned_to);
      CREATE INDEX IF NOT EXISTS idx_comments_draft_id ON comments(draft_id);
      CREATE INDEX IF NOT EXISTS idx_draft_history_draft_id ON draft_history(draft_id);

      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        category VARCHAR(100) DEFAULT '',
        body TEXT DEFAULT '',
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
      CREATE INDEX IF NOT EXISTS idx_templates_created_by ON templates(created_by);
    `);

    // Seed default users if they don't exist
    const userCount = await client.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
      const lobstyHash = await bcrypt.hash('***REMOVED***', 10);
      const rayHash = await bcrypt.hash('ray2026', 10);
      await client.query(
        `INSERT INTO users (username, email, password_hash, display_name, role, avatar_color) VALUES
         ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
        [
          'lobsty', 'lobsty@twray.dev', lobstyHash, 'Lobsty', 'creator', '#8b5cf6',
          'ray', 'ray@twray.dev', rayHash, 'Ray', 'admin', '#3b82f6'
        ]
      );
      console.log('Seeded default users: lobsty, ray');
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userRole = decoded.role;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, display_name: user.display_name, role: user.role, avatar_color: user.avatar_color }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, email, display_name, role, avatar_color FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

app.get('/api/stats', authRequired, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'draft') AS drafts,
        COUNT(*) FILTER (WHERE status = 'review') AS in_review,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
        COUNT(*) FILTER (WHERE priority = 'urgent' AND status NOT IN ('done', 'rejected')) AS urgent,
        COUNT(*) AS total
      FROM drafts
    `);
    res.json(stats.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Drafts CRUD ─────────────────────────────────────────────────────────────

app.get('/api/drafts', authRequired, async (req, res) => {
  try {
    const { status, type, priority, search, tag, sort, order, limit, offset } = req.query;
    let where = [];
    let params = [];
    let i = 1;

    if (status) { where.push(`d.status = $${i++}`); params.push(status); }
    if (type) { where.push(`d.type = $${i++}`); params.push(type); }
    if (priority) { where.push(`d.priority = $${i++}`); params.push(priority); }
    if (tag) { where.push(`$${i++} = ANY(d.tags)`); params.push(tag); }
    if (search) {
      where.push(`(d.title ILIKE $${i} OR d.content ILIKE $${i})`);
      params.push(`%${search}%`);
      i++;
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const sortCol = ['created_at', 'updated_at', 'priority', 'title', 'status'].includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const lim = Math.min(parseInt(limit) || 50, 200);
    const off = parseInt(offset) || 0;

    // Priority ordering helper
    const orderBy = sortCol === 'priority'
      ? `CASE d.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END ${sortOrder}`
      : `d.${sortCol} ${sortOrder}`;

    const result = await pool.query(`
      SELECT d.*,
        u1.display_name AS creator_name, u1.avatar_color AS creator_color,
        u2.display_name AS assignee_name, u2.avatar_color AS assignee_color,
        (SELECT COUNT(*) FROM comments c WHERE c.draft_id = d.id) AS comment_count
      FROM drafts d
      LEFT JOIN users u1 ON d.created_by = u1.id
      LEFT JOIN users u2 ON d.assigned_to = u2.id
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${lim} OFFSET ${off}
    `, params);

    const countResult = await pool.query(`SELECT COUNT(*) FROM drafts d ${whereClause}`, params);

    res.json({ drafts: result.rows, total: parseInt(countResult.rows[0].count) });
  } catch (err) {
    console.error('List drafts error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drafts', authRequired, async (req, res) => {
  try {
    const { title, content, type, priority, tags, category, metadata, assigned_to } = req.body;
    if (!title || !type) {
      return res.status(400).json({ error: 'Title and type are required' });
    }
    const validTypes = ['email', 'todo', 'idea', 'note', 'script'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }

    const result = await pool.query(
      `INSERT INTO drafts (title, content, type, priority, tags, category, metadata, created_by, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, content || '', type, priority || 'medium', tags || [], category || '', metadata || {}, req.userId, assigned_to || null]
    );

    // Log history
    await pool.query(
      'INSERT INTO draft_history (draft_id, user_id, action, new_value) VALUES ($1, $2, $3, $4)',
      [result.rows[0].id, req.userId, 'created', `Created ${type}: ${title}`]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create draft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/drafts/:id', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*,
        u1.display_name AS creator_name, u1.avatar_color AS creator_color,
        u2.display_name AS assignee_name, u2.avatar_color AS assignee_color
      FROM drafts d
      LEFT JOIN users u1 ON d.created_by = u1.id
      LEFT JOIN users u2 ON d.assigned_to = u2.id
      WHERE d.id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/drafts/:id', authRequired, async (req, res) => {
  try {
    const { title, content, type, status, priority, tags, category, metadata, assigned_to } = req.body;
    const id = req.params.id;

    // Get current draft for history
    const current = await pool.query('SELECT * FROM drafts WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    const old = current.rows[0];

    const result = await pool.query(
      `UPDATE drafts SET
        title = COALESCE($1, title),
        content = COALESCE($2, content),
        type = COALESCE($3, type),
        status = COALESCE($4, status),
        priority = COALESCE($5, priority),
        tags = COALESCE($6, tags),
        category = COALESCE($7, category),
        metadata = COALESCE($8, metadata),
        assigned_to = COALESCE($9, assigned_to),
        updated_at = NOW()
      WHERE id = $10 RETURNING *`,
      [title, content, type, status, priority, tags, category, metadata, assigned_to, id]
    );

    // Log status changes
    if (status && status !== old.status) {
      await pool.query(
        'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
        [id, req.userId, 'status_change', old.status, status]
      );
    }
    if (title && title !== old.title) {
      await pool.query(
        'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
        [id, req.userId, 'title_change', old.title, title]
      );
    }
    if (content !== undefined && content !== old.content) {
      await pool.query(
        'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
        [id, req.userId, 'content_edit', null, 'Content updated']
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update draft error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/drafts/:id', authRequired, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM drafts WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Quick status update (approve/reject)
app.post('/api/drafts/:id/approve', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE drafts SET status = 'approved', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    await pool.query(
      'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, req.userId, 'status_change', 'review', 'approved']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drafts/:id/reject', authRequired, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await pool.query(
      `UPDATE drafts SET status = 'rejected', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    await pool.query(
      'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, req.userId, 'status_change', 'review', 'rejected']
    );
    if (reason) {
      await pool.query(
        'INSERT INTO comments (draft_id, user_id, content) VALUES ($1, $2, $3)',
        [req.params.id, req.userId, `Rejected: ${reason}`]
      );
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drafts/:id/submit', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE drafts SET status = 'review', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    await pool.query(
      'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, req.userId, 'status_change', 'draft', 'review']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drafts/:id/done', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE drafts SET status = 'done', updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Draft not found' });
    await pool.query(
      'INSERT INTO draft_history (draft_id, user_id, action, old_value, new_value) VALUES ($1, $2, $3, $4, $5)',
      [req.params.id, req.userId, 'status_change', 'approved', 'done']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Comments ────────────────────────────────────────────────────────────────

app.get('/api/drafts/:id/comments', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.*, u.display_name, u.avatar_color
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.draft_id = $1
      ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/drafts/:id/comments', authRequired, async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'Content required' });
    const result = await pool.query(
      `INSERT INTO comments (draft_id, user_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.userId, content]
    );
    const comment = await pool.query(`
      SELECT c.*, u.display_name, u.avatar_color
      FROM comments c JOIN users u ON c.user_id = u.id
      WHERE c.id = $1
    `, [result.rows[0].id]);
    res.status(201).json(comment.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── History ─────────────────────────────────────────────────────────────────

app.get('/api/drafts/:id/history', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT h.*, u.display_name, u.avatar_color
      FROM draft_history h
      JOIN users u ON h.user_id = u.id
      WHERE h.draft_id = $1
      ORDER BY h.created_at DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── All Tags ────────────────────────────────────────────────────────────────

app.get('/api/tags', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT unnest(tags) AS tag FROM drafts ORDER BY tag`);
    res.json(result.rows.map(r => r.tag));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Users list ──────────────────────────────────────────────────────────────

app.get('/api/users', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, display_name, role, avatar_color FROM users ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── Templates CRUD ──────────────────────────────────────────────────────────

app.get('/api/templates', authRequired, async (req, res) => {
  try {
    const { category, search } = req.query;
    let where = [];
    let params = [];
    let i = 1;
    if (category) { where.push(`t.category = $${i++}`); params.push(category); }
    if (search) { where.push(`(t.title ILIKE $${i} OR t.body ILIKE $${i})`); params.push(`%${search}%`); i++; }
    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const result = await pool.query(`
      SELECT t.*, u.display_name AS creator_name, u.avatar_color AS creator_color
      FROM templates t
      LEFT JOIN users u ON t.created_by = u.id
      ${whereClause}
      ORDER BY t.category ASC, t.title ASC
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('List templates error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/templates', authRequired, async (req, res) => {
  try {
    const { title, category, body } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const result = await pool.query(
      `INSERT INTO templates (title, category, body, created_by) VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, category || '', body || '', req.userId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create template error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/templates/:id', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM templates WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/templates/:id', authRequired, async (req, res) => {
  try {
    const { title, category, body } = req.body;
    const result = await pool.query(
      `UPDATE templates SET
        title = COALESCE($1, title),
        category = COALESCE($2, category),
        body = COALESCE($3, body),
        updated_at = NOW()
      WHERE id = $4 RETURNING *`,
      [title, category, body, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update template error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/templates/:id', authRequired, async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM templates WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Template not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/template-categories', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`SELECT DISTINCT category FROM templates WHERE category != '' ORDER BY category`);
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── SPA Fallback ────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────

initDatabase()
  .then(() => {

// Global search endpoint (internal, no auth)
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.json([]);
    const result = await pool.query("SELECT id, title, LEFT(content, 200) as content, status FROM drafts WHERE title ILIKE $1 OR content ILIKE $1 ORDER BY updated_at DESC LIMIT 10", ["%" + q + "%"]);
    res.json(result.rows);
  } catch (error) { res.json([]); }
});

    app.listen(PORT, () => {
      console.log(`Drafts Hub running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
