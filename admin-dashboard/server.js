const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const Docker = require('dockerode');

const app = express();
app.use(express.static("public"));
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

/* BG orbs */
.bg-orbs{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.orb{position:absolute;border-radius:50%;filter:blur(80px);opacity:.12;animation:drift 25s ease-in-out infinite}
.orb:nth-child(1){width:350px;height:350px;background:#7c3aed;top:-80px;right:-80px}
.orb:nth-child(2){width:300px;height:300px;background:#2563eb;bottom:-60px;left:-60px;animation-delay:-10s}
@keyframes drift{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,-20px)}}

/* Header */
header{position:sticky;top:0;z-index:10;background:rgba(10,10,15,0.8);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--glass-border);padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:1.1rem;font-weight:700;background:var(--gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.user-area{display:flex;align-items:center;gap:.5rem}
.user-area img{width:32px;height:32px;border-radius:50%;border:2px solid var(--glass-border)}
.user-area .name{font-size:.85rem;font-weight:500;display:none}
a.logout{color:var(--dim);text-decoration:none;padding:8px 14px;border:1px solid var(--glass-border);border-radius:10px;font-size:.8rem;font-weight:500;min-height:44px;min-width:44px;display:flex;align-items:center;justify-content:center;transition:all .3s;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(10px)}
a.logout:hover,a.logout:active{color:#fff;border-color:var(--accent);background:rgba(124,58,237,0.15);box-shadow:0 0 15px var(--glow)}

main{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:calc(1rem + env(safe-area-inset-bottom,0px))}

/* Stats row */
.stats-row{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:1.5rem}
.stat{background:var(--glass);border:1px solid var(--glass-border);border-radius:16px;padding:1rem;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);transition:all .3s}
.stat:hover{border-color:rgba(124,58,237,0.3);box-shadow:0 4px 20px rgba(124,58,237,0.1)}
.stat-val{font-size:1.6rem;font-weight:800;background:var(--gradient);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-lbl{font-size:.7rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;margin-top:2px}

/* Section headers */
.section-title{font-size:.85rem;font-weight:600;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem}
.section-title::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--glass-border),transparent)}
.section{margin-bottom:2rem}

/* App grid */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem}
.card{background:var(--glass);border:1px solid var(--glass-border);border-radius:14px;padding:1rem .75rem;text-decoration:none;color:var(--text);transition:all .3s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;align-items:center;gap:.35rem;text-align:center;min-height:80px;justify-content:center;-webkit-tap-highlight-color:transparent;backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);position:relative;overflow:hidden}
.card::before{content:'';position:absolute;inset:0;background:var(--gradient);opacity:0;transition:opacity .3s}
.card:active{transform:scale(.96)}
.card:active::before,.card:hover::before{opacity:.08}
.card:hover{border-color:rgba(124,58,237,0.4);box-shadow:0 8px 32px var(--glow);transform:translateY(-2px)}
.card>*{position:relative;z-index:1}
.card .emoji{font-size:1.75rem;line-height:1}
.card .label{font-size:.8rem;font-weight:600;line-height:1.2}

/* Container cards */
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

/* Responsive */
@media(min-width:480px){
  .grid{grid-template-columns:repeat(3,1fr)}
  .container-grid{grid-template-columns:repeat(2,1fr)}
  .user-area .name{display:inline}
  .stats-row{grid-template-columns:repeat(4,1fr)}
}
@media(min-width:768px){
  main{padding:1.5rem}
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

/* Animations */
.card,.ccard,.stat{animation:fadeUp .5s ease both}
@keyframes fadeUp{from{opacity:0;transform:translateY(15px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
</style>
</head>
<body>
<div class="bg-orbs"><div class="orb"></div><div class="orb"></div></div>
<header>
  <h1>⚡ Admin Dashboard</h1>
  <div class="user-area">
    ${user.photo ? `<img src="${user.photo}" alt="">` : ''}
    <span class="name">${user.name}</span>
    <a href="/logout" class="logout">Logout</a>
  </div>
</header>
<main>
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
      <div class="stat-val">${APPS.length}</div>
      <div class="stat-lbl">Apps</div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">🔗 Quick Launch</div>
    <div class="grid">
      ${APPS.map((a, i) => `<a class="card" href="${a.url}" target="_blank" rel="noopener" style="animation-delay:${(i * 0.03).toFixed(2)}s"><span class="emoji">${a.emoji}</span><span class="label">${a.name}</span></a>`).join('')}
    </div>
  </div>

  <div class="section">
    <div class="section-title">🐳 Docker Containers</div>
    <div id="containers-loading">Loading containers…</div>
    <div id="container-grid" class="container-grid" style="display:none"></div>
  </div>
</main>
<script>
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
  </div>\`).join('');
}).catch(()=>{document.getElementById('containers-loading').textContent='Could not connect to Docker';});
</script>
</body>
</html>`);
});

app.listen(3000, () => console.log('Admin dashboard running on :3000'));
