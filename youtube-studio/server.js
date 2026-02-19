const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://lobsty:***REMOVED***@localhost:5432/youtube_studio";

const pool = new Pool({ connectionString: DATABASE_URL });

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Initialize database
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS videos (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT DEFAULT 'idea',
        upload_date DATE,
        views INTEGER DEFAULT 0,
        ctr DECIMAL(5,2),
        retention DECIMAL(5,2),
        thumbnail_url TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_stats (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL UNIQUE,
        subscribers INTEGER,
        views INTEGER,
        watch_time_hours INTEGER,
        revenue DECIMAL(10,2)
      )
    `);
    
    console.log("✅ Database initialized");
  } finally {
    client.release();
  }
}

// API Routes

// Get all videos
app.get("/api/videos", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM videos ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add video
app.post("/api/videos", async (req, res) => {
  try {
    const { title, status, upload_date, notes } = req.body;
    const result = await pool.query(
      "INSERT INTO videos (title, status, upload_date, notes) VALUES ($1, $2, $3, $4) RETURNING *",
      [title, status || 'idea', upload_date, notes]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update video
app.put("/api/videos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, status, upload_date, views, ctr, retention, notes } = req.body;
    const result = await pool.query(
      `UPDATE videos SET title=$1, status=$2, upload_date=$3, views=$4, ctr=$5, retention=$6, notes=$7 
       WHERE id=$8 RETURNING *`,
      [title, status, upload_date, views, ctr, retention, notes, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete video
app.delete("/api/videos/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM videos WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Channel stats
app.get("/api/stats", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM channel_stats ORDER BY date DESC LIMIT 30");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/stats", async (req, res) => {
  try {
    const { date, subscribers, views, watch_time_hours, revenue } = req.body;
    const result = await pool.query(
      `INSERT INTO channel_stats (date, subscribers, views, watch_time_hours, revenue) 
       VALUES ($1, $2, $3, $4, $5) 
       ON CONFLICT (date) DO UPDATE 
       SET subscribers=$2, views=$3, watch_time_hours=$4, revenue=$5 
       RETURNING *`,
      [date, subscribers, views, watch_time_hours, revenue]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`🎬 YouTube Studio Dashboard running on port ${PORT}`);
  });
});
