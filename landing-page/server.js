const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

const app = express();
const PORT = 80;

// Init SQLite
const dbDir = '/data';
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(path.join(dbDir, 'analytics.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    device_type TEXT DEFAULT 'desktop',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_visits_date ON visits(created_at);
`);

const insertVisit = db.prepare(
  'INSERT INTO visits (ip_hash, path, referrer, user_agent, device_type) VALUES (?, ?, ?, ?, ?)'
);

function hashIP(ip) {
  return crypto.createHash('sha256').update(ip + 'twray-salt-2026').digest('hex').slice(0, 16);
}

function detectDevice(ua) {
  if (!ua) return 'desktop';
  if (/mobile|android|iphone|ipad|ipod|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  if (/tablet|ipad/i.test(ua)) return 'tablet';
  return 'desktop';
}

// Analytics tracking middleware - only track page views, not assets
app.use((req, res, next) => {
  // Skip asset requests, analytics page, and bot-like requests
  if (req.path.startsWith('/analytics') || req.path.match(/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|webp|xml|txt|map)$/i)) {
    return next();
  }
  
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.ip;
  const ua = req.headers['user-agent'] || '';
  const referrer = req.headers['referer'] || req.headers['referrer'] || '';
  
  try {
    insertVisit.run(hashIP(ip), req.path, referrer, ua, detectDevice(ua));
  } catch (e) {
    console.error('Analytics insert error:', e.message);
  }
  next();
});

// Basic auth for analytics
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Analytics"');
    return res.status(401).send('Authentication required');
  }
  const [user, pass] = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  if (pass === 'ray2026') return next();
  res.set('WWW-Authenticate', 'Basic realm="Analytics"');
  res.status(401).send('Invalid credentials');
}

// Analytics API
app.get('/analytics/api/data', authMiddleware, (req, res) => {
  const totalVisits = db.prepare('SELECT COUNT(*) as count FROM visits').get().count;
  const uniqueVisitors = db.prepare('SELECT COUNT(DISTINCT ip_hash) as count FROM visits').get().count;
  
  const visitsPerDay = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as count 
    FROM visits 
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY date(created_at) 
    ORDER BY day
  `).all();
  
  const topReferrers = db.prepare(`
    SELECT referrer, COUNT(*) as count 
    FROM visits 
    WHERE referrer != '' 
    GROUP BY referrer 
    ORDER BY count DESC 
    LIMIT 10
  `).all();
  
  const deviceBreakdown = db.prepare(`
    SELECT device_type, COUNT(*) as count 
    FROM visits 
    GROUP BY device_type 
    ORDER BY count DESC
  `).all();

  const todayVisits = db.prepare(`SELECT COUNT(*) as count FROM visits WHERE date(created_at) = date('now')`).get().count;
  const todayUnique = db.prepare(`SELECT COUNT(DISTINCT ip_hash) as count FROM visits WHERE date(created_at) = date('now')`).get().count;
  
  const topPages = db.prepare(`
    SELECT path, COUNT(*) as count 
    FROM visits 
    GROUP BY path 
    ORDER BY count DESC 
    LIMIT 10
  `).all();

  res.json({ totalVisits, uniqueVisitors, todayVisits, todayUnique, visitsPerDay, topReferrers, deviceBreakdown, topPages });
});

// Analytics dashboard
app.get('/analytics', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'analytics.html'));
});

// Serve static files for buildwithray.dev
app.use('/buildwithray', express.static(path.join(__dirname, 'public/buildwithray')));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback for SPA-like routes under buildwithray
app.get('/buildwithray/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/buildwithray/index.html'));
});

// Catch-all
app.get('*', (req, res) => {
  const tryPath = path.join(__dirname, 'public', req.path, 'index.html');
  if (fs.existsSync(tryPath)) return res.sendFile(tryPath);
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => console.log(`Landing page server running on port ${PORT}`));
