const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Docker = require('dockerode');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.static("public"));
app.use(express.json());
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://admin.twray.dev/auth/google/callback'
}, (accessToken, refreshToken, profile, done) => {
  done(null, { id: profile.id, name: profile.displayName, photo: profile.photos?.[0]?.value });
}));

app.use(session({ secret: 'admin-dashboard-session-2026', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

const requireAuth = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/auth/google');
};

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => res.redirect('/'));
app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

app.get('/api/containers', requireAuth, async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    res.json(containers.map(c => ({
      name: c.Names[0]?.replace(/^\//, ''),
      image: c.Image,
      state: c.State,
      status: c.Status
    })));
  } catch (e) { res.json([]); }
});

// System health endpoint
app.get('/api/system', requireAuth, (req, res) => {
  try {
    const cpus = os.cpus();
    const cpuTotal = cpus.reduce((a, c) => {
      const t = Object.values(c.times).reduce((s, v) => s + v, 0);
      const idle = c.times.idle;
      return { total: a.total + t, idle: a.idle + idle };
    }, { total: 0, idle: 0 });
    const cpuPercent = Math.round((1 - cpuTotal.idle / cpuTotal.total) * 100);

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    let disks = [];
    try {
      const dfOut = execSync('df -h --output=source,size,used,avail,pcent / /home 2>/dev/null || df -h / /home 2>/dev/null', { encoding: 'utf8' });
      const lines = dfOut.trim().split('\n').slice(1);
      const seen = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && !seen.has(parts[0])) {
          seen.add(parts[0]);
          disks.push({ source: parts[0], size: parts[1], used: parts[2], avail: parts[3], percent: parseInt(parts[4]) });
        }
      }
    } catch (e) {}

    const uptimeSec = os.uptime();
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptime = days > 0 ? `${days}d ${hours}h ${mins}m` : `${hours}h ${mins}m`;

    res.json({ cpuPercent, memPercent, memUsedGB: (usedMem / 1073741824).toFixed(1), memTotalGB: (totalMem / 1073741824).toFixed(1), disks, uptime });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Backup status endpoint
app.get('/api/backup-status', requireAuth, (req, res) => {
  try {
    const backupDir = '/backups/postgres';
    if (!fs.existsSync(backupDir)) return res.json({ error: 'Backup directory not found' });
    const files = fs.readdirSync(backupDir).filter(f => !f.startsWith('.'));
    if (!files.length) return res.json({ error: 'No backups found', count: 0 });

    let newest = null, newestTime = 0;
    let totalSize = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(backupDir, f));
      totalSize += st.size;
      if (st.mtimeMs > newestTime) { newestTime = st.mtimeMs; newest = f; }
    }
    const newestStat = fs.statSync(path.join(backupDir, newest));
    const ageHours = (Date.now() - newestStat.mtimeMs) / 3600000;
    const status = ageHours < 24 ? 'green' : ageHours < 48 ? 'yellow' : 'red';
    const sizeStr = newestStat.size > 1048576 ? (newestStat.size / 1048576).toFixed(1) + ' MB' : (newestStat.size / 1024).toFixed(0) + ' KB';

    res.json({ latest: newest, time: newestStat.mtime, ageHours: Math.round(ageHours), size: sizeStr, count: files.length, status });
  } catch (e) { res.json({ error: e.message }); }
});

// Recent deploys endpoint
app.get('/api/recent-deploys', requireAuth, (req, res) => {
  try {
    const out = execSync('git -C /host-apps log --format="%h|%s|%ar" -5', { encoding: 'utf8' });
    const commits = out.trim().split('\n').filter(Boolean).map(line => {
      const [hash, message, timeAgo] = line.split('|');
      return { hash, message, timeAgo };
    });
    res.json(commits);
  } catch (e) { res.json([]); }
});


// PostgreSQL health endpoint
const pgPool = new Pool({
  connectionString: 'postgresql://lobsty:lobsty2026@172.17.0.1:5432/lobsty_main',
  max: 3,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000,
});

app.get('/api/db-health', requireAuth, async (req, res) => {
  let client;
  try {
    client = await pgPool.connect();
    const [dbRes, connRes, maxRes, verRes, uptimeRes] = await Promise.all([
      client.query("SELECT datname as name, pg_database_size(datname) as size_bytes FROM pg_database WHERE datistemplate = false ORDER BY size_bytes DESC"),
      client.query("SELECT state, count(*)::int as count FROM pg_stat_activity GROUP BY state"),
      client.query("SELECT setting::int as max FROM pg_settings WHERE name = 'max_connections'"),
      client.query("SELECT version()"),
      client.query("SELECT pg_postmaster_start_time() as start_time"),
    ]);
    const databases = dbRes.rows.map(r => ({
      name: r.name,
      sizeMB: Math.round(parseInt(r.size_bytes) / 1048576 * 10) / 10,
    }));
    const connMap = {};
    connRes.rows.forEach(r => { connMap[r.state || 'null'] = r.count; });
    const active = connMap.active || 0;
    const idle = connMap.idle || 0;
    const total = connRes.rows.reduce((s, r) => s + r.count, 0);
    const maxConnections = maxRes.rows[0].max;
    const verFull = verRes.rows[0].version;
    const verMatch = verFull.match(/PostgreSQL ([\d.]+)/);
    const version = verMatch ? 'PostgreSQL ' + verMatch[1] : verFull.split(',')[0];
    const startTime = new Date(uptimeRes.rows[0].start_time);
    const uptimeMs = Date.now() - startTime.getTime();
    const days = Math.floor(uptimeMs / 86400000);
    const hours = Math.floor((uptimeMs % 86400000) / 3600000);
    const mins = Math.floor((uptimeMs % 3600000) / 60000);
    const uptime = days > 0 ? days + 'd ' + hours + 'h ' + mins + 'm' : hours + 'h ' + mins + 'm';
    res.json({ databases, connections: { active, idle, total, maxConnections }, version, uptime });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (client) client.release();
  }
});

const APPS = [
  { url: 'https://board.twray.dev', name: 'Kanban Board', emoji: '📋' },
  { url: 'https://docs.twray.dev', name: 'Docs Hub', emoji: '📄' },
  { url: 'https://drafts.twray.dev', name: 'Drafts', emoji: '✏️' },
  { url: 'https://stock-monitor.twray.dev', name: 'Stock Monitor', emoji: '📈' },
  { url: 'https://shop.twray.dev', name: 'Shop', emoji: '🛒' },
  { url: 'https://video-pipeline.twray.dev', name: 'Video Pipeline', emoji: '🎬' },
  { url: 'https://youtube-studio.twray.dev', name: 'YouTube Studio', emoji: '▶️' },
  { url: 'https://hardware-monitor.twray.dev', name: 'Hardware Monitor', emoji: '🖥️' },
  { url: 'https://gear-inventory.twray.dev', name: 'Gear Inventory', emoji: '🎒' },
  { url: 'https://content-calendar.twray.dev', name: 'Content Calendar', emoji: '📅' },
  { url: 'https://benchmark-tracker.twray.dev', name: 'Benchmarks', emoji: '⚡' },
  { url: 'https://script-writer.twray.dev', name: 'Script Writer', emoji: '🖊️' },
  { url: 'https://sponsor-manager.twray.dev', name: 'Sponsors', emoji: '🤝' },
  { url: 'https://content-ideas.twray.dev', name: 'Content Ideas', emoji: '💡' },
  { url: 'https://gaming-logger.twray.dev', name: 'Gaming Logger', emoji: '🎮' },
  { url: 'https://thumbnail-analyzer.twray.dev', name: 'Thumbnails', emoji: '🖼️' },
  { url: 'https://stream-planner.twray.dev', name: 'Stream Planner', emoji: '📡' },
  { url: 'https://app-hub.twray.dev', name: 'App Hub', emoji: '🏠' },
  { url: 'https://komodo.twray.dev', name: 'Komodo', emoji: '🐉' },
  { url: 'https://netdata.twray.dev', name: 'Netdata', emoji: '📊' },
  { url: 'https://twray.dev', name: 'Landing Page', emoji: '🌐' },
];

