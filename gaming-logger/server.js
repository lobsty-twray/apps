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
  database: process.env.DB_NAME || 'gaming_logger',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        game_name VARCHAR(255) NOT NULL,
        platform VARCHAR(100),
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        duration_minutes INT,
        difficulty VARCHAR(100),
        achievement_score INT,
        fps INT,
        gpu_temp INT,
        cpu_temp INT,
        notes TEXT,
        is_streamed BOOLEAN DEFAULT false,
        content_potential VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS moments (
        id SERIAL PRIMARY KEY,
        session_id INT REFERENCES sessions(id) ON DELETE CASCADE,
        timestamp TIMESTAMP NOT NULL,
        description TEXT,
        is_clip BOOLEAN DEFAULT false,
        clip_url VARCHAR(500),
        category VARCHAR(100),
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

// Get all sessions
app.get('/api/sessions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sessions ORDER BY start_time DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Get session with moments
app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    
    const moments = await pool.query('SELECT * FROM moments WHERE session_id = $1 ORDER BY timestamp', [req.params.id]);
    
    res.json({ ...session.rows[0], moments: moments.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Create session
app.post('/api/sessions', async (req, res) => {
  try {
    const { game_name, platform, start_time, end_time, difficulty, achievement_score, fps, gpu_temp, cpu_temp, notes, is_streamed, content_potential } = req.body;
    
    const startTime = new Date(start_time);
    const endTime = end_time ? new Date(end_time) : new Date();
    const durationMinutes = Math.round((endTime - startTime) / 60000);
    
    const result = await pool.query(
      `INSERT INTO sessions (game_name, platform, start_time, end_time, duration_minutes, difficulty, achievement_score, fps, gpu_temp, cpu_temp, notes, is_streamed, content_potential)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [game_name, platform, start_time, end_time, durationMinutes, difficulty, achievement_score, fps, gpu_temp, cpu_temp, notes, is_streamed || false, content_potential]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Update session
app.put('/api/sessions/:id', async (req, res) => {
  try {
    const { game_name, platform, start_time, end_time, difficulty, achievement_score, fps, gpu_temp, cpu_temp, notes, is_streamed, content_potential } = req.body;
    const result = await pool.query(
      `UPDATE sessions SET game_name = $1, platform = $2, start_time = $3, end_time = $4, difficulty = $5, achievement_score = $6, fps = $7, gpu_temp = $8, cpu_temp = $9, notes = $10, is_streamed = $11, content_potential = $12
       WHERE id = $13 RETURNING *`,
      [game_name, platform, start_time, end_time, difficulty, achievement_score, fps, gpu_temp, cpu_temp, notes, is_streamed, content_potential, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Delete session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

// Add moment
app.post('/api/moments', async (req, res) => {
  try {
    const { session_id, timestamp, description, is_clip, clip_url, category } = req.body;
    const result = await pool.query(
      `INSERT INTO moments (session_id, timestamp, description, is_clip, clip_url, category)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session_id, timestamp, description, is_clip || false, clip_url, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add moment' });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalSessions = await pool.query('SELECT COUNT(*) FROM sessions');
    const totalMinutes = await pool.query('SELECT SUM(duration_minutes) FROM sessions');
    const favoriteGame = await pool.query('SELECT game_name, COUNT(*) as plays FROM sessions GROUP BY game_name ORDER BY plays DESC LIMIT 1');
    const avgFps = await pool.query('SELECT AVG(fps) as avg FROM sessions WHERE fps IS NOT NULL');
    const contentReady = await pool.query("SELECT COUNT(*) FROM sessions WHERE content_potential = 'high'");
    
    res.json({
      total_sessions: parseInt(totalSessions.rows[0].count),
      total_minutes: parseInt(totalMinutes.rows[0].sum || 0),
      favorite_game: favoriteGame.rows[0]?.game_name || 'N/A',
      avg_fps: Math.round(avgFps.rows[0].avg || 0),
      high_content_potential: parseInt(contentReady.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Gaming Logger on port ${PORT}`);
});
