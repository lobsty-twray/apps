const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Docker = require('dockerode');
const os = require('os');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
loadSystem(); loadContainerHealth(); loadBackup(); loadDeploys();
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

app.listen(3000, () => console.log('Admin dashboard running on :3000'));
