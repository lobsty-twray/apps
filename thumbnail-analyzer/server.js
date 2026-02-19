const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST || 'lobsty-postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'thumbnail_analyzer',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS thumbnails (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        video_series VARCHAR(100),
        image_filename VARCHAR(255),
        design_elements VARCHAR(500),
        colors VARCHAR(255),
        text_size VARCHAR(50),
        text_clarity VARCHAR(50),
        test_status VARCHAR(50) DEFAULT 'draft',
        ctr_estimate DECIMAL(5, 2),
        brightness INT,
        contrast INT,
        click_count INT DEFAULT 0,
        impression_count INT DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS design_templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        preview_url VARCHAR(500),
        description TEXT,
        recommended_colors VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add templates
    const templatesCheck = await pool.query('SELECT COUNT(*) FROM design_templates');
    if (parseInt(templatesCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO design_templates (name, category, description, recommended_colors) VALUES
        ('Bold Text', 'text', 'Large text with strong contrast', 'White text, dark background'),
        ('Face Focus', 'style', 'Big face, minimal text', 'Red/yellow accents'),
        ('Contrast Play', 'style', 'High saturation colors', 'Neon/bright colors'),
        ('Minimalist', 'style', 'Clean, simple design', 'White, black, one accent'),
        ('Split Screen', 'layout', 'Before/after comparison', 'Contrasting halves'),
        ('Corner Image', 'layout', 'Main text + corner graphic', 'Any palette'),
        ('Bold Numbers', 'text', 'Large stats or rankings', 'Gold/red numbers'),
        ('Question Hook', 'text', 'Question text to intrigue', 'High contrast text')
      `);
    }
    
    console.log('Database initialized');
  } catch (err) {
    console.error('Database error:', err);
  }
}

initDB();

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Create uploads directory
if (!fs.existsSync('public/uploads')) {
  fs.mkdirSync('public/uploads', { recursive: true });
}

// Get all thumbnails
app.get('/api/thumbnails', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM thumbnails ORDER BY updated_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thumbnails' });
  }
});

// Get single thumbnail
app.get('/api/thumbnails/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM thumbnails WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch thumbnail' });
  }
});

// Create thumbnail
app.post('/api/thumbnails', async (req, res) => {
  try {
    const { title, video_series, design_elements, colors, text_size, text_clarity, test_status, ctr_estimate, brightness, contrast, notes } = req.body;
    
    const result = await pool.query(
      `INSERT INTO thumbnails (title, video_series, design_elements, colors, text_size, text_clarity, test_status, ctr_estimate, brightness, contrast, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [title, video_series, design_elements, colors, text_size, text_clarity, test_status || 'draft', ctr_estimate, brightness, contrast, notes]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create thumbnail' });
  }
});

// Update thumbnail
app.put('/api/thumbnails/:id', async (req, res) => {
  try {
    const { title, video_series, design_elements, colors, text_size, text_clarity, test_status, ctr_estimate, brightness, contrast, click_count, impression_count, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE thumbnails SET title = $1, video_series = $2, design_elements = $3, colors = $4, text_size = $5, text_clarity = $6, test_status = $7, ctr_estimate = $8, brightness = $9, contrast = $10, click_count = $11, impression_count = $12, notes = $13, updated_at = CURRENT_TIMESTAMP
       WHERE id = $14 RETURNING *`,
      [title, video_series, design_elements, colors, text_size, text_clarity, test_status, ctr_estimate, brightness, contrast, click_count, impression_count, notes, req.params.id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update thumbnail' });
  }
});

// Get templates
app.get('/api/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM design_templates ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM thumbnails');
    const testing = await pool.query("SELECT COUNT(*) FROM thumbnails WHERE test_status = 'testing'");
    const avgCTR = await pool.query('SELECT AVG(ctr_estimate) FROM thumbnails WHERE ctr_estimate IS NOT NULL');
    const topPerformer = await pool.query('SELECT * FROM thumbnails WHERE click_count > 0 ORDER BY (click_count::float / NULLIF(impression_count, 0)) DESC LIMIT 1');
    
    res.json({
      total: parseInt(total.rows[0].count),
      testing: parseInt(testing.rows[0].count),
      avg_estimated_ctr: parseFloat(avgCTR.rows[0].avg || 0).toFixed(2),
      top_performer: topPerformer.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Thumbnail Analyzer on port ${PORT}`);
});
