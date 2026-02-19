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
  database: process.env.DB_NAME || 'benchmark_tracker',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS benchmarks (
        id SERIAL PRIMARY KEY,
        test_name VARCHAR(255) NOT NULL,
        gpu_model VARCHAR(255),
        gpu_memory INT,
        cpu_model VARCHAR(255),
        ram_gb INT,
        driver_version VARCHAR(50),
        software VARCHAR(255),
        score FLOAT NOT NULL,
        fps FLOAT,
        power_usage INT,
        temperature INT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS benchmark_series (
        id SERIAL PRIMARY KEY,
        test_name VARCHAR(255) NOT NULL,
        total_benchmarks INT DEFAULT 0,
        avg_score FLOAT,
        max_score FLOAT,
        min_score FLOAT,
        last_run TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    console.log('Database initialized');
  } catch (err) {
    console.error('Database init error:', err);
  }
}

initDB();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all benchmarks
app.get('/api/benchmarks', async (req, res) => {
  try {
    const { testName } = req.query;
    let query = 'SELECT * FROM benchmarks';
    const params = [];
    
    if (testName) {
      query += ' WHERE test_name ILIKE $1';
      params.push(`%${testName}%`);
    }
    
    query += ' ORDER BY created_at DESC';
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Failed to fetch benchmarks' });
  }
});

// Get benchmark series
app.get('/api/series', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM benchmark_series ORDER BY last_run DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch series' });
  }
});

// Add benchmark
app.post('/api/benchmarks', async (req, res) => {
  try {
    const { test_name, gpu_model, gpu_memory, cpu_model, ram_gb, driver_version, software, score, fps, power_usage, temperature, notes } = req.body;
    
    const result = await pool.query(
      `INSERT INTO benchmarks (test_name, gpu_model, gpu_memory, cpu_model, ram_gb, driver_version, software, score, fps, power_usage, temperature, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [test_name, gpu_model, gpu_memory, cpu_model, ram_gb, driver_version, software, score, fps, power_usage, temperature, notes]
    );
    
    // Update series
    const seriesCheck = await pool.query('SELECT id FROM benchmark_series WHERE test_name = $1', [test_name]);
    if (seriesCheck.rows.length === 0) {
      await pool.query(
        'INSERT INTO benchmark_series (test_name, total_benchmarks, avg_score, max_score, min_score, last_run) VALUES ($1, 1, $2, $2, $2, CURRENT_TIMESTAMP)',
        [test_name, score]
      );
    } else {
      await pool.query(
        `UPDATE benchmark_series 
         SET total_benchmarks = total_benchmarks + 1, 
             last_run = CURRENT_TIMESTAMP,
             avg_score = (SELECT AVG(score) FROM benchmarks WHERE test_name = $1),
             max_score = (SELECT MAX(score) FROM benchmarks WHERE test_name = $1),
             min_score = (SELECT MIN(score) FROM benchmarks WHERE test_name = $1)
         WHERE test_name = $1`,
        [test_name]
      );
    }
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: 'Failed to create benchmark' });
  }
});

// Get stats
app.get('/api/stats', async (req, res) => {
  try {
    const total = await pool.query('SELECT COUNT(*) FROM benchmarks');
    const series = await pool.query('SELECT COUNT(*) FROM benchmark_series');
    const topTests = await pool.query(`
      SELECT test_name, MAX(score) as max_score, AVG(score) as avg_score, COUNT(*) as runs
      FROM benchmarks
      GROUP BY test_name
      ORDER BY avg_score DESC
      LIMIT 5
    `);
    
    res.json({
      total_benchmarks: parseInt(total.rows[0].count),
      total_series: parseInt(series.rows[0].count),
      top_tests: topTests.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed fetch stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Benchmark Tracker on port ${PORT}`);
});
