const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'video-pipeline-dev-secret-2026';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@localhost:5432/video-pipeline';

let pool;

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== FILE UPLOAD ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ext);
  }
});

// ==================== DATABASE INIT ====================
async function initDatabase() {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const result = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } catch (err) {
    console.log('Database check/create note:', err.message);
  } finally {
    await adminPool.end();
  }

  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        stage TEXT NOT NULL DEFAULT 'ideas',
        priority TEXT DEFAULT 'medium',
        thumbnail_url TEXT,
        youtube_url TEXT,
        youtube_id TEXT,
        due_date DATE,
        published_at TIMESTAMPTZ,
        position INTEGER DEFAULT 0,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_tags (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        UNIQUE(video_id, tag)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_notes (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_checklist (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        item TEXT NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        position INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        deliverables TEXT,
        due_date DATE,
        amount DECIMAL(10,2),
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS video_analytics (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        views INTEGER DEFAULT 0,
        watch_time_hours DECIMAL(10,2) DEFAULT 0,
        ctr DECIMAL(5,2) DEFAULT 0,
        revenue DECIMAL(10,2) DEFAULT 0,
        synced_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(video_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        action TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);



    await client.query(`
      CREATE TABLE IF NOT EXISTS time_entries (
        id SERIAL PRIMARY KEY,
        video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
        stage TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        note TEXT,
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed default admin user
    const existing = await client.query('SELECT id FROM users WHERE email = $1', ['ray@twray.dev']);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('admin2026', 10);
      await client.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)',
        ['ray@twray.dev', 'Ray', hash]
      );
      console.log('Created default admin user: ray@twray.dev');
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

// ==================== AUTH MIDDLEWARE ====================
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ==================== AUTH ROUTES ====================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== VIDEO ROUTES ====================
app.get('/api/videos', authRequired, async (req, res) => {
  try {
    const { stage, tag, search, sort } = req.query;
    let query = `
      SELECT v.*,
        COALESCE(json_agg(DISTINCT vt.tag) FILTER (WHERE vt.tag IS NOT NULL), '[]') as tags,
        (SELECT COUNT(*) FROM video_checklist vc WHERE vc.video_id = v.id) as checklist_total,
        (SELECT COUNT(*) FROM video_checklist vc WHERE vc.video_id = v.id AND vc.completed = true) as checklist_done
      FROM videos v
      LEFT JOIN video_tags vt ON vt.video_id = v.id
    `;
    const conditions = [];
    const params = [];

    if (stage) {
      params.push(stage);
      conditions.push(`v.stage = $${params.length}`);
    }
    if (tag) {
      params.push(tag);
      conditions.push(`EXISTS (SELECT 1 FROM video_tags vt2 WHERE vt2.video_id = v.id AND vt2.tag = $${params.length})`);
    }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' GROUP BY v.id';

    const orderBy = sort === 'due_date' ? 'v.due_date ASC NULLS LAST' :
                    sort === 'title' ? 'v.title ASC' :
                    sort === 'priority' ? "CASE v.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END" :
                    'v.position ASC, v.created_at DESC';
    query += ` ORDER BY ${orderBy}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/videos/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const video = await pool.query(`
      SELECT v.*,
        COALESCE(json_agg(DISTINCT vt.tag) FILTER (WHERE vt.tag IS NOT NULL), '[]') as tags
      FROM videos v
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      WHERE v.id = $1
      GROUP BY v.id
    `, [id]);
    if (video.rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const [checklist, notes, sponsors, analytics, activity] = await Promise.all([
      pool.query('SELECT * FROM video_checklist WHERE video_id = $1 ORDER BY position, id', [id]),
      pool.query('SELECT vn.*, u.name as author_name FROM video_notes vn LEFT JOIN users u ON u.id = vn.created_by WHERE vn.video_id = $1 ORDER BY vn.created_at DESC', [id]),
      pool.query('SELECT * FROM sponsors WHERE video_id = $1', [id]),
      pool.query('SELECT * FROM video_analytics WHERE video_id = $1', [id]),
      pool.query('SELECT al.*, u.name as user_name FROM activity_log al LEFT JOIN users u ON u.id = al.user_id WHERE al.video_id = $1 ORDER BY al.created_at DESC LIMIT 20', [id])
    ]);

    res.json({
      ...video.rows[0],
      checklist: checklist.rows,
      notes: notes.rows,
      sponsors: sponsors.rows,
      analytics: analytics.rows[0] || null,
      activity: activity.rows
    });
  } catch (err) {
    console.error('Error fetching video:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos', authRequired, async (req, res) => {
  try {
    const { title, description, stage, priority, due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });

    const maxPos = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM videos WHERE stage = $1',
      [stage || 'ideas']
    );

    const result = await pool.query(
      `INSERT INTO videos (title, description, stage, priority, due_date, position, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, description || '', stage || 'ideas', priority || 'medium', due_date || null, maxPos.rows[0].next_pos, req.userId]
    );

    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [result.rows[0].id, req.userId, 'created', `Created video "${title}"`]
    );

    // Add default checklist items
    const defaultChecklist = [
      'Script written', 'Sponsor brief reviewed', 'Footage captured',
      'Edited', 'Thumbnail created', 'SEO optimized', 'Scheduled'
    ];
    for (let i = 0; i < defaultChecklist.length; i++) {
      await pool.query(
        'INSERT INTO video_checklist (video_id, item, position) VALUES ($1, $2, $3)',
        [result.rows[0].id, defaultChecklist[i], i]
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating video:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/videos/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, stage, priority, due_date, youtube_url, youtube_id, published_at } = req.body;

    const current = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const result = await pool.query(
      `UPDATE videos SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        stage = COALESCE($3, stage),
        priority = COALESCE($4, priority),
        due_date = $5,
        youtube_url = COALESCE($6, youtube_url),
        youtube_id = COALESCE($7, youtube_id),
        published_at = $8,
        updated_at = NOW()
      WHERE id = $9 RETURNING *`,
      [title, description, stage, priority, due_date || null, youtube_url, youtube_id, published_at || null, id]
    );

    // Log stage change
    if (stage && stage !== current.rows[0].stage) {
      await pool.query(
        'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
        [id, req.userId, 'stage_changed', `Moved from ${current.rows[0].stage} to ${stage}`]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating video:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/videos/:id', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM videos WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting video:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/videos/:id/stage', authRequired, async (req, res) => {
  try {
    const { id } = req.params;
    const { stage, position } = req.body;
    if (!stage) return res.status(400).json({ error: 'Stage is required' });

    const current = await pool.query('SELECT * FROM videos WHERE id = $1', [id]);
    if (current.rows.length === 0) return res.status(404).json({ error: 'Video not found' });

    const updates = { stage };
    if (stage === 'published' && !current.rows[0].published_at) {
      updates.published_at = new Date();
    }

    const result = await pool.query(
      `UPDATE videos SET stage = $1, position = $2, published_at = COALESCE($3, published_at), updated_at = NOW()
       WHERE id = $4 RETURNING *`,
      [stage, position !== undefined ? position : 0, updates.published_at || null, id]
    );

    if (stage !== current.rows[0].stage) {
      await pool.query(
        'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
        [id, req.userId, 'stage_changed', `Moved from ${current.rows[0].stage} to ${stage}`]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating stage:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Bulk reorder videos
app.patch('/api/videos/reorder', authRequired, async (req, res) => {
  try {
    const { updates } = req.body; // [{id, stage, position}]
    if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'Updates array required' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { id, stage, position } of updates) {
        await client.query(
          'UPDATE videos SET stage = COALESCE($1, stage), position = $2, updated_at = NOW() WHERE id = $3',
          [stage, position, id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Error reordering:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Upload thumbnail
app.post('/api/videos/:id/thumbnail', authRequired, upload.single('thumbnail'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const thumbnailUrl = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE videos SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2', [thumbnailUrl, req.params.id]);
    res.json({ thumbnail_url: thumbnailUrl });
  } catch (err) {
    console.error('Error uploading thumbnail:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== TAGS ROUTES ====================
app.get('/api/videos/:id/tags', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM video_tags WHERE video_id = $1', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos/:id/tags', authRequired, async (req, res) => {
  try {
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ error: 'Tag is required' });
    const result = await pool.query(
      'INSERT INTO video_tags (video_id, tag) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *',
      [req.params.id, tag.toLowerCase()]
    );
    res.status(201).json(result.rows[0] || { video_id: parseInt(req.params.id), tag: tag.toLowerCase() });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/videos/:id/tags/:tag', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM video_tags WHERE video_id = $1 AND tag = $2', [req.params.id, req.params.tag]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== NOTES ROUTES ====================
app.get('/api/videos/:id/notes', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT vn.*, u.name as author_name FROM video_notes vn LEFT JOIN users u ON u.id = vn.created_by WHERE vn.video_id = $1 ORDER BY vn.created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos/:id/notes', authRequired, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return res.status(400).json({ error: 'Note is required' });
    const result = await pool.query(
      'INSERT INTO video_notes (video_id, note, created_by) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, note, req.userId]
    );
    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.params.id, req.userId, 'note_added', 'Added a note']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/notes/:id', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM video_notes WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== CHECKLIST ROUTES ====================
app.get('/api/videos/:id/checklist', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM video_checklist WHERE video_id = $1 ORDER BY position, id', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos/:id/checklist', authRequired, async (req, res) => {
  try {
    const { item } = req.body;
    if (!item) return res.status(400).json({ error: 'Item is required' });
    const maxPos = await pool.query('SELECT COALESCE(MAX(position), -1) + 1 as next_pos FROM video_checklist WHERE video_id = $1', [req.params.id]);
    const result = await pool.query(
      'INSERT INTO video_checklist (video_id, item, position) VALUES ($1, $2, $3) RETURNING *',
      [req.params.id, item, maxPos.rows[0].next_pos]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/checklist/:id', authRequired, async (req, res) => {
  try {
    const { completed } = req.body;
    const result = await pool.query(
      'UPDATE video_checklist SET completed = $1 WHERE id = $2 RETURNING *',
      [completed, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    // Log activity
    const item = result.rows[0];
    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [item.video_id, req.userId, completed ? 'checklist_completed' : 'checklist_uncompleted', item.item]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/checklist/:id', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM video_checklist WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== SPONSOR ROUTES ====================
app.get('/api/videos/:id/sponsors', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sponsors WHERE video_id = $1', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos/:id/sponsors', authRequired, async (req, res) => {
  try {
    const { name, deliverables, due_date, amount, status } = req.body;
    if (!name) return res.status(400).json({ error: 'Sponsor name is required' });
    const result = await pool.query(
      'INSERT INTO sponsors (video_id, name, deliverables, due_date, amount, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.params.id, name, deliverables || '', due_date || null, amount || 0, status || 'pending']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/sponsors/:id', authRequired, async (req, res) => {
  try {
    const { name, deliverables, due_date, amount, status } = req.body;
    const result = await pool.query(
      `UPDATE sponsors SET name = COALESCE($1, name), deliverables = COALESCE($2, deliverables),
       due_date = $3, amount = COALESCE($4, amount), status = COALESCE($5, status)
       WHERE id = $6 RETURNING *`,
      [name, deliverables, due_date || null, amount, status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Sponsor not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/sponsors/:id', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM sponsors WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== ANALYTICS ROUTES ====================
app.get('/api/analytics/summary', authRequired, async (req, res) => {
  try {
    const [totalVideos, stageCount, publishedStats, recentActivity] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM videos'),
      pool.query("SELECT stage, COUNT(*) as count FROM videos GROUP BY stage"),
      pool.query(`
        SELECT
          COUNT(*) as published_count,
          COALESCE(SUM(va.views), 0) as total_views,
          COALESCE(AVG(va.watch_time_hours), 0) as avg_watch_time,
          COALESCE(AVG(va.ctr), 0) as avg_ctr,
          COALESCE(SUM(va.revenue), 0) as total_revenue
        FROM videos v
        LEFT JOIN video_analytics va ON va.video_id = v.id
        WHERE v.stage = 'published'
      `),
      pool.query(`
        SELECT al.*, u.name as user_name, v.title as video_title
        FROM activity_log al
        LEFT JOIN users u ON u.id = al.user_id
        LEFT JOIN videos v ON v.id = al.video_id
        ORDER BY al.created_at DESC LIMIT 10
      `)
    ]);

    const stageMap = {};
    stageCount.rows.forEach(r => { stageMap[r.stage] = parseInt(r.count); });

    res.json({
      total_videos: parseInt(totalVideos.rows[0].count),
      stages: stageMap,
      published: publishedStats.rows[0],
      recent_activity: recentActivity.rows
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/videos/:id/analytics', authRequired, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM video_analytics WHERE video_id = $1', [req.params.id]);
    res.json(result.rows[0] || { views: 0, watch_time_hours: 0, ctr: 0, revenue: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/videos/:id/analytics', authRequired, async (req, res) => {
  try {
    const { views, watch_time_hours, ctr, revenue } = req.body;
    const result = await pool.query(
      `INSERT INTO video_analytics (video_id, views, watch_time_hours, ctr, revenue)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (video_id) DO UPDATE SET
         views = COALESCE($2, video_analytics.views),
         watch_time_hours = COALESCE($3, video_analytics.watch_time_hours),
         ctr = COALESCE($4, video_analytics.ctr),
         revenue = COALESCE($5, video_analytics.revenue),
         synced_at = NOW()
       RETURNING *`,
      [req.params.id, views || 0, watch_time_hours || 0, ctr || 0, revenue || 0]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== EXPORT ====================
app.get('/api/export/csv', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.title, v.stage, v.priority, v.due_date, v.created_at,
        COALESCE(string_agg(DISTINCT vt.tag, ', '), '') as tags,
        va.views, va.watch_time_hours, va.ctr, va.revenue
      FROM videos v
      LEFT JOIN video_tags vt ON vt.video_id = v.id
      LEFT JOIN video_analytics va ON va.video_id = v.id
      GROUP BY v.id, va.views, va.watch_time_hours, va.ctr, va.revenue
      ORDER BY v.created_at DESC
    `);

    let csv = 'Title,Stage,Priority,Due Date,Created,Tags,Views,Watch Time (hrs),CTR,Revenue\n';
    result.rows.forEach(r => {
      csv += `"${(r.title || '').replace(/"/g, '""')}","${r.stage}","${r.priority}","${r.due_date || ''}","${r.created_at}","${r.tags}","${r.views || 0}","${r.watch_time_hours || 0}","${r.ctr || 0}","${r.revenue || 0}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=video-pipeline-export.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// ==================== TIME TRACKING ROUTES ====================
// Start timer
app.post('/api/videos/:id/time/start', authRequired, async (req, res) => {
  try {
    const { stage, note } = req.body;
    if (!stage) return res.status(400).json({ error: 'Stage is required' });
    // Check for existing active timer on this video
    const active = await pool.query(
      'SELECT * FROM time_entries WHERE video_id = $1 AND ended_at IS NULL',
      [req.params.id]
    );
    if (active.rows.length > 0) {
      return res.status(409).json({ error: 'Timer already running', active: active.rows[0] });
    }
    const result = await pool.query(
      'INSERT INTO time_entries (video_id, stage, started_at, note, created_by) VALUES ($1, $2, NOW(), $3, $4) RETURNING *',
      [req.params.id, stage, note || null, req.userId]
    );
    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.params.id, req.userId, 'timer_started', `Started ${stage} timer`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error starting timer:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Stop timer
app.post('/api/videos/:id/time/stop', authRequired, async (req, res) => {
  try {
    const active = await pool.query(
      'SELECT * FROM time_entries WHERE video_id = $1 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [req.params.id]
    );
    if (active.rows.length === 0) {
      return res.status(404).json({ error: 'No active timer' });
    }
    const entry = active.rows[0];
    const result = await pool.query(
      `UPDATE time_entries SET ended_at = NOW(), duration_seconds = EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER WHERE id = $1 RETURNING *`,
      [entry.id]
    );
    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.params.id, req.userId, 'timer_stopped', `Stopped ${entry.stage} timer`]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error stopping timer:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get time entries for a video
app.get('/api/videos/:id/time', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT te.*, u.name as created_by_name FROM time_entries te LEFT JOIN users u ON u.id = te.created_by WHERE te.video_id = $1 ORDER BY te.started_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching time entries:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete time entry
app.delete('/api/videos/:id/time/:entryId', authRequired, async (req, res) => {
  try {
    await pool.query('DELETE FROM time_entries WHERE id = $1 AND video_id = $2', [req.params.entryId, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting time entry:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Time summary across all videos
app.get('/api/time/summary', authRequired, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT v.id as video_id, v.title,
        COALESCE(SUM(te.duration_seconds), 0) as total_seconds,
        json_agg(json_build_object('stage', te.stage, 'seconds', te.duration_seconds) ORDER BY te.stage) FILTER (WHERE te.duration_seconds IS NOT NULL) as stage_breakdown
      FROM videos v
      LEFT JOIN time_entries te ON te.video_id = v.id AND te.ended_at IS NOT NULL
      GROUP BY v.id, v.title
      HAVING COALESCE(SUM(te.duration_seconds), 0) > 0
      ORDER BY total_seconds DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching time summary:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Manual time entry
app.post('/api/videos/:id/time/manual', authRequired, async (req, res) => {
  try {
    const { stage, duration_seconds, note } = req.body;
    if (!stage || !duration_seconds) return res.status(400).json({ error: 'Stage and duration required' });
    const started = new Date();
    const ended = new Date(started.getTime() - duration_seconds * 1000);
    const result = await pool.query(
      'INSERT INTO time_entries (video_id, stage, started_at, ended_at, duration_seconds, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [req.params.id, stage, ended, started, duration_seconds, note || null, req.userId]
    );
    await pool.query(
      'INSERT INTO activity_log (video_id, user_id, action, details) VALUES ($1, $2, $3, $4)',
      [req.params.id, req.userId, 'time_manual', `Added manual ${stage} entry`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding manual time:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ==================== SPA FALLBACK ====================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== STARTUP ====================
async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`Video Pipeline Manager running on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
