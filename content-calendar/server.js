const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  host: process.env.DB_HOST || 'lobsty-postgres',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'content_calendar',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

// Initialize database
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        event_type VARCHAR(50) NOT NULL,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP,
        all_day BOOLEAN DEFAULT false,
        recurring VARCHAR(20),
        color VARCHAR(20),
        youtube_video_id INTEGER,
        status VARCHAR(20) DEFAULT 'planned',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_notes (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        note TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}

initDB();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all events
app.get('/api/events', async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = 'SELECT * FROM events';
    const params = [];
    
    if (start && end) {
      query += ' WHERE start_date >= $1 AND start_date <= $2';
      params.push(start, end);
    }
    
    query += ' ORDER BY start_date ASC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get single event
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const notes = await pool.query('SELECT * FROM event_notes WHERE event_id = $1 ORDER BY created_at DESC', [id]);
    
    res.json({
      ...result.rows[0],
      notes: notes.rows
    });
  } catch (err) {
    console.error('Error fetching event:', err);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Create event
app.post('/api/events', async (req, res) => {
  try {
    const { title, description, event_type, start_date, end_date, all_day, recurring, color, youtube_video_id, status } = req.body;
    
    const result = await pool.query(
      `INSERT INTO events (title, description, event_type, start_date, end_date, all_day, recurring, color, youtube_video_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [title, description, event_type, start_date, end_date, all_day, recurring, color, youtube_video_id, status || 'planned']
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Update event
app.put('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, event_type, start_date, end_date, all_day, recurring, color, youtube_video_id, status } = req.body;
    
    const result = await pool.query(
      `UPDATE events 
       SET title = $1, description = $2, event_type = $3, start_date = $4, end_date = $5, 
           all_day = $6, recurring = $7, color = $8, youtube_video_id = $9, status = $10, updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 RETURNING *`,
      [title, description, event_type, start_date, end_date, all_day, recurring, color, youtube_video_id, status, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating event:', err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Delete event
app.delete('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM events WHERE id = $1 RETURNING *', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json({ message: 'Event deleted successfully' });
  } catch (err) {
    console.error('Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

// Add note to event
app.post('/api/events/:id/notes', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;
    
    const result = await pool.query(
      'INSERT INTO event_notes (event_id, note) VALUES ($1, $2) RETURNING *',
      [id, note]
    );
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error adding note:', err);
    res.status(500).json({ error: 'Failed to add note' });
  }
});

// Delete note
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM event_notes WHERE id = $1', [id]);
    res.json({ message: 'Note deleted successfully' });
  } catch (err) {
    console.error('Error deleting note:', err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalEvents = await pool.query('SELECT COUNT(*) FROM events');
    const byType = await pool.query(`
      SELECT event_type, COUNT(*) as count 
      FROM events 
      GROUP BY event_type 
      ORDER BY count DESC
    `);
    const upcoming = await pool.query(`
      SELECT COUNT(*) FROM events 
      WHERE start_date > CURRENT_TIMESTAMP AND status != 'completed'
    `);
    const thisMonth = await pool.query(`
      SELECT COUNT(*) FROM events 
      WHERE start_date >= date_trunc('month', CURRENT_DATE)
      AND start_date < date_trunc('month', CURRENT_DATE) + interval '1 month'
    `);
    
    res.json({
      total: parseInt(totalEvents.rows[0].count),
      by_type: byType.rows,
      upcoming: parseInt(upcoming.rows[0].count),
      this_month: parseInt(thisMonth.rows[0].count)
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Content Calendar server running on port ${PORT}`);
});
