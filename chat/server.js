const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8114;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:lobsty2026@localhost:5432/chat';
const GATEWAY_WS = process.env.GATEWAY_WS || 'ws://192.168.50.243:18789';

const pool = new Pool({ connectionString: DATABASE_URL });
const server = http.createServer(app);

// WebSocket proxy: client connects to /ws, we proxy to the Gateway
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws' || req.url === '/ws/') {
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      // Open connection to Gateway
      const gwWs = new WebSocket(GATEWAY_WS);
      let gwReady = false;
      const buffer = [];

      gwWs.on('open', () => {
        gwReady = true;
        buffer.forEach(msg => gwWs.send(msg));
        buffer.length = 0;
      });

      // Proxy: client -> gateway
      clientWs.on('message', (data) => {
        const str = data.toString();
        if (gwReady && gwWs.readyState === WebSocket.OPEN) {
          gwWs.send(str);
        } else {
          buffer.push(str);
        }
      });

      // Proxy: gateway -> client
      gwWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data.toString());
        }
      });

      gwWs.on('close', (code, reason) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason.toString());
      });
      gwWs.on('error', () => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'Gateway connection error');
      });

      clientWs.on('close', () => {
        if (gwWs.readyState === WebSocket.OPEN) gwWs.close();
      });
      clientWs.on('error', () => {
        if (gwWs.readyState === WebSocket.OPEN) gwWs.close();
      });
    });
  } else {
    socket.destroy();
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Init DB
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_log (
        id SERIAL PRIMARY KEY,
        session_key VARCHAR(255),
        model VARCHAR(255),
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        thinking_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        cost_estimate DECIMAL(10,6),
        message_preview TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        id SERIAL PRIMARY KEY,
        date DATE UNIQUE,
        total_input INTEGER DEFAULT 0,
        total_output INTEGER DEFAULT 0,
        total_thinking INTEGER DEFAULT 0,
        total_cache_read INTEGER DEFAULT 0,
        total_cache_write INTEGER DEFAULT 0,
        message_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}

// API Routes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/usage/log', async (req, res) => {
  try {
    const { session_key, model, input_tokens, output_tokens, thinking_tokens, cache_read_tokens, cache_write_tokens, cost_estimate, message_preview } = req.body;
    await pool.query(
      `INSERT INTO usage_log (session_key, model, input_tokens, output_tokens, thinking_tokens, cache_read_tokens, cache_write_tokens, cost_estimate, message_preview)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [session_key, model, input_tokens||0, output_tokens||0, thinking_tokens||0, cache_read_tokens||0, cache_write_tokens||0, cost_estimate||0, message_preview]
    );
    const today = new Date().toISOString().split('T')[0];
    await pool.query(
      `INSERT INTO daily_usage (date, total_input, total_output, total_thinking, total_cache_read, total_cache_write, message_count)
       VALUES ($1,$2,$3,$4,$5,$6,1)
       ON CONFLICT (date) DO UPDATE SET
         total_input = daily_usage.total_input + $2,
         total_output = daily_usage.total_output + $3,
         total_thinking = daily_usage.total_thinking + $4,
         total_cache_read = daily_usage.total_cache_read + $5,
         total_cache_write = daily_usage.total_cache_write + $6,
         message_count = daily_usage.message_count + 1`,
      [today, input_tokens||0, output_tokens||0, thinking_tokens||0, cache_read_tokens||0, cache_write_tokens||0]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('Usage log error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/usage/recent', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM usage_log ORDER BY created_at DESC LIMIT 50');
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/usage/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const r = await pool.query('SELECT * FROM daily_usage WHERE date >= NOW() - $1::int * INTERVAL \'1 day\' ORDER BY date ASC', [days]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/usage/summary', async (req, res) => {
  try {
    const total = await pool.query('SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output, COALESCE(SUM(thinking_tokens),0) as thinking, COALESCE(SUM(cache_read_tokens),0) as cache_read, COALESCE(SUM(cache_write_tokens),0) as cache_write, COUNT(*) as messages FROM usage_log');
    const today = await pool.query('SELECT * FROM daily_usage WHERE date = CURRENT_DATE');
    res.json({ total: total.rows[0], today: today.rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => console.log(`Chat Hub running on port ${PORT}`));
}).catch(e => {
  console.error('DB init failed:', e);
  server.listen(PORT, '0.0.0.0', () => console.log(`Chat Hub running on port ${PORT} (no DB)`));
});
