const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : new Pool({
  host: process.env.DB_HOST || 'lobsty-postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'content_ideas',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ideas (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        tags VARCHAR(255),
        priority VARCHAR(50),
        status VARCHAR(50) DEFAULT 'brainstorm',
        notes TEXT,
        source VARCHAR(255),
        research_links TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        idea_id INT REFERENCES ideas(id) ON DELETE CASCADE,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database initialized');
  } catch (err) {
    console.error('Database error:', err);
  }
}

initDB();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all ideas
app.get('/api/ideas', async (req, res) => {
  try {
    const { category, priority, status } = req.query;
    let query = 'SELECT * FROM ideas';
    const params = [];
    const conditions = [];
    
    if (category) {
      conditions.push(`category = $${params.length + 1}`);
      params.push(category);
    }
    if (priority) {
      conditions.push(`priority = $${params.length + 1}`);
      params.push(priority);
    }
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY updated_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch ideas' });
  }
});

// Get random idea (not published)
app.get("/api/ideas/random", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM ideas WHERE status != 'published' ORDER BY RANDOM() LIMIT 1");
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch random idea" });
  }
});

// Get single idea with comments
app.get('/api/ideas/:id', async (req, res) => {
  try {
    const idea = await pool.query('SELECT * FROM ideas WHERE id = $1', [req.params.id]);
    if (idea.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const comments = await pool.query('SELECT * FROM comments WHERE idea_id = $1 ORDER BY created_at DESC', [req.params.id]);
    
    res.json({ ...idea.rows[0], comments: comments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch idea' });
  }
});

// Create idea
app.post('/api/ideas', async (req, res) => {
  try {
    const { title, description, category, tags, priority, status, notes, source, research_links } = req.body;
    const result = await pool.query(
      `INSERT INTO ideas (title, description, category, tags, priority, status, notes, source, research_links)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [title, description, category, tags, priority || 'medium', status || 'brainstorm', notes, source, research_links]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create idea' });
  }
});

// Update idea
app.put('/api/ideas/:id', async (req, res) => {
  try {
    const { title, description, category, tags, priority, status, notes, source, research_links } = req.body;
    const result = await pool.query(
      `UPDATE ideas SET title = $1, description = $2, category = $3, tags = $4, priority = $5, status = $6, notes = $7, source = $8, research_links = $9, updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 RETURNING *`,
      [title, description, category, tags, priority, status, notes, source, research_links, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update idea' });
  }
});

// Delete idea
app.delete('/api/ideas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM ideas WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Add comment
app.post('/api/ideas/:id/comments', async (req, res) => {
  try {
    const { comment } = req.body;
    const result = await pool.query(
      'INSERT INTO comments (idea_id, comment) VALUES ($1, $2) RETURNING *',
      [req.params.id, comment]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM ideas');
    const byStatus = await pool.query('SELECT status, COUNT(*) as count FROM ideas GROUP BY status');
    const highPriority = await pool.query("SELECT COUNT(*) FROM ideas WHERE priority = 'high'");
    const categories = await pool.query('SELECT DISTINCT category FROM ideas WHERE category IS NOT NULL');
    
    res.json({
      total: parseInt(total.rows[0].count),
      by_status: byStatus.rows,
      high_priority: parseInt(highPriority.rows[0].count),
      categories: categories.rows.map(r => r.category)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});


// Global search endpoint (internal, no auth)
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.json([]);
    const result = await pool.query("SELECT id, title, description, category, status FROM ideas WHERE title ILIKE $1 OR description ILIKE $1 ORDER BY created_at DESC LIMIT 10", ["%" + q + "%"]);
    res.json(result.rows);
  } catch (error) { res.json([]); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Content Ideas on port ${PORT}`);
});
