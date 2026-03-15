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

    // Shared docs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_docs (
        id SERIAL PRIMARY KEY,
        doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        permission VARCHAR(20) NOT NULL DEFAULT 'viewer',
        shared_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shared_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(doc_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shared_docs_user_id ON shared_docs(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_shared_docs_doc_id ON shared_docs(doc_id)`);

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

// Auth config (exposes client ID to frontend)
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
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

    // Auto-share if applicable
    await autoShareDoc(result.rows[0].id, req.userId);

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

// ====================== Sharing Endpoints ======================

// Auto-share config: Lobsty's docs auto-share with Ray
const AUTO_SHARE_RULES = [
  { ownerEmail: 'cynthiabgonzalez@gmail.com', shareWithEmail: 'rayovims@gmail.com', permission: 'editor' }
];

async function autoShareDoc(docId, ownerUserId) {
  try {
    const ownerResult = await pool.query('SELECT email FROM users WHERE id = $1', [ownerUserId]);
    if (ownerResult.rows.length === 0) return;
    const ownerEmail = ownerResult.rows[0].email;

    for (const rule of AUTO_SHARE_RULES) {
      if (ownerEmail === rule.ownerEmail) {
        const targetUser = await pool.query('SELECT id FROM users WHERE email = $1', [rule.shareWithEmail]);
        if (targetUser.rows.length > 0) {
          const targetUserId = targetUser.rows[0].id;
          await pool.query(
            `INSERT INTO shared_docs (doc_id, user_id, permission, shared_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (doc_id, user_id) DO NOTHING`,
            [docId, targetUserId, rule.permission, ownerUserId]
          );
        }
      }
    }
  } catch (err) {
    console.error('Auto-share failed:', err.message);
  }
}

// Lookup user by email (for sharing UI)
app.get('/api/users/lookup', authRequired, async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const result = await pool.query(
      'SELECT id, email, name FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to lookup user' });
  }
});

// Get docs shared with me
app.get('/api/docs/shared', authRequired, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, sd.permission, sd.shared_by, sd.shared_at,
              u.name as owner_name, u.email as owner_email
       FROM shared_docs sd
       JOIN docs d ON d.id = sd.doc_id
       JOIN users u ON u.id = d.user_id
       WHERE sd.user_id = $1
       ORDER BY sd.shared_at DESC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shared docs' });
  }
});

// Get shares for a specific doc (who it's shared with)
app.get('/api/docs/:id/shares', authRequired, async (req, res) => {
  try {
    // Verify the requester owns the doc
    const doc = await pool.query('SELECT id FROM docs WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    const result = await pool.query(
      `SELECT sd.id, sd.user_id, sd.permission, sd.shared_at,
              u.name, u.email
       FROM shared_docs sd
       JOIN users u ON u.id = sd.user_id
       WHERE sd.doc_id = $1
       ORDER BY sd.shared_at`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch shares' });
  }
});

// Share a doc with a user
app.post('/api/docs/:id/share', authRequired, async (req, res) => {
  try {
    const { email, permission } = req.body;
    if (!email || !permission) {
      return res.status(400).json({ error: 'Email and permission are required' });
    }
    if (!['viewer', 'editor'].includes(permission)) {
      return res.status(400).json({ error: 'Permission must be viewer or editor' });
    }

    // Verify doc ownership
    const doc = await pool.query('SELECT id FROM docs WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Find target user
    const targetUser = await pool.query('SELECT id, email, name FROM users WHERE email = $1', [email]);
    if (targetUser.rows.length === 0) {
      return res.status(404).json({ error: 'User not found. They need to create an account first.' });
    }

    const targetUserId = targetUser.rows[0].id;
    if (targetUserId === req.userId) {
      return res.status(400).json({ error: 'Cannot share with yourself' });
    }

    const result = await pool.query(
      `INSERT INTO shared_docs (doc_id, user_id, permission, shared_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET permission = $3
       RETURNING *`,
      [req.params.id, targetUserId, permission, req.userId]
    );

    res.status(201).json({
      ...result.rows[0],
      name: targetUser.rows[0].name,
      email: targetUser.rows[0].email
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to share document' });
  }
});

// Remove share
app.delete('/api/docs/:id/share/:userId', authRequired, async (req, res) => {
  try {
    // Verify doc ownership
    const doc = await pool.query('SELECT id FROM docs WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    if (doc.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const result = await pool.query(
      'DELETE FROM shared_docs WHERE doc_id = $1 AND user_id = $2',
      [req.params.id, req.params.userId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove share' });
  }
});

// Allow editors to update shared docs
app.put('/api/docs/:id/shared', authRequired, async (req, res) => {
  try {
    // Check if user has editor permission
    const share = await pool.query(
      "SELECT permission FROM shared_docs WHERE doc_id = $1 AND user_id = $2 AND permission = 'editor'",
      [req.params.id, req.userId]
    );
    if (share.rows.length === 0) {
      return res.status(403).json({ error: 'No editor access to this document' });
    }

    const { title, content, icon, parent_id, tags, sort_order } = req.body;
    const result = await pool.query(
      `UPDATE docs SET title = $1, content = $2, icon = $3, parent_id = $4, tags = $5, sort_order = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [title ?? '', content ?? '', icon ?? '📄', parent_id ?? null, tags ?? '{}', sort_order ?? 0, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update shared doc' });
  }
});

// ====================== Templates Endpoint ======================
app.get('/api/templates', (req, res) => {
  const templates = [
    {
      id: 'video-script', title: 'Video Script', icon: '📹', category: 'Content',
      description: 'Structure your video with hook, intro, main points, and CTA',
      content: '<h1>📹 Video Script</h1><h2>🎣 Hook</h2><p>Open with a compelling question or statement that grabs attention in the first 5 seconds...</p><h2>👋 Intro</h2><p>Introduce yourself and what this video covers...</p><h2>📌 Main Point 1</h2><p>Your first key point or argument...</p><h2>📌 Main Point 2</h2><p>Your second key point or argument...</p><h2>📌 Main Point 3</h2><p>Your third key point or argument...</p><h2>🎬 B-Roll Notes</h2><ul><li>Shot 1: </li><li>Shot 2: </li><li>Shot 3: </li></ul><h2>👋 Outro</h2><p>Summarize key takeaways...</p><h2>📣 Call to Action</h2><p>Like, subscribe, comment below with...</p>'
    },
    {
      id: 'product-review', title: 'Product Review', icon: '📝', category: 'Content',
      description: 'Review template with specs, pros, cons, and verdict',
      content: '<h1>📝 Product Review</h1><h2>First Impressions</h2><p>Unboxing experience, build quality, initial thoughts...</p><h2>📋 Specifications</h2><ul><li><strong>Model:</strong> </li><li><strong>Price:</strong> </li><li><strong>Key Feature 1:</strong> </li><li><strong>Key Feature 2:</strong> </li></ul><h2>✅ Pros</h2><ul><li>Pro 1</li><li>Pro 2</li><li>Pro 3</li></ul><h2>❌ Cons</h2><ul><li>Con 1</li><li>Con 2</li></ul><h2>⚖️ Verdict</h2><p>Overall assessment and who this product is for...</p><h2>Score: __/10</h2>'
    },
    {
      id: 'comparison', title: 'Comparison', icon: '📊', category: 'Content',
      description: 'Side-by-side comparison table for products or options',
      content: '<h1>📊 Comparison</h1><table><thead><tr><th>Category</th><th>Option A</th><th>Option B</th></tr></thead><tbody><tr><td><strong>Price</strong></td><td></td><td></td></tr><tr><td><strong>Performance</strong></td><td></td><td></td></tr><tr><td><strong>Features</strong></td><td></td><td></td></tr><tr><td><strong>Build Quality</strong></td><td></td><td></td></tr><tr><td><strong>Value</strong></td><td></td><td></td></tr></tbody></table><h2>Summary</h2><p>Overall recommendation and reasoning...</p>'
    },
    {
      id: 'meeting-notes', title: 'Meeting Notes', icon: '🎯', category: 'Work',
      description: 'Capture agenda, discussion, and action items',
      content: '<h1>🎯 Meeting Notes</h1><p><strong>Date:</strong> </p><p><strong>Attendees:</strong> </p><h2>📋 Agenda</h2><ol><li>Item 1</li><li>Item 2</li><li>Item 3</li></ol><h2>💬 Discussion</h2><p>Key points discussed...</p><h2>✅ Action Items</h2><ul><li>[ ] Action 1 — <em>Owner, Due date</em></li><li>[ ] Action 2 — <em>Owner, Due date</em></li></ul><h2>📅 Follow-ups</h2><ul><li>Next meeting: </li><li>Pending decisions: </li></ul>'
    },
    {
      id: 'project-brief', title: 'Project Brief', icon: '💡', category: 'Work',
      description: 'Define project goals, timeline, and success metrics',
      content: '<h1>💡 Project Brief</h1><h2>Overview</h2><p>Brief description of the project and its purpose...</p><h2>🎯 Goals</h2><ol><li>Goal 1</li><li>Goal 2</li><li>Goal 3</li></ol><h2>📅 Timeline</h2><ul><li><strong>Start:</strong> </li><li><strong>Milestone 1:</strong> </li><li><strong>Milestone 2:</strong> </li><li><strong>Deadline:</strong> </li></ul><h2>🔧 Resources</h2><ul><li>Team members: </li><li>Budget: </li><li>Tools: </li></ul><h2>📊 Success Metrics</h2><ul><li>Metric 1: </li><li>Metric 2: </li><li>Metric 3: </li></ul>'
    },
    {
      id: 'checklist', title: 'Checklist', icon: '📋', category: 'Personal',
      description: 'Simple checklist with sections for tasks and to-dos',
      content: '<h1>📋 Checklist</h1><h2>Priority Tasks</h2><ul><li>[ ] Task 1</li><li>[ ] Task 2</li><li>[ ] Task 3</li></ul><h2>Secondary Tasks</h2><ul><li>[ ] Task 4</li><li>[ ] Task 5</li></ul><h2>Notes</h2><p>Additional notes or context...</p>'
    }
  ];
  res.json(templates);
});

// Serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start
initDatabase()
  .then(() => {

// Global search endpoint (internal, no auth)
app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q || q.length < 2) return res.json([]);
    const result = await pool.query("SELECT id, title, LEFT(content, 200) as content FROM docs WHERE title ILIKE $1 OR content ILIKE $1 ORDER BY updated_at DESC LIMIT 10", ["%" + q + "%"]);
    res.json(result.rows);
  } catch (error) { res.json([]); }
});

    app.listen(PORT, () => {
      console.log(`Lobsty Docs running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
