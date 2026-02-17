const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'lobsty-docs-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@lobsty-postgres:5432/docs';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

let pool;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ====================== Database Init ======================
async function initDatabase() {
  // Parse DATABASE_URL to extract database name and create it if needed
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1); // remove leading /
  const adminUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const result = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1", [dbName]
    );
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } catch (err) {
    console.log('Database check/create note:', err.message);
  } finally {
    await adminPool.end();
  }

  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        google_id VARCHAR(255) UNIQUE,
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS docs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(500) DEFAULT '',
        content TEXT DEFAULT '',
        icon VARCHAR(10) DEFAULT '📄',
        parent_id INTEGER REFERENCES docs(id) ON DELETE SET NULL,
        tags TEXT[] DEFAULT '{}',
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_docs_user_id ON docs(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_docs_parent_id ON docs(parent_id)`);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// ====================== Auth Middleware ======================
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

// ====================== Auth Endpoints ======================

// Register with email/password
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      return res.status(400).json({ error: 'Email, name, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, name, passwordHash]
    );

    const user = result.rows[0];
    const token = generateToken(user.id);
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login with email/password
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses Google sign-in. Please use Google to log in.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
  } catch (err) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Google OAuth
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }
    if (!googleClient) {
      return res.status(500).json({ error: 'Google OAuth not configured' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    // Check if user exists by google_id
    let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);

    if (result.rows.length === 0) {
      // Check if email exists (link accounts)
      result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      if (result.rows.length > 0) {
        await pool.query('UPDATE users SET google_id = $1 WHERE email = $2', [googleId, email]);
        result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      } else {
        // Create new user
        result = await pool.query(
          'INSERT INTO users (email, name, google_id) VALUES ($1, $2, $3) RETURNING *',
          [email, name, googleId]
        );
      }
    }

    const user = result.rows[0];
    const token = generateToken(user.id);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, created_at: user.created_at } });
  } catch (err) {
    res.status(401).json({ error: 'Google authentication failed' });
  }
});

// Get current user
app.get('/api/auth/me', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, created_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// ====================== Docs Endpoints ======================

// Get all docs for user (flat list, frontend builds the tree)
app.get('/api/docs', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM docs WHERE user_id = $1 ORDER BY sort_order, created_at',
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch docs' });
  }
});

// Create doc
app.post('/api/docs', authRequired, async (req, res) => {
  try {
    const { title, content, icon, parent_id, tags, sort_order } = req.body;

    // If parent_id provided, verify it belongs to this user
    if (parent_id) {
      const parent = await pool.query('SELECT id FROM docs WHERE id = $1 AND user_id = $2', [parent_id, req.userId]);
      if (parent.rows.length === 0) {
        return res.status(404).json({ error: 'Parent document not found' });
      }
    }

    const result = await pool.query(
      `INSERT INTO docs (user_id, title, content, icon, parent_id, tags, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.userId, title || '', content || '', icon || '📄', parent_id || null, tags || '{}', sort_order || 0]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create doc' });
  }
});

// Update doc
app.put('/api/docs/:id', authRequired, async (req, res) => {
  try {
    const { title, content, icon, parent_id, tags, sort_order } = req.body;
    const result = await pool.query(
      `UPDATE docs SET title = $1, content = $2, icon = $3, parent_id = $4, tags = $5, sort_order = $6, updated_at = NOW()
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [title ?? '', content ?? '', icon ?? '📄', parent_id ?? null, tags ?? '{}', sort_order ?? 0, req.params.id, req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update doc' });
  }
});

// Delete doc (and orphan children by setting parent_id = null)
app.delete('/api/docs/:id', authRequired, async (req, res) => {
  try {
    // Move children to root level
    await pool.query(
      'UPDATE docs SET parent_id = NULL WHERE parent_id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    const result = await pool.query(
      'DELETE FROM docs WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete doc' });
  }
});

// Serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Lobsty Docs running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
