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
  database: process.env.DB_NAME || 'stream_planner',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS streams (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        scheduled_time TIMESTAMP NOT NULL,
        duration_minutes INT,
        game VARCHAR(255),
        category VARCHAR(100),
        expected_viewers INT,
        status VARCHAR(50) DEFAULT 'scheduled',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platforms (
        id SERIAL PRIMARY KEY,
        stream_id INT REFERENCES streams(id) ON DELETE CASCADE,
        platform VARCHAR(100) NOT NULL,
        platform_url VARCHAR(500),
        stream_key VARCHAR(255),
        custom_title VARCHAR(255),
        custom_description TEXT,
        is_live BOOLEAN DEFAULT false,
        actual_viewers INT,
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

// Get all streams
app.get('/api/streams', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM streams ORDER BY scheduled_time DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch streams' });
  }
});

// Get stream with platforms
app.get('/api/streams/:id', async (req, res) => {
  try {
    const stream = await pool.query('SELECT * FROM streams WHERE id = $1', [req.params.id]);
    if (stream.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const platforms = await pool.query('SELECT * FROM platforms WHERE stream_id = $1', [req.params.id]);
    
    res.json({ ...stream.rows[0], platforms: platforms.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stream' });
  }
});

// Create stream
app.post('/api/streams', async (req, res) => {
  try {
    const { title, description, scheduled_time, duration_minutes, game, category, expected_viewers, notes } = req.body;
    
    const result = await pool.query(
      `INSERT INTO streams (title, description, scheduled_time, duration_minutes, game, category, expected_viewers, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [title, description, scheduled_time, duration_minutes, game, category, expected_viewers, notes]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create stream' });
  }
});

// Update stream
app.put('/api/streams/:id', async (req, res) => {
  try {
    const { title, description, scheduled_time, duration_minutes, game, category, expected_viewers, status, notes } = req.body;
    
    const result = await pool.query(
      `UPDATE streams SET title = $1, description = $2, scheduled_time = $3, duration_minutes = $4, game = $5, category = $6, expected_viewers = $7, status = $8, notes = $9
       WHERE id = $10 RETURNING *`,
      [title, description, scheduled_time, duration_minutes, game, category, expected_viewers, status, notes, req.params.id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update stream' });
  }
});

// Add platform to stream
app.post('/api/platforms', async (req, res) => {
  try {
    const { stream_id, platform, platform_url, stream_key, custom_title, custom_description } = req.body;
    
    const result = await pool.query(
      `INSERT INTO platforms (stream_id, platform, platform_url, stream_key, custom_title, custom_description)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [stream_id, platform, platform_url, stream_key, custom_title, custom_description]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add platform' });
  }
});

// Get upcoming streams (next 7 days)
app.get('/api/upcoming', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM streams 
      WHERE scheduled_time > CURRENT_TIMESTAMP 
      AND scheduled_time <= CURRENT_TIMESTAMP + INTERVAL '7 days'
      ORDER BY scheduled_time ASC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch upcoming streams' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalStreams = await pool.query('SELECT COUNT(*) FROM streams');
    const upcomingStreams = await pool.query(`SELECT COUNT(*) FROM streams WHERE scheduled_time > CURRENT_TIMESTAMP`);
    const completedStreams = await pool.query(`SELECT COUNT(*) FROM streams WHERE status = 'completed'`);
    const avgExpectedViewers = await pool.query('SELECT AVG(expected_viewers) FROM streams WHERE expected_viewers IS NOT NULL');
    const platformsCount = await pool.query('SELECT COUNT(DISTINCT platform) FROM platforms');
    
    res.json({
      total_streams: parseInt(totalStreams.rows[0].count),
      upcoming: parseInt(upcomingStreams.rows[0].count),
      completed: parseInt(completedStreams.rows[0].count),
      avg_viewers: Math.round(avgExpectedViewers.rows[0].avg || 0),
      platforms: parseInt(platformsCount.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stream Planner on port ${PORT}`);
});