// Container logs endpoint
app.get('/api/containers/:name/logs', requireAuth, async (req, res) => {
  try {
    const tail = parseInt(req.query.tail) || 100;
    const container = docker.getContainer(req.params.name);
    const logs = await container.logs({ stdout: true, stderr: true, tail, timestamps: false });
    const buf = Buffer.isBuffer(logs) ? logs : Buffer.from(logs);
    // Strip Docker multiplexed stream 8-byte headers
    const lines = [];
    let offset = 0;
    while (offset < buf.length) {
      if (offset + 8 <= buf.length) {
        const size = buf.readUInt32BE(offset + 4);
        if (size > 0 && offset + 8 + size <= buf.length) {
          lines.push(buf.slice(offset + 8, offset + 8 + size).toString('utf8'));
          offset += 8 + size;
          continue;
        }
      }
      // Fallback: treat rest as plain text
      lines.push(buf.slice(offset).toString('utf8'));
      break;
    }
    res.type("text/plain").send(lines.join('').trim());
  } catch (e) { res.status(500).send("Error: " + e.message); }
});

// Container restart endpoint
app.post('/api/containers/:name/restart', requireAuth, async (req, res) => {
  try {
    const container = docker.getContainer(req.params.name);
    await container.restart({ t: 10 });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', requireAuth, (req, res) => {
  const user = req.user;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Admin Dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicons/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/favicons/apple-touch-icon.png">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0a0f;--surface:rgba(255,255,255,0.03);--glass:rgba(255,255,255,0.05);--glass-border:rgba(255,255,255,0.08);--text:#e8e8f0;--dim:#888899;--accent:#7c3aed;--accent2:#2563eb;--gradient:linear-gradient(135deg,#7c3aed,#2563eb);--glow:rgba(124,58,237,0.3);--green:#34d399;--red:#f87171;--yellow:#fbbf24}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden;-webkit-text-size-adjust:100%}

.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}

header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border);padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:1.1rem;font-weight:700;background:var(--gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.user-area{display:flex;align-items:center;gap:.5rem}
.user-area img{width:32px;height:32px;border-radius:50%;border:2px solid var(--glass-border)}
.user-area .name{font-size:.85rem;font-weight:500;display:none}
a.logout{color:var(--dim);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border);border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;min-width:44px;display:flex;align-items:center;justify-content:center;transition:all .3s;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(10px)}
a.logout:hover,a.logout:active{color:#fff;border-color:var(--accent);background:rgba(124,58,237,0.15);box-shadow:0 0 15px var(--glow)}

main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}

/* Health Panel */
.health-grid{display:grid;grid-template-columns:1fr;gap:.75rem;margin-bottom:2rem}
.health-card{background:var(--glass);border:1px solid var(--glass-border);border-radius:16px;padding:1.25rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);animation:fadeUp .5s ease both}
.health-card h3{font-size:.85rem;font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:.5rem;color:var(--text)}
.health-card h3 span.icon{font-size:1.1rem}
.health-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;font-size:.8rem}
.health-row:last-child{margin-bottom:0}
.health-label{color:var(--dim);font-weight:500}
.health-value{font-weight:700;font-variant-numeric:tabular-nums}
.progress-wrap{width:100%;margin-bottom:.75rem}
.progress-wrap:last-child{margin-bottom:0}
.progress-label{display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:4px}
.progress-label span:first-child{color:var(--dim)}
.progress-label span:last-child{font-weight:700;font-variant-numeric:tabular-nums}
.progress-bar{height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden}
.progress-fill{height:100%;border-radius:4px;transition:width .8s cubic-bezier(.4,0,.2,1);min-width:2px}
.progress-fill.green{background:var(--green)}
.progress-fill.yellow{background:var(--yellow)}
.progress-fill.red{background:var(--red)}

.backup-indicator{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.backup-indicator.green{background:var(--green);box-shadow:0 0 8px rgba(52,211,153,0.4)}
.backup-indicator.yellow{background:var(--yellow);box-shadow:0 0 8px rgba(251,191,36,0.4)}
.backup-indicator.red{background:var(--red);box-shadow:0 0 8px rgba(248,113,113,0.4)}

.deploy-item{display:flex;align-items:baseline;gap:.5rem;padding:.5rem 0;border-bottom:1px solid var(--glass-border);font-size:.8rem}
.deploy-item:last-child{border-bottom:none}
.deploy-hash{color:var(--accent);font-family:monospace;font-weight:600;font-size:.75rem;flex-shrink:0}
.deploy-msg{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deploy-time{color:var(--dim);font-size:.7rem;flex-shrink:0}

.container-badge{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:8px;font-size:.75rem;font-weight:700;margin-right:.5rem;margin-bottom:.5rem}
.container-badge.running{background:rgba(52,211,153,0.12);color:var(--green)}
.container-badge.stopped{background:rgba(248,113,113,0.12);color:var(--red)}
.container-badge.unhealthy{background:rgba(251,191,36,0.12);color:var(--yellow)}

.health-loading{color:var(--dim);font-size:.8rem;text-align:center;padding:1rem}

.stats-row{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:1.5rem}
.stat{background:var(--glass);border:1px solid var(--glass-border);border-radius:16px;padding:1rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:all .3s}
.stat:hover{border-color:rgba(124,58,237,0.3);box-shadow:0 4px 20px rgba(124,58,237,0.1)}
.stat-val{font-size:1.6rem;font-weight:800;background:var(--gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-lbl{font-size:.7rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}

.section-title{font-size:.85rem;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--glass-border),transparent)}
.section{margin-bottom:2rem}

.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem}
.card{background:var(--glass);border:1px solid var(--glass-border);border-radius:14px;padding:1rem .75rem;text-decoration:none;color:var(--text);transition:all .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;align-items:center;gap:.35rem;text-align:center;min-height:80px;justify-content:center;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);position:relative;overflow:hidden}
.card::before{content:'';position:absolute;inset:0;background:var(--gradient);opacity:0;transition:opacity .3s}
.card:active{transform:scale(.96)}
.card:active::before,.card:hover::before{opacity:.08}
.card:hover{border-color:rgba(124,58,237,0.4);box-shadow:0 8px 32px var(--glow);transform:translateY(-2px)}
.card>*{position:relative;z-index:1}
.card .emoji{font-size:1.75rem;line-height:1}
.card .label{font-size:.8rem;font-weight:600;line-height:1.2}

