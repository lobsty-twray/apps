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
  database: process.env.DB_NAME || 'sponsor_manager',
  user: process.env.DB_USER || 'lobsty',
  password: process.env.DB_PASSWORD || '***REMOVED***'
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sponsors (
        id SERIAL PRIMARY KEY,
        company_name VARCHAR(255) NOT NULL,
        contact_name VARCHAR(255),
        email VARCHAR(255),
        phone VARCHAR(20),
        website VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id SERIAL PRIMARY KEY,
        sponsor_id INT REFERENCES sponsors(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        deal_type VARCHAR(100),
        amount DECIMAL(10, 2),
        start_date DATE,
        end_date DATE,
        status VARCHAR(50) DEFAULT 'pending',
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS deliverables (
        id SERIAL PRIMARY KEY,
        deal_id INT REFERENCES deals(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        deadline DATE,
        completed_date DATE,
        status VARCHAR(50) DEFAULT 'pending',
        delivery_type VARCHAR(100),
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id SERIAL PRIMARY KEY,
        deal_id INT REFERENCES deals(id) ON DELETE CASCADE,
        amount DECIMAL(10, 2),
        due_date DATE,
        paid_date DATE,
        status VARCHAR(50) DEFAULT 'pending',
        payment_method VARCHAR(100),
        notes TEXT,
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

// Sponsors
app.get('/api/sponsors', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sponsors ORDER BY company_name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch sponsors' });
  }
});

app.post('/api/sponsors', async (req, res) => {
  try {
    const { company_name, contact_name, email, phone, website, status, notes } = req.body;
    const result = await pool.query(
      'INSERT INTO sponsors (company_name, contact_name, email, phone, website, status, notes) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [company_name, contact_name, email, phone, website, status || 'active', notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create sponsor' });
  }
});

// Deals
app.get('/api/deals', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, s.company_name FROM deals d
      JOIN sponsors s ON d.sponsor_id = s.id
      ORDER BY d.start_date DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deals' });
  }
});

app.post('/api/deals', async (req, res) => {
  try {
    const { sponsor_id, title, deal_type, amount, start_date, end_date, status, description } = req.body;
    const result = await pool.query(
      `INSERT INTO deals (sponsor_id, title, deal_type, amount, start_date, end_date, status, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [sponsor_id, title, deal_type, amount, start_date, end_date, status || 'pending', description]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create deal' });
  }
});

app.put('/api/deals/:id', async (req, res) => {
  try {
    const { title, deal_type, amount, start_date, end_date, status, description } = req.body;
    const result = await pool.query(
      `UPDATE deals SET title = $1, deal_type = $2, amount = $3, start_date = $4, end_date = $5, status = $6, description = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8 RETURNING *`,
      [title, deal_type, amount, start_date, end_date, status, description, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update deal' });
  }
});

// Deliverables
app.get('/api/deals/:id/deliverables', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM deliverables WHERE deal_id = $1 ORDER BY deadline', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch deliverables' });
  }
});

app.post('/api/deliverables', async (req, res) => {
  try {
    const { deal_id, title, description, deadline, delivery_type, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO deliverables (deal_id, title, description, deadline, delivery_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [deal_id, title, description, deadline, delivery_type, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create deliverable' });
  }
});

app.put('/api/deliverables/:id', async (req, res) => {
  try {
    const { title, description, deadline, delivery_type, status, completed_date, notes } = req.body;
    const result = await pool.query(
      `UPDATE deliverables SET title = $1, description = $2, deadline = $3, delivery_type = $4, status = $5, completed_date = $6, notes = $7
       WHERE id = $8 RETURNING *`,
      [title, description, deadline, delivery_type, status, completed_date, notes, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update deliverable' });
  }
});

// Payments
app.get('/api/deals/:id/payments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payments WHERE deal_id = $1 ORDER BY due_date', [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

app.post('/api/payments', async (req, res) => {
  try {
    const { deal_id, amount, due_date, payment_method, notes } = req.body;
    const result = await pool.query(
      `INSERT INTO payments (deal_id, amount, due_date, payment_method, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [deal_id, amount, due_date, payment_method, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  try {
    const activeDeals = await pool.query("SELECT COUNT(*) FROM deals WHERE status = 'active'");
    const pendingDeliverables = await pool.query("SELECT COUNT(*) FROM deliverables WHERE status = 'pending'");
    const totalRevenue = await pool.query("SELECT SUM(amount) as total FROM deals WHERE status IN ('active', 'completed')");
    const sponsors = await pool.query("SELECT COUNT(*) FROM sponsors");
    
    res.json({
      active_deals: parseInt(activeDeals.rows[0].count),
      pending_deliverables: parseInt(pendingDeliverables.rows[0].count),
      total_sponsors: parseInt(sponsors.rows[0].count),
      total_revenue: parseFloat(totalRevenue.rows[0].total || 0)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sponsor Manager on port ${PORT}`);
});
