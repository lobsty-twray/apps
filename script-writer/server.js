const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  host: process.env.DB_HOST || 'lobsty-postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'script_writer',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS templates (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(100),
        structure TEXT NOT NULL,
        tips TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scripts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        video_series VARCHAR(255),
        content TEXT NOT NULL,
        template_used INT REFERENCES templates(id),
        status VARCHAR(50) DEFAULT 'draft',
        word_count INT,
        estimated_duration INT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS script_versions (
        id SERIAL PRIMARY KEY,
        script_id INT REFERENCES scripts(id) ON DELETE CASCADE,
        version_num INT,
        content TEXT NOT NULL,
        changes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Add default templates
    const templatesCheck = await pool.query('SELECT COUNT(*) FROM templates');
    if (parseInt(templatesCheck.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO templates (name, category, structure, tips) VALUES
        ('Review Format', 'reviews', 
         'INTRO:\n- Hook (5 sec)\n- Product name\n- Price\n\nOVERVIEW:\n- Design\n- Build quality\n- Key features\n\nPERFORMANCE:\n- Benchmarks\n- Real-world use\n- Comparison\n\nPROS/CONS:\n- List major pros\n- List cons\n- Overall take\n\nOUTRO:\n- Final recommendation\n- Call to action\n- Subscribe reminder',
         'Keep hooks punchy. Use stats to back claims. Show the product in action.'),
        
        ('Tutorial Format', 'tutorials',
         'INTRO:\n- What you''ll learn\n- Time required\n- Tools/requirements\n\nSTEPS:\n- Break into 3-5 logical steps\n- Explain each thoroughly\n- Visually show progress\n\nTIPS & TRICKS:\n- Common mistakes\n- Pro tips\n- Shortcuts\n\nCONCLUSION:\n- Summary\n- Next steps\n- Resources',
         'Speak clearly. Pause between major steps. Show close-ups for details.'),
        
        ('Unboxing Format', 'unboxing',
         'INTRO:\n- Product excitement\n- What to expect\n- Build anticipation\n\nBOX CONTENTS:\n- Describe packaging\n- List accessories\n- Initial impressions\n\nFIRST LOOK:\n- Design details\n- Materials\n- Aesthetics\n- Size/weight\n\nINITIAL SETUP:\n- Unboxing steps\n- Assembly if needed\n- First run experience\n\nEXPRESSION:\n- First impressions\n- Exciting features\n- Immediate thoughts\n\nOUTRO:\n- Why you''re excited\n- Full review coming\n- Subscribe',
         'Get genuine reactions. Show all angles of the product. Create suspense.')
      `);
    }
    
    console.log('Database initialized');
  } catch (err) {
    console.error('Database error:', err);
  }
}

initDB();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all templates
app.get('/api/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, category FROM templates ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

// Get template detail
app.get('/api/templates/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM templates WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch template' });
  }
});

// Get all scripts
app.get('/api/scripts', async (req, res) => {
  try {
    const { status, series } = req.query;
    let query = 'SELECT id, title, video_series, status, word_count, updated_at FROM scripts';
    const params = [];
    const conditions = [];
    
    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }
    if (series) {
      conditions.push(`video_series ILIKE $${params.length + 1}`);
      params.push(`%${series}%`);
    }
    
    if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY updated_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch scripts' });
  }
});

// Get script detail
app.get('/api/scripts/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM scripts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const versions = await pool.query('SELECT version_num, created_at FROM script_versions WHERE script_id = $1 ORDER BY version_num DESC', [req.params.id]);
    
    res.json({ ...result.rows[0], versions: versions.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch script' });
  }
});

// Create script
app.post('/api/scripts', async (req, res) => {
  try {
    const { title, video_series, content, template_used, status } = req.body;
    const word_count = content.trim().split(/\s+/).length;
    const estimated_duration = Math.ceil(word_count / 130); // ~130 words per minute
    
    const result = await pool.query(
      `INSERT INTO scripts (title, video_series, content, template_used, status, word_count, estimated_duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [title, video_series, content, template_used || null, status || 'draft', word_count, estimated_duration]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create script' });
  }
});

// Update script
app.put('/api/scripts/:id', async (req, res) => {
  try {
    const { title, video_series, content, status } = req.body;
    const word_count = content.trim().split(/\s+/).length;
    const estimated_duration = Math.ceil(word_count / 130);
    
    // Save version
    const scriptData = await pool.query('SELECT * FROM scripts WHERE id = $1', [req.params.id]);
    if (scriptData.rows.length > 0) {
      const maxVersion = await pool.query('SELECT MAX(version_num) as max FROM script_versions WHERE script_id = $1', [req.params.id]);
      const nextVersion = (maxVersion.rows[0].max || 0) + 1;
      
      await pool.query(
        'INSERT INTO script_versions (script_id, version_num, content) VALUES ($1, $2, $3)',
        [req.params.id, nextVersion, scriptData.rows[0].content]
      );
    }
    
    const result = await pool.query(
      `UPDATE scripts SET title = $1, video_series = $2, content = $3, status = $4, word_count = $5, estimated_duration = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 RETURNING *`,
      [title, video_series, content, status, word_count, estimated_duration, req.params.id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update script' });
  }
});

// Delete script
app.delete('/api/scripts/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM scripts WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const scripts = await pool.query('SELECT COUNT(*) FROM scripts');
    const drafts = await pool.query('SELECT COUNT(*) FROM scripts WHERE status = $1', ['draft']);
    const published = await pool.query('SELECT COUNT(*) FROM scripts WHERE status = $1', ['published']);
    const avgWords = await pool.query('SELECT AVG(word_count) as avg FROM scripts');
    
    res.json({
      total_scripts: parseInt(scripts.rows[0].count),
      drafts: parseInt(drafts.rows[0].count),
      published: parseInt(published.rows[0].count),
      avg_word_count: Math.round(avgWords.rows[0].avg || 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Script Writer on port ${PORT}`);
});