.container-grid{display:grid;grid-template-columns:1fr;gap:.75rem}
.ccard{background:var(--glass);border:1px solid var(--glass-border);border-radius:14px;padding:1rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:all .3s;overflow:hidden}
.ccard:hover{border-color:rgba(124,58,237,0.2)}
.ccard-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.4rem;gap:.5rem}
.ccard-name{font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ccard-image{color:var(--dim);font-size:.7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccard-status{color:#666;font-size:.75rem;margin-top:.2rem}
.state{padding:4px 10px;border-radius:8px;font-size:.65rem;font-weight:700;text-transform:uppercase;white-space:nowrap;flex-shrink:0;letter-spacing:.03em}
.state.running{background:rgba(52,211,153,0.12);color:var(--green);box-shadow:0 0 10px rgba(52,211,153,0.1)}
.state.exited{background:rgba(248,113,113,0.12);color:var(--red)}
.state.created,.state.paused,.state.restarting{background:rgba(251,191,36,0.12);color:var(--yellow)}
#containers-loading{text-align:center;color:#444;padding:2rem;font-size:.85rem}

@media(min-width:480px){
  .grid{grid-template-columns:repeat(3,1fr)}
  .container-grid{grid-template-columns:repeat(2,1fr)}
  .user-area .name{display:inline}
  .stats-row{grid-template-columns:repeat(4,1fr)}
}
@media(min-width:768px){
  main{padding:1.5rem}
  .health-grid{grid-template-columns:repeat(2,1fr);gap:1rem}
  .grid{grid-template-columns:repeat(4,1fr);gap:1rem}
  .container-grid{grid-template-columns:repeat(2,1fr);gap:1rem}
  .card{padding:1.25rem 1rem;min-height:100px}
  .card .emoji{font-size:2rem}
  .card .label{font-size:.85rem}
  header h1{font-size:1.3rem}
}
@media(min-width:1024px){
  main{padding:2rem}
  .grid{grid-template-columns:repeat(5,1fr)}
  .container-grid{grid-template-columns:repeat(3,1fr)}
}
@media(min-width:1280px){
  .grid{grid-template-columns:repeat(7,1fr)}
  .container-grid{grid-template-columns:repeat(4,1fr)}
}

.card,.ccard,.stat,.health-card{animation:fadeUp .5s ease both}
@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}

/* Logs Modal */
.modal-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:1rem}
.modal-overlay.open{display:flex}
.modal{background:var(--bg);border:1px solid var(--glass-border);border-radius:16px;width:100%;max-width:900px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal-head{display:flex;justify-content:space-between;align-items:center;padding:1rem 1.25rem;border-bottom:1px solid var(--glass-border);gap:.5rem;flex-shrink:0}
.modal-head h2{font-size:1rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.modal-controls{display:flex;gap:.5rem;align-items:center;flex-shrink:0}
.modal-controls select,.modal-controls button{background:var(--glass);border:1px solid var(--glass-border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:.8rem;min-height:44px;min-width:44px;cursor:pointer;transition:all .2s}
.modal-controls button:hover{border-color:var(--accent);background:rgba(124,58,237,0.15)}
.modal-body{flex:1;overflow:auto;padding:1rem}
.log-output{font-family:'Courier New',monospace;font-size:.75rem;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#d4d4d4;background:rgba(0,0,0,0.4);border-radius:8px;padding:1rem;min-height:200px;max-height:65vh;overflow:auto}
.ccard-actions{display:flex;gap:.5rem;margin-top:.5rem}
.ccard-actions button{background:var(--glass);border:1px solid var(--glass-border);color:var(--text);border-radius:8px;padding:6px 12px;font-size:.75rem;min-height:44px;min-width:44px;cursor:pointer;transition:all .2s;display:flex;align-items:center;gap:4px;-webkit-tap-highlight-color:transparent}
.ccard-actions button:hover{border-color:var(--accent);background:rgba(124,58,237,0.15)}
.ccard-actions button:disabled{opacity:.5;cursor:not-allowed}
.ccard-actions button.restarting{animation:pulse 1s infinite}
@media(max-width:480px){.modal{max-height:100vh;height:100vh;border-radius:0}.log-output{max-height:calc(100vh - 140px)}}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>⚡ Admin Dashboard</h1>
  <div class="user-area">
    \${user.photo ? \`<img src="\${user.photo}" alt="">\` : ''}
    <span class="name">\${user.name}</span>
    <a href="/containers" class="logout">🐳 Containers</a>
    <a href="/status" class="logout">Status</a>
    <a href="/storage" class="logout">Storage</a>
    <a href="/health" class="logout">🏥 Health</a>
    <a href="/logout" class="logout">Logout</a>
  </div>
</header>
<main>
  <!-- System Health Panel -->
  <div class="section">
    <div class="section-title">🩺 System Health</div>
    <div class="health-grid">
      <div class="health-card" style="animation-delay:.05s">
        <h3><span class="icon">💻</span> System Resources</h3>
        <div id="system-health"><div class="health-loading">Loading…</div></div>
      </div>
      <div class="health-card" style="animation-delay:.1s">
        <h3><span class="icon">🐳</span> Container Health</h3>
        <div id="container-health"><div class="health-loading">Loading…</div></div>
      </div>
      <div class="health-card" style="animation-delay:.15s">
        <h3><span class="icon">💾</span> Backup Status</h3>
        <div id="backup-health"><div class="health-loading">Loading…</div></div>
      </div>
      <div class="health-card" style="animation-delay:.2s">
        <h3><span class="icon">🚀</span> Recent Deploys</h3>
        <div id="deploy-health"><div class="health-loading">Loading…</div></div>
      </div>
      <div class="health-card" style="animation-delay:.25s">
        <h3><span class="icon">🗄️</span> Database Health</h3>
        <div id="db-health"><div class="health-loading">Loading…</div></div>
      </div>
    </div>
  </div>

  <div class="stats-row" id="stats-row">
    <div class="stat" style="animation-delay:.05s">
      <div class="stat-val" id="stat-total">-</div>
      <div class="stat-lbl">Containers</div>
    </div>
    <div class="stat" style="animation-delay:.1s">
      <div class="stat-val" id="stat-running" style="background:none;-webkit-text-fill-color:var(--green)">-</div>
      <div class="stat-lbl">Running</div>
    </div>
    <div class="stat" style="animation-delay:.15s">
      <div class="stat-val" id="stat-stopped" style="background:none;-webkit-text-fill-color:var(--red)">-</div>
      <div class="stat-lbl">Stopped</div>
    </div>
    <div class="stat" style="animation-delay:.2s">
      <div class="stat-val">\${APPS.length}</div>
      <div class="stat-lbl">Apps</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">🔗 Quick Launch</div>
    <div class="grid">
      \${APPS.map((a, i) => \`<a class="card" href="\${a.url}" target="_blank" rel="noopener" style="animation-delay:\${(i * 0.03).toFixed(2)}s"><span class="emoji">\${a.emoji}</span><span class="label">\${a.name}</span></a>\`).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">🐳 Docker Containers</div>
    <div id="containers-loading">Loading containers…</div>
    <div id="container-grid" class="container-grid" style="display:none"></div>
  </div>

<!-- Logs Modal -->
<div class="modal-overlay" id="logs-modal" onclick="if(event.target===this)closeLogsModal()">
  <div class="modal">
    <div class="modal-head">
      <h2 id="logs-title">Logs</h2>
      <div class="modal-controls">
        <select id="logs-tail" onchange="refreshLogs()">
          <option value="50">50</option>
          <option value="100" selected>100</option>
          <option value="500">500</option>
        </select>
        <button onclick="refreshLogs()" title="Refresh">🔄</button>
        <button onclick="closeLogsModal()" title="Close">✕</button>
      </div>
    </div>
    <div class="modal-body">
      <div class="log-output" id="logs-content">Loading...</div>
    </div>
  </div>
</div>
</main>
<script>
function colorClass(pct) { return pct < 70 ? 'green' : pct < 90 ? 'yellow' : 'red'; }

function loadSystem() {
  fetch('/api/system').then(r=>r.json()).then(d=>{
    let html = '';
    html += '<div class="progress-wrap"><div class="progress-label"><span>CPU</span><span>'+d.cpuPercent+'%</span></div><div class="progress-bar"><div class="progress-fill '+colorClass(d.cpuPercent)+'" style="width:'+d.cpuPercent+'%"></div></div></div>';
    html += '<div class="progress-wrap"><div class="progress-label"><span>RAM '+d.memUsedGB+'/'+d.memTotalGB+' GB</span><span>'+d.memPercent+'%</span></div><div class="progress-bar"><div class="progress-fill '+colorClass(d.memPercent)+'" style="width:'+d.memPercent+'%"></div></div></div>';
    if(d.disks) d.disks.forEach(dk=>{
      html += '<div class="progress-wrap"><div class="progress-label"><span>Disk '+dk.source+' ('+dk.used+'/'+dk.size+')</span><span>'+dk.percent+'%</span></div><div class="progress-bar"><div class="progress-fill '+colorClass(dk.percent)+'" style="width:'+dk.percent+'%"></div></div></div>';
    });
    html += '<div class="health-row"><span class="health-label">Uptime</span><span class="health-value">'+d.uptime+'</span></div>';
    document.getElementById('system-health').innerHTML = html;
  }).catch(()=>{ document.getElementById('system-health').innerHTML='<div class="health-loading">Failed to load</div>'; });
}

function loadContainerHealth() {
  fetch('/api/containers').then(r=>r.json()).then(data=>{
    const running = data.filter(c=>c.state==='running').length;
    const stopped = data.filter(c=>c.state==='exited').length;
    const unhealthy = data.filter(c=>c.status&&c.status.includes('unhealthy')).length;
    let html = '<div>';
    html += '<span class="container-badge running">● '+running+' Running</span>';
    html += '<span class="container-badge stopped">● '+stopped+' Stopped</span>';
    if(unhealthy) html += '<span class="container-badge unhealthy">● '+unhealthy+' Unhealthy</span>';
    html += '</div>';
    html += '<div class="health-row" style="margin-top:.75rem"><span class="health-label">Total</span><span class="health-value">'+data.length+' containers</span></div>';
    document.getElementById('container-health').innerHTML = html;
    document.getElementById('stat-total').textContent=data.length;
    document.getElementById('stat-running').textContent=running;
    document.getElementById('stat-stopped').textContent=stopped;
  }).catch(()=>{});
}

function loadBackup() {
  fetch('/api/backup-status').then(r=>r.json()).then(d=>{
    if(d.error && !d.count){ document.getElementById('backup-health').innerHTML='<div class="health-loading">'+d.error+'</div>'; return; }
    let html = '<div class="health-row"><span class="health-label">Status</span><span class="health-value"><span class="backup-indicator '+d.status+'"></span>'+(d.status==='green'?'Healthy':d.status==='yellow'?'Warning':'Stale')+'</span></div>';
    html += '<div class="health-row"><span class="health-label">Latest</span><span class="health-value" style="font-size:.7rem;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+d.latest+'">'+d.latest+'</span></div>';
    html += '<div class="health-row"><span class="health-label">Age</span><span class="health-value">'+d.ageHours+'h ago</span></div>';
    html += '<div class="health-row"><span class="health-label">Size</span><span class="health-value">'+d.size+'</span></div>';
    html += '<div class="health-row"><span class="health-label">Backups kept</span><span class="health-value">'+d.count+'</span></div>';
    document.getElementById('backup-health').innerHTML = html;
  }).catch(()=>{ document.getElementById('backup-health').innerHTML='<div class="health-loading">Failed to load</div>'; });
}

function loadDeploys() {
  fetch('/api/recent-deploys').then(r=>r.json()).then(data=>{
    if(!data.length){ document.getElementById('deploy-health').innerHTML='<div class="health-loading">No deploy history</div>'; return; }
    document.getElementById('deploy-health').innerHTML = data.map(c=>'<div class="deploy-item"><span class="deploy-hash">'+c.hash+'</span><span class="deploy-msg">'+c.message+'</span><span class="deploy-time">'+c.timeAgo+'</span></div>').join('');
  }).catch(()=>{ document.getElementById('deploy-health').innerHTML='<div class="health-loading">Failed to load</div>'; });
}


function loadDbHealth() {
  fetch('/api/db-health').then(r=>r.json()).then(d=>{
    if(d.error){ document.getElementById('db-health').innerHTML='<div class="health-loading">'+d.error+'</div>'; return; }
    let html = '';
    html += '<div class="health-row"><span class="health-label">Version</span><span class="health-value">'+d.version+'</span></div>';
    html += '<div class="health-row"><span class="health-label">Uptime</span><span class="health-value">'+d.uptime+'</span></div>';
    const connPct = Math.round((d.connections.active + d.connections.idle) / d.connections.maxConnections * 100);
    html += '<div class="progress-wrap"><div class="progress-label"><span>Connections '+d.connections.active+' active / '+d.connections.idle+' idle / '+d.connections.total+' total</span><span>'+connPct+'%</span></div><div class="progress-bar"><div class="progress-fill '+colorClass(connPct)+'" style="width:'+connPct+'%"></div></div></div>';
    html += '<div style="margin-top:.5rem;font-size:.75rem;color:var(--dim);font-weight:600;margin-bottom:.4rem">Databases</div>';
    d.databases.forEach(function(db){
      const size = db.sizeMB >= 1024 ? (db.sizeMB/1024).toFixed(1)+' GB' : db.sizeMB.toFixed(1)+' MB';
      html += '<div class="health-row"><span class="health-label">'+db.name+'</span><span class="health-value">'+size+'</span></div>';
    });
    document.getElementById('db-health').innerHTML = html;
  }).catch(()=>{ document.getElementById('db-health').innerHTML='<div class="health-loading">Failed to load</div>'; });
}

// Container list (existing)
fetch('/api/containers').then(r=>r.json()).then(data=>{
  document.getElementById('containers-loading').style.display='none';
  const g=document.getElementById('container-grid');g.style.display='grid';
  const running=data.filter(c=>c.state==='running').length;
  const stopped=data.length-running;
  document.getElementById('stat-total').textContent=data.length;
  document.getElementById('stat-running').textContent=running;
  document.getElementById('stat-stopped').textContent=stopped;
  if(!data.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#444;padding:2rem">No containers found</div>';return}
  data.sort((a,b)=>(a.state==='running'?0:1)-(b.state==='running'?0:1)||a.name.localeCompare(b.name));
  g.innerHTML=data.map((c,i)=>\`<div class="ccard" style="animation-delay:\${(i*0.03).toFixed(2)}s">
    <div class="ccard-header"><span class="ccard-name">\${c.name}</span><span class="state \${c.state}">\${c.state}</span></div>
    <div class="ccard-image">\${c.image}</div>
    <div class="ccard-status">\${c.status}</div>
    <div class="ccard-actions">
      <button onclick="openLogs('\${c.name}')" title="View Logs">📋 Logs</button>
      <button onclick="restartContainer('\${c.name}',this)" title="Restart">🔄</button>
    </div>
  </div>\`).join('');
}).catch(()=>{document.getElementById('containers-loading').textContent='Could not connect to Docker';});

// Load health panels
loadSystem(); loadContainerHealth(); loadBackup(); loadDeploys(); loadDbHealth();
setInterval(()=>{ loadSystem(); loadContainerHealth(); }, 30000);

// Logs modal
let currentLogContainer = '';
function openLogs(name) {
  currentLogContainer = name;
  document.getElementById('logs-title').textContent = '📋 ' + name;
  document.getElementById('logs-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  refreshLogs();
}
function closeLogsModal() {
  document.getElementById('logs-modal').classList.remove('open');
  document.body.style.overflow = '';
}
function refreshLogs() {
  const tail = document.getElementById('logs-tail').value;
  const el = document.getElementById('logs-content');
  el.textContent = 'Loading...';
  fetch('/api/containers/' + encodeURIComponent(currentLogContainer) + '/logs?tail=' + tail)
    .then(r => r.text())
    .then(t => { el.textContent = t || '(no logs)'; el.scrollTop = el.scrollHeight; })
    .catch(e => { el.textContent = 'Error: ' + e.message; });
}

// Restart
function restartContainer(name, btn) {
  if (!confirm('Restart ' + name + '?')) return;
  btn.disabled = true;
  btn.classList.add('restarting');
  btn.textContent = '⏳';
  fetch('/api/containers/' + encodeURIComponent(name) + '/restart', { method: 'POST' })
    .then(r => r.json())
    .then(d => {
      btn.textContent = d.ok ? '✅' : '❌';
      btn.classList.remove('restarting');
      setTimeout(() => { btn.textContent = '🔄'; btn.disabled = false; location.reload(); }, 2000);
    })
    .catch(() => { btn.textContent = '❌'; btn.classList.remove('restarting'); setTimeout(() => { btn.textContent = '🔄'; btn.disabled = false; }, 2000); });
}
</script>
</body>
</html>`);
});



// Docker Stats API endpoint
app.get('/api/docker-stats', requireAuth, async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const statsPromises = containers.map(async (c) => {
      const container = docker.getContainer(c.Id);
      const name = c.Names[0]?.replace(/^\//, '').replace(/^lobsty-/, '');
      const info = { name, fullName: c.Names[0]?.replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status, id: c.Id.substring(0, 12) };
      
      if (c.State === 'running') {
        try {
          const stats = await container.stats({ stream: false });
          const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage.total_usage || 0);
          const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
          const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
          info.cpuPercent = systemDelta > 0 ? Math.round((cpuDelta / systemDelta) * numCpus * 10000) / 100 : 0;
          
          const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || stats.memory_stats.stats?.inactive_file || 0);
          info.memUsage = memUsage;
          info.memLimit = stats.memory_stats.limit;
          info.memPercent = info.memLimit > 0 ? Math.round((memUsage / info.memLimit) * 10000) / 100 : 0;
          
          let netRx = 0, netTx = 0;
          if (stats.networks) {
            Object.values(stats.networks).forEach(n => { netRx += n.rx_bytes; netTx += n.tx_bytes; });
          }
          info.netRx = netRx;
          info.netTx = netTx;
          
          let blockRead = 0, blockWrite = 0;
          if (stats.blkio_stats?.io_service_bytes_recursive) {
            stats.blkio_stats.io_service_bytes_recursive.forEach(s => {
              if (s.op === 'read' || s.op === 'Read') blockRead += s.value;
              if (s.op === 'write' || s.op === 'Write') blockWrite += s.value;
            });
          }
          info.blockRead = blockRead;
          info.blockWrite = blockWrite;
          info.pids = stats.pids_stats?.current || 0;
        } catch (e) {}
      }
      
      try {
        const inspect = await container.inspect();
        info.restartCount = inspect.RestartCount || 0;
        info.startedAt = inspect.State.StartedAt;
        info.finishedAt = inspect.State.FinishedAt;
      } catch (e) {}
      
      return info;
    });
    
    const results = await Promise.all(statsPromises);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ============ CONTAINERS STATS PAGE ============
app.get('/containers', requireAuth, (req, res) => {
  const user = req.user;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Container Stats - Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",-apple-system,sans-serif;background:var(--bg,#0a0a0f);color:var(--text,#e8e8f0);min-height:100vh}
.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}

header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08));padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.nav-links a{color:var(--dim,#888899);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;display:flex;align-items:center;transition:all .3s;backdrop-filter:blur(10px);-webkit-tap-highlight-color:transparent}
.nav-links a:hover,.nav-links a.active{color:#fff;border-color:#7c3aed;background:rgba(124,58,237,0.15)}

main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}

.summary-bar{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:16px;padding:1rem 1.25rem;backdrop-filter:blur(20px);margin-bottom:1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem}
.summary-text{font-size:.9rem;font-weight:600}
.summary-text span{font-variant-numeric:tabular-nums}
.summary-right{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}

.sort-btn{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));color:var(--dim,#888);border-radius:10px;padding:8px 14px;font-size:.75rem;font-weight:600;min-height:44px;min-width:44px;cursor:pointer;transition:all .2s;font-family:inherit;-webkit-tap-highlight-color:transparent}
.sort-btn:hover,.sort-btn.active{color:#fff;border-color:#7c3aed;background:rgba(124,58,237,0.15)}

.refresh-indicator{font-size:.7rem;color:var(--dim,#888);font-variant-numeric:tabular-nums}

.container-stats-grid{display:grid;grid-template-columns:1fr;gap:.75rem}

.cs-card{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:16px;padding:1.25rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:all .3s;animation:fadeUp .5s ease both}
.cs-card:hover{border-color:rgba(124,58,237,0.3);box-shadow:0 4px 20px rgba(124,58,237,0.1)}

.cs-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem;gap:.5rem}
.cs-name{font-weight:700;font-size:.95rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.cs-status{display:flex;align-items:center;gap:6px;flex-shrink:0}
.cs-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.cs-dot.running{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,0.5)}
.cs-dot.stopped{background:#f87171;box-shadow:0 0 8px rgba(248,113,113,0.5)}
.cs-state{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.cs-state.running{color:#34d399}
.cs-state.stopped{color:#f87171}

.cs-metrics{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}

.cs-metric{margin-bottom:0}
.cs-metric-label{font-size:.7rem;color:var(--dim,#888);font-weight:600;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;display:flex;justify-content:space-between;align-items:baseline}
.cs-metric-value{font-size:.8rem;font-weight:700;font-variant-numeric:tabular-nums}
.cs-progress{height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin-top:4px}
.cs-progress-fill{height:100%;border-radius:3px;transition:width .8s cubic-bezier(.4,0,.2,1);min-width:1px}
.cs-progress-fill.green{background:#34d399}
.cs-progress-fill.yellow{background:#fbbf24}
.cs-progress-fill.red{background:#f87171}
.cs-progress-fill.accent{background:linear-gradient(90deg,#7c3aed,#2563eb)}

.cs-details{display:grid;grid-template-columns:1fr 1fr;gap:.25rem .75rem;margin-top:.75rem;padding-top:.75rem;border-top:1px solid var(--glass-border,rgba(255,255,255,0.08))}
.cs-detail{display:flex;justify-content:space-between;font-size:.7rem}
.cs-detail-label{color:var(--dim,#888)}
.cs-detail-value{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}

#loading{text-align:center;color:var(--dim,#888);padding:3rem;font-size:.9rem}

@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}

@media(min-width:480px){
  .container-stats-grid{grid-template-columns:repeat(2,1fr)}
  header h1{font-size:1.2rem}
}
@media(min-width:768px){
  main{padding:1.5rem}
  header h1{font-size:1.3rem}
}
@media(min-width:1024px){
  .container-stats-grid{grid-template-columns:repeat(3,1fr)}
  main{padding:2rem}
}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>🐳 Container Stats</h1>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/containers" class="active">Containers</a>
    <a href="/status">Status</a>
    <a href="/storage">Storage</a>
    <a href="/health">Health</a>
    <a href="/logout">Logout</a>
  </div>
</header>
<main>
  <div class="summary-bar">
    <div class="summary-text" id="summary">Loading...</div>
    <div class="summary-right">
      <button class="sort-btn active" onclick="setSort('name')" id="sort-name">Name</button>
      <button class="sort-btn" onclick="setSort('cpu')" id="sort-cpu">CPU</button>
      <button class="sort-btn" onclick="setSort('mem')" id="sort-mem">Memory</button>
      <div class="refresh-indicator" id="refresh-timer">⟳ 15s</div>
    </div>
  </div>
  <div id="loading">Loading container stats...</div>
  <div class="container-stats-grid" id="grid" style="display:none"></div>
</main>
<script>
let currentSort = 'name';
let containersData = [];
let countdown = 15;
let timer;

function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(1) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}

function colorClass(pct) { return pct < 50 ? 'green' : pct < 80 ? 'yellow' : 'red'; }

function timeAgo(dateStr) {
  if (!dateStr || dateStr === '0001-01-01T00:00:00Z') return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 0) return '—';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return mins + 'm';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ' + (mins % 60) + 'm';
  const days = Math.floor(hrs / 24);
  return days + 'd ' + (hrs % 24) + 'h';
}

function setSort(s) {
  currentSort = s;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('sort-' + s).classList.add('active');
  renderCards();
}

function sortData(data) {
  const sorted = [...data];
  sorted.sort((a, b) => {
    // Running first
    const aRun = a.state === 'running' ? 0 : 1;
    const bRun = b.state === 'running' ? 0 : 1;
    if (aRun !== bRun) return aRun - bRun;
    
    if (currentSort === 'cpu') return (b.cpuPercent || 0) - (a.cpuPercent || 0);
    if (currentSort === 'mem') return (b.memUsage || 0) - (a.memUsage || 0);
    return a.name.localeCompare(b.name);
  });
  return sorted;
}

function renderCards() {
  const data = sortData(containersData);
  const running = data.filter(c => c.state === 'running');
  const totalCpu = running.reduce((s, c) => s + (c.cpuPercent || 0), 0);
  const totalMem = running.reduce((s, c) => s + (c.memUsage || 0), 0);
  
  document.getElementById('summary').innerHTML = 
    '<span style="color:#34d399">' + running.length + '</span> running, ' +
    '<span style="color:#fbbf24">' + (data.length - running.length) + '</span> stopped · ' +
    'CPU: <span>' + totalCpu.toFixed(1) + '%</span> · ' +
    'Memory: <span>' + fmtBytes(totalMem) + '</span>';
  
  document.getElementById('loading').style.display = 'none';
  const g = document.getElementById('grid');
  g.style.display = 'grid';
  
  g.innerHTML = data.map((c, i) => {
    const isRunning = c.state === 'running';
    const dotClass = isRunning ? 'running' : 'stopped';
    const cpuPct = c.cpuPercent || 0;
    const memPct = c.memPercent || 0;
    
    let metricsHtml = '';
    if (isRunning) {
      metricsHtml = '<div class="cs-metrics">' +
        '<div class="cs-metric"><div class="cs-metric-label"><span>CPU</span><span class="cs-metric-value">' + cpuPct.toFixed(1) + '%</span></div>' +
        '<div class="cs-progress"><div class="cs-progress-fill ' + colorClass(cpuPct) + '" style="width:' + Math.min(cpuPct, 100) + '%"></div></div></div>' +
        '<div class="cs-metric"><div class="cs-metric-label"><span>Memory</span><span class="cs-metric-value">' + memPct.toFixed(1) + '%</span></div>' +
        '<div class="cs-progress"><div class="cs-progress-fill ' + colorClass(memPct) + '" style="width:' + Math.min(memPct, 100) + '%"></div></div>' +
        '<div style="font-size:.65rem;color:var(--dim);margin-top:2px">' + fmtBytes(c.memUsage) + ' / ' + fmtBytes(c.memLimit) + '</div></div>' +
        '</div>';
    }
    
    let detailsHtml = '<div class="cs-details">';
    if (isRunning) {
      detailsHtml += '<div class="cs-detail"><span class="cs-detail-label">Net I/O</span><span class="cs-detail-value">' + fmtBytes(c.netRx) + ' / ' + fmtBytes(c.netTx) + '</span></div>';
      detailsHtml += '<div class="cs-detail"><span class="cs-detail-label">Block I/O</span><span class="cs-detail-value">' + fmtBytes(c.blockRead) + ' / ' + fmtBytes(c.blockWrite) + '</span></div>';
    }
    detailsHtml += '<div class="cs-detail"><span class="cs-detail-label">Restarts</span><span class="cs-detail-value">' + (c.restartCount || 0) + '</span></div>';
    detailsHtml += '<div class="cs-detail"><span class="cs-detail-label">Uptime</span><span class="cs-detail-value">' + (isRunning ? timeAgo(c.startedAt) : '—') + '</span></div>';
    detailsHtml += '</div>';
    
    return '<div class="cs-card" style="animation-delay:' + (i * 0.03).toFixed(2) + 's">' +
      '<div class="cs-header"><span class="cs-name">' + c.name + '</span>' +
      '<div class="cs-status"><div class="cs-dot ' + dotClass + '"></div><span class="cs-state ' + dotClass + '">' + c.state + '</span></div></div>' +
      metricsHtml + detailsHtml + '</div>';
  }).join('');
}

function loadStats() {
  fetch('/api/docker-stats').then(r => r.json()).then(data => {
    containersData = data;
    renderCards();
    countdown = 15;
  }).catch(() => {
    document.getElementById('loading').textContent = 'Failed to load container stats';
  });
}

loadStats();
timer = setInterval(() => {
  countdown--;
  if (countdown <= 0) {
    loadStats();
  }
  document.getElementById('refresh-timer').textContent = '⟳ ' + countdown + 's';
}, 1000);
</script>
</body>
</html>`);
});


// ============ APP STATUS PAGE ============
const axios = require("axios");

const STATUS_APPS = [
  { name: "Todo", port: 8090 },
  { name: "Board", port: 8091 },
  { name: "Budget", port: 8092 },
  { name: "Docs", port: 8093 },
  { name: "Drafts", port: 8094 },
  { name: "Shop", port: 8096 },
  { name: "Video Pipeline", port: 8097 },
  { name: "Monitor", port: 8098 },
  { name: "YouTube Studio", port: 8099 },
  { name: "Hardware Monitor", port: 8100 },
  { name: "Gear Inventory", port: 8101 },
  { name: "Benchmark Tracker", port: 8103 },
  { name: "Script Writer", port: 8104 },
  { name: "Sponsor Manager", port: 8105 },
  { name: "Content Ideas", port: 8106 },
  { name: "Gaming Logger", port: 8107 },
  { name: "Thumbnail Analyzer", port: 8108 },
  { name: "Stream Planner", port: 8109 },
  { name: "App Hub", port: 8110 },
  { name: "Landing Page", port: 8111 },
  { name: "Admin", port: 8112 },
  { name: "AI", port: 8113 },
];

app.get("/api/app-status", requireAuth, async (req, res) => {
  const results = await Promise.all(STATUS_APPS.map(async (app) => {
    const start = Date.now();
    try {
      const r = await axios.get(`http://host.docker.internal:${app.port}/`, { timeout: 3000, validateStatus: () => true });
      return { name: app.name, port: app.port, up: true, status: r.status, ms: Date.now() - start };
    } catch {
      return { name: app.name, port: app.port, up: false, status: 0, ms: Date.now() - start };
    }
  }));
  res.json({ apps: results, checked: new Date().toISOString() });
});

app.get("/status", requireAuth, (req, res) => {
  const user = req.user;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>System Status - Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",-apple-system,sans-serif;background:var(--bg,#0a0a0f);color:var(--text,#e8e8f0);min-height:100vh}
.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}
header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08));padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:.5rem;align-items:center}
.nav-links a{color:var(--dim,#888899);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;display:flex;align-items:center;transition:all .3s;backdrop-filter:blur(10px)}
.nav-links a:hover,.nav-links a.active{color:#fff;border-color:#7c3aed;background:rgba(124,58,237,0.15)}
main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}
.summary{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:16px;padding:1.25rem;backdrop-filter:blur(20px);margin-bottom:1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem}
.summary-count{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.summary-label{font-size:.85rem;color:var(--dim,#888899)}
.summary-time{font-size:.75rem;color:var(--dim,#888899)}
.status-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem}
.scard{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:14px;padding:1rem;backdrop-filter:blur(20px);transition:all .3s;animation:fadeUp .5s ease both}
.scard:hover{border-color:rgba(124,58,237,0.3);box-shadow:0 4px 20px rgba(124,58,237,0.1);transform:translateY(-2px)}
.scard-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem}
.scard-name{font-weight:700;font-size:.85rem}
.scard-port{color:var(--dim,#888899);font-size:.7rem;font-family:monospace}
.dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.dot.up{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,0.5)}
.dot.down{background:#f87171;box-shadow:0 0 8px rgba(248,113,113,0.5)}
.scard-meta{display:flex;justify-content:space-between;font-size:.7rem;color:var(--dim,#888899)}
.scard-ms{font-variant-numeric:tabular-nums}
.scard-http{font-family:monospace}
@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:480px){.status-grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:768px){.status-grid{grid-template-columns:repeat(4,1fr);gap:1rem}main{padding:1.5rem}header h1{font-size:1.3rem}}
@media(min-width:1024px){.status-grid{grid-template-columns:repeat(5,1fr)}main{padding:2rem}}
@media(min-width:1280px){.status-grid{grid-template-columns:repeat(6,1fr)}}
#loading{text-align:center;color:var(--dim,#888);padding:3rem;font-size:.9rem}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>📡 System Status</h1>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/containers">Containers</a>
    <a href="/status" class="active">Status</a>
    <a href="/storage">Storage</a>
    <a href="/health">Health</a>
    <a href="/logout">Logout</a>
  </div>
</header>
<main>
  <div class="summary">
    <div><div class="summary-count" id="count">—</div><div class="summary-label">services online</div></div>
    <div class="summary-time" id="checked">Checking...</div>
  </div>
  <div id="loading">Loading status...</div>
  <div class="status-grid" id="grid" style="display:none"></div>
</main>
<script>
function load(){
  fetch("/api/app-status").then(r=>r.json()).then(d=>{
    const up=d.apps.filter(a=>a.up).length;
    document.getElementById("count").textContent=up+"/"+d.apps.length;
    document.getElementById("checked").textContent="Last checked: "+new Date(d.checked).toLocaleTimeString();
    document.getElementById("loading").style.display="none";
    const g=document.getElementById("grid");g.style.display="grid";
    g.innerHTML=d.apps.map((a,i)=>{
      return '<div class="scard" style="animation-delay:'+(i*0.03).toFixed(2)+'s"><div class="scard-top"><div><div class="scard-name">'+a.name+'</div><div class="scard-port">:'+a.port+'</div></div><div class="dot '+(a.up?"up":"down")+'"></div></div><div class="scard-meta"><span class="scard-ms">'+a.ms+'ms</span><span class="scard-http">'+(a.up?"HTTP "+a.status:"DOWN")+'</span></div></div>';
    }).join("");
  }).catch(()=>{document.getElementById("loading").textContent="Failed to load status";});
}
load();
setInterval(load,30000);
</script>
</body>
</html>`);
});


// ============ STORAGE API ============
app.get('/api/storage', requireAuth, (req, res) => {
  try {
    const result = { disks: [], volumes: [], containers: [] };

    // Disk usage
    try {
      const dfOut = execSync('df -h --output=source,fstype,size,used,avail,pcent,target 2>/dev/null || df -h 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const lines = dfOut.trim().split('\n').slice(1);
      const seen = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 7 && !parts[0].startsWith('tmpfs') && !parts[0].startsWith('shm') && !parts[0].startsWith('overlay') && !seen.has(parts[0])) {
          seen.add(parts[0]);
          result.disks.push({ source: parts[0], fstype: parts[1], size: parts[2], used: parts[3], avail: parts[4], percent: parseInt(parts[5]) || 0, mount: parts[6] });
        }
      }
    } catch (e) {}

    // Docker volumes
    try {
      const volOut = execSync('docker system df -v 2>/dev/null', { encoding: 'utf8', timeout: 15000 });
      const volSection = volOut.split('VOLUME NAME');
      if (volSection.length > 1) {
        const volLines = volSection[1].trim().split('\n');
        for (const line of volLines) {
          if (!line.trim() || line.startsWith('CONTAINER')) break;
          const parts = line.trim().split(/\s{2,}/);
          if (parts.length >= 3) {
            result.volumes.push({ name: parts[0], links: parseInt(parts[1]) || 0, size: parts[2] });
          }
        }
      }
    } catch (e) {}

    // Docker container sizes
    try {
      const csOut = execSync('docker ps -a --format "{{.Names}}\\t{{.Size}}" --no-trunc 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
      const csLines = csOut.trim().split('\n').filter(Boolean);
      const containers = csLines.map(line => {
        const [name, size] = line.split('\t');
        return { name: name?.replace(/^lobsty-/, '') || '?', size: size || '0B' };
      });
      // Parse size for sorting
      function parseSize(s) {
        if (!s) return 0;
        const m = s.match(/([\d.]+)\s*(B|KB|MB|GB|TB|kB)/i);
        if (!m) return 0;
        const val = parseFloat(m[1]);
        const unit = m[2].toUpperCase();
        if (unit === 'TB') return val * 1e12;
        if (unit === 'GB') return val * 1e9;
        if (unit === 'MB') return val * 1e6;
        if (unit === 'KB' || unit === 'KB') return val * 1e3;
        return val;
      }
      containers.sort((a, b) => parseSize(b.size) - parseSize(a.size));
      result.containers = containers.slice(0, 10);
    } catch (e) {}

    // Docker system overview
    try {
      const sysOut = execSync('docker system df 2>/dev/null', { encoding: 'utf8', timeout: 10000 });
      const sysLines = sysOut.trim().split('\n').slice(1);
      result.dockerOverview = sysLines.map(line => {
        const parts = line.trim().split(/\s{2,}/);
        return { type: parts[0], total: parts[1], active: parts[2], size: parts[3], reclaimable: parts[4] };
      });
    } catch (e) {}

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ STORAGE PAGE ============
app.get('/storage', requireAuth, (req, res) => {
  const user = req.user;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Storage - Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",-apple-system,sans-serif;background:var(--bg,#0a0a0f);color:var(--text,#e8e8f0);min-height:100vh}
.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}
header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08));padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.nav-links a{color:var(--dim,#888899);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;display:flex;align-items:center;transition:all .3s;backdrop-filter:blur(10px)}
.nav-links a:hover,.nav-links a.active{color:#fff;border-color:#7c3aed;background:rgba(124,58,237,0.15)}
main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}
.section{margin-bottom:2rem}
.section-title{font-size:.85rem;font-weight:600;color:var(--dim,#888899);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--glass-border,rgba(255,255,255,0.08)),transparent)}
.card{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:16px;padding:1.25rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);animation:fadeUp .5s ease both;margin-bottom:.75rem}
.progress-wrap{margin-bottom:.75rem}
.progress-wrap:last-child{margin-bottom:0}
.progress-label{display:flex;justify-content:space-between;font-size:.75rem;margin-bottom:4px}
.progress-label span:first-child{color:var(--dim,#888899)}
.progress-label span:last-child{font-weight:700;font-variant-numeric:tabular-nums}
.progress-bar{height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden}
.progress-fill{height:100%;border-radius:4px;transition:width .8s cubic-bezier(.4,0,.2,1);min-width:2px}
.progress-fill.green{background:var(--green,#34d399)}
.progress-fill.yellow{background:var(--yellow,#fbbf24)}
.progress-fill.red{background:var(--red,#f87171)}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:.8rem}
th{text-align:left;color:var(--dim,#888899);font-weight:600;font-size:.7rem;text-transform:uppercase;letter-spacing:.04em;padding:.5rem .75rem;border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08))}
td{padding:.6rem .75rem;border-bottom:1px solid rgba(255,255,255,0.03);font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,0.02)}
.overview-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:1rem}
.overview-item{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:12px;padding:1rem;text-align:center}
.overview-item .val{font-size:1.2rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.overview-item .lbl{font-size:.7rem;color:var(--dim,#888899);text-transform:uppercase;margin-top:2px}
.refresh-info{font-size:.7rem;color:var(--dim,#888899);text-align:right;margin-bottom:1rem;font-variant-numeric:tabular-nums}
#loading{text-align:center;color:var(--dim,#888);padding:3rem;font-size:.9rem}
@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:480px){.overview-grid{grid-template-columns:repeat(4,1fr)}}
@media(min-width:768px){main{padding:1.5rem}header h1{font-size:1.3rem}}
@media(min-width:1024px){main{padding:2rem}}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>💾 Storage</h1>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/containers">Containers</a>
    <a href="/status">Status</a>
    <a href="/storage" class="active">Storage</a>
    <a href="/health">Health</a>
    <a href="/logout">Logout</a>
  </div>
</header>
<main>
  <div class="refresh-info" id="refresh-info">Loading...</div>
  <div id="loading">Loading storage data...</div>
  <div id="content" style="display:none">
    <div class="section">
      <div class="section-title">📊 Docker Overview</div>
      <div class="overview-grid" id="docker-overview"></div>
    </div>
    <div class="section">
      <div class="section-title">💽 Disk Usage</div>
      <div id="disk-usage"></div>
    </div>
    <div class="section">
      <div class="section-title">📦 Docker Volumes</div>
      <div class="card"><div class="table-wrap"><table id="volumes-table"><thead><tr><th>Volume</th><th>Links</th><th>Size</th></tr></thead><tbody></tbody></table></div></div>
    </div>
    <div class="section">
      <div class="section-title">🐳 Top 10 Largest Containers</div>
      <div class="card"><div class="table-wrap"><table id="containers-table"><thead><tr><th>Container</th><th>Size</th></tr></thead><tbody></tbody></table></div></div>
    </div>
  </div>
</main>
<script>
function colorClass(pct){return pct<60?'green':pct<80?'yellow':'red';}
let countdown=30;

function load(){
  fetch('/api/storage').then(r=>r.json()).then(d=>{
    document.getElementById('loading').style.display='none';
    document.getElementById('content').style.display='block';
    countdown=30;

    // Docker overview
    if(d.dockerOverview){
      document.getElementById('docker-overview').innerHTML=d.dockerOverview.map(o=>
        '<div class="overview-item"><div class="val">'+o.size+'</div><div class="lbl">'+o.type+'</div><div style="font-size:.65rem;color:var(--dim);margin-top:4px">'+o.total+' total · '+o.active+' active</div>'+(o.reclaimable?'<div style="font-size:.65rem;color:var(--yellow,#fbbf24);margin-top:2px">♻️ '+o.reclaimable+'</div>':'')+'</div>'
      ).join('');
    }

    // Disk usage with progress bars
    if(d.disks&&d.disks.length){
      document.getElementById('disk-usage').innerHTML=d.disks.map(dk=>
        '<div class="card"><div class="progress-wrap"><div class="progress-label"><span>'+dk.mount+' ('+dk.source+')</span><span>'+dk.percent+'%</span></div><div class="progress-bar"><div class="progress-fill '+colorClass(dk.percent)+'" style="width:'+dk.percent+'%"></div></div></div><div style="display:flex;justify-content:space-between;font-size:.7rem;color:var(--dim)"><span>Used: '+dk.used+'</span><span>Available: '+dk.avail+'</span><span>Total: '+dk.size+'</span></div></div>'
      ).join('');
    }

    // Volumes table
    const vbody=document.querySelector('#volumes-table tbody');
    vbody.innerHTML=d.volumes.map(v=>'<tr><td style="font-family:monospace;font-size:.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+v.name+'">'+v.name+'</td><td>'+v.links+'</td><td style="font-weight:600">'+v.size+'</td></tr>').join('')||'<tr><td colspan="3" style="text-align:center;color:var(--dim)">No volumes</td></tr>';

    // Containers table
    const cbody=document.querySelector('#containers-table tbody');
    cbody.innerHTML=d.containers.map(c=>'<tr><td>'+c.name+'</td><td style="font-weight:600">'+c.size+'</td></tr>').join('')||'<tr><td colspan="2" style="text-align:center;color:var(--dim)">No containers</td></tr>';
  }).catch(()=>{document.getElementById('loading').textContent='Failed to load storage data';});
}

load();
setInterval(()=>{
  countdown--;
  if(countdown<=0)load();
  document.getElementById('refresh-info').textContent='Auto-refresh in '+countdown+'s';
},1000);
</script>
</body>
</html>` );
});


// ============ HEALTH MONITOR ============
app.get('/api/health', requireAuth, async (req, res) => {
  const results = await Promise.allSettled(STATUS_APPS.map(async (a) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const start = Date.now();
    try {
      const r = await fetch(`http://host.docker.internal:${a.port}/`, { signal: controller.signal });
      clearTimeout(timeout);
      const ms = Date.now() - start;
      return { name: a.name, port: a.port, up: true, status: r.status, ms, slow: ms > 2000, checked: new Date().toISOString() };
    } catch (e) {
      clearTimeout(timeout);
      return { name: a.name, port: a.port, up: false, status: 0, ms: Date.now() - start, slow: false, checked: new Date().toISOString() };
    }
  }));
  const apps = results.map(r => r.status === 'fulfilled' ? r.value : r.reason);
  const healthy = apps.filter(a => a.up && !a.slow).length;
  res.json({ apps, healthy, total: apps.length, checked: new Date().toISOString() });
});

app.get('/health', requireAuth, (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css">
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Health Monitor - Admin</title>
<link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Inter",-apple-system,sans-serif;background:var(--bg,#0a0a0f);color:var(--text,#e8e8f0);min-height:100vh}
.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}
header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border,rgba(255,255,255,0.08));padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.5rem}
header h1{font-size:1.1rem;font-weight:700;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-links{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.nav-links a{color:var(--dim,#888899);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;display:flex;align-items:center;transition:all .3s;backdrop-filter:blur(10px);-webkit-tap-highlight-color:transparent}
.nav-links a:hover,.nav-links a.active{color:#fff;border-color:#7c3aed;background:rgba(124,58,237,0.15)}
main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}
.summary{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:16px;padding:1.25rem;backdrop-filter:blur(20px);margin-bottom:1.5rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem}
.summary-left{display:flex;align-items:baseline;gap:.75rem}
.summary-count{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.summary-label{font-size:.85rem;color:var(--dim,#888899)}
.summary-right{text-align:right}
.summary-time{font-size:.75rem;color:var(--dim,#888899)}
.summary-refresh{font-size:.7rem;color:var(--dim,#666);margin-top:.25rem}
.health-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem}
.hcard{background:var(--glass,rgba(255,255,255,0.05));border:1px solid var(--glass-border,rgba(255,255,255,0.08));border-radius:14px;padding:1rem;backdrop-filter:blur(20px);transition:all .3s;animation:fadeUp .5s ease both;position:relative;overflow:hidden}
.hcard::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0}
.hcard.up::before{background:var(--green,#34d399)}
.hcard.down::before{background:var(--red,#f87171)}
.hcard.slow::before{background:var(--yellow,#fbbf24)}
.hcard:hover{border-color:rgba(124,58,237,0.3);box-shadow:0 4px 20px rgba(124,58,237,0.1);transform:translateY(-2px)}
.hcard-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem}
.hcard-name{font-weight:700;font-size:.85rem}
.hcard-port{color:var(--dim,#888899);font-size:.7rem;font-family:monospace}
.dot{width:12px;height:12px;border-radius:50%;flex-shrink:0}
.dot.up{background:var(--green,#34d399);box-shadow:0 0 8px rgba(52,211,153,0.5)}
.dot.down{background:var(--red,#f87171);box-shadow:0 0 8px rgba(248,113,113,0.5)}
.dot.slow{background:var(--yellow,#fbbf24);box-shadow:0 0 8px rgba(251,191,36,0.5)}
.hcard-meta{display:flex;justify-content:space-between;font-size:.7rem;color:var(--dim,#888899)}
.hcard-ms{font-variant-numeric:tabular-nums}
.hcard-status{font-family:monospace}
.hcard-checked{font-size:.65rem;color:var(--dim,#666);margin-top:.4rem}
@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@media(min-width:480px){.health-grid{grid-template-columns:repeat(3,1fr)}}
@media(min-width:768px){.health-grid{grid-template-columns:repeat(4,1fr);gap:1rem}main{padding:1.5rem}header h1{font-size:1.3rem}}
@media(min-width:1024px){.health-grid{grid-template-columns:repeat(5,1fr)}main{padding:2rem}}
@media(min-width:1280px){.health-grid{grid-template-columns:repeat(6,1fr)}}
#loading{text-align:center;color:var(--dim,#888);padding:3rem;font-size:.9rem}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>🏥 App Health Monitor</h1>
  <div class="nav-links">
    <a href="/">Dashboard</a>
    <a href="/containers">Containers</a>
    <a href="/status">Status</a>
    <a href="/storage">Storage</a>
    <a href="/health" class="active">Health</a>
    <a href="/logout">Logout</a>
  </div>
</header>
<main>
  <div class="summary">
    <div class="summary-left">
      <div class="summary-count" id="count">—</div>
      <div class="summary-label">apps healthy</div>
    </div>
    <div class="summary-right">
      <div class="summary-time" id="checked">Checking...</div>
      <div class="summary-refresh" id="refresh-info">Auto-refresh in 60s</div>
    </div>
  </div>
  <div id="loading">Loading health status...</div>
  <div class="health-grid" id="grid" style="display:none"></div>
</main>
<script>
let countdown=60;
function load(){
  countdown=60;
  fetch("/api/health").then(r=>r.json()).then(d=>{
    document.getElementById("count").textContent=d.healthy+"/"+d.total;
    document.getElementById("checked").textContent="Last checked: "+new Date(d.checked).toLocaleTimeString();
    document.getElementById("loading").style.display="none";
    const g=document.getElementById("grid");g.style.display="grid";
    g.innerHTML=d.apps.map((a,i)=>{
      const cls=!a.up?"down":a.slow?"slow":"up";
      const label=!a.up?"DOWN":a.slow?"SLOW ("+a.ms+"ms)":"HTTP "+a.status;
      return '<div class="hcard '+cls+'" style="animation-delay:'+(i*0.03).toFixed(2)+'s"><div class="hcard-top"><div><div class="hcard-name">'+a.name+'</div><div class="hcard-port">:'+a.port+'</div></div><div class="dot '+cls+'"></div></div><div class="hcard-meta"><span class="hcard-ms">'+a.ms+'ms</span><span class="hcard-status">'+label+'</span></div><div class="hcard-checked">Checked: '+new Date(a.checked).toLocaleTimeString()+'</div></div>';
    }).join("");
  }).catch(()=>{document.getElementById("loading").textContent="Failed to load health status";});
}
load();
setInterval(()=>{
  countdown--;
  if(countdown<=0)load();
  document.getElementById('refresh-info').textContent='Auto-refresh in '+countdown+'s';
},1000);
</script>
</body>
</html>`);
});

app.listen(3000, () => console.log("Admin dashboard running on :3000"));
