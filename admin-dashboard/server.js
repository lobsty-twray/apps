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
  res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><link rel="icon" type="image/svg+xml" href="/favicons/favicon.svg"><link rel="icon" type="image/x-icon" href="/favicons/favicon.ico"><link rel="apple-touch-icon" sizes="180x180" href="/favicons/apple-touch-icon.png">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Admin Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;-webkit-text-size-adjust:100%}

/* Header - mobile first */
header{background:#12121a;border-bottom:1px solid #1e1e2e;padding:.75rem 1rem;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10}
header h1{font-size:1.1rem;background:linear-gradient(135deg,#7c3aed,#2563eb);-webkit-background-clip:text;-webkit-text-fill-color:transparent;white-space:nowrap}
.user{display:flex;align-items:center;gap:.5rem}
.user img{width:32px;height:32px;border-radius:50%;flex-shrink:0}
.user span{font-size:.85rem;font-weight:500;display:none}
a.logout{color:#888;text-decoration:none;padding:.5rem .75rem;border:1px solid #333;border-radius:8px;font-size:.8rem;min-height:44px;min-width:44px;display:flex;align-items:center;justify-content:center;transition:all .2s;-webkit-tap-highlight-color:transparent}
a.logout:hover,a.logout:active{color:#fff;border-color:#555;background:#1a1a25}

/* Main */
main{max-width:1400px;margin:0 auto;padding:1rem;padding-bottom:env(safe-area-inset-bottom,1rem)}
h2{font-size:.9rem;color:#888;margin-bottom:.75rem;text-transform:uppercase;letter-spacing:.06em}

/* App grid - mobile: 2 columns */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.75rem;margin-bottom:2rem}
.card{background:#16161f;border:1px solid #1e1e2e;border-radius:12px;padding:1rem .75rem;text-decoration:none;color:#e0e0e0;transition:all .2s;display:flex;flex-direction:column;align-items:center;gap:.4rem;text-align:center;min-height:80px;justify-content:center;-webkit-tap-highlight-color:transparent}
.card:active{transform:scale(.96);background:#1a1a28}
.card .emoji{font-size:1.75rem;line-height:1}
.card .label{font-size:.8rem;font-weight:500;line-height:1.2;word-break:break-word}

/* Docker container cards - mobile first */
.container-grid{display:grid;grid-template-columns:1fr;gap:.75rem;margin-bottom:2rem}
.ccard{background:#16161f;border:1px solid #1e1e2e;border-radius:12px;padding:1rem;overflow:hidden}
.ccard-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;gap:.5rem}
.ccard-name{font-weight:600;font-size:.9rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ccard-image{color:#666;font-size:.75rem;margin-bottom:.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccard-status{color:#999;font-size:.8rem}
.state{padding:.2rem .6rem;border-radius:6px;font-size:.7rem;font-weight:700;text-transform:uppercase;white-space:nowrap;flex-shrink:0}
.state.running{background:#064e3b;color:#34d399}
.state.exited{background:#450a0a;color:#f87171}
.state.created,.state.paused,.state.restarting{background:#422006;color:#fbbf24}
#containers-loading{text-align:center;color:#555;padding:2rem;font-size:.9rem}

/* Section divider */
.section{margin-bottom:2rem}

/* 480px+ (large phones, foldable inner screens) */
@media(min-width:480px){
  .grid{grid-template-columns:repeat(3,1fr)}
  .container-grid{grid-template-columns:repeat(2,1fr)}
  .user span{display:inline}
  header{padding:.75rem 1.25rem}
}

/* 768px+ (tablets, unfolded foldables) */
@media(min-width:768px){
  main{padding:1.5rem}
  .grid{grid-template-columns:repeat(4,1fr);gap:1rem}
  .container-grid{grid-template-columns:repeat(2,1fr);gap:1rem}
  .card{padding:1.25rem 1rem;min-height:100px}
  .card .emoji{font-size:2rem}
  .card .label{font-size:.85rem}
  header h1{font-size:1.3rem}
  h2{font-size:1rem;margin-bottom:1rem}
}

/* 1024px+ (desktop) */
@media(min-width:1024px){
  main{padding:2rem}
  .grid{grid-template-columns:repeat(5,1fr)}
  .container-grid{grid-template-columns:repeat(3,1fr)}
  .card:hover{border-color:#7c3aed;transform:translateY(-2px);box-shadow:0 4px 20px rgba(124,58,237,.15)}
  a.logout:hover{color:#fff;border-color:#555}
}

@media(min-width:1280px){
  .grid{grid-template-columns:repeat(7,1fr)}
  .container-grid{grid-template-columns:repeat(4,1fr)}
}
</style></head><body>
<header>
  <h1>⚡ Admin</h1>
  <div class="user">
    ${user.photo ? `<img src="${user.photo}" alt="">` : ''}
    <span>${user.name}</span>
    <a href="/logout" class="logout">Logout</a>
  </div>
</header>
<main>
  <div class="section">
    <h2>🔗 Apps</h2>
    <div class="grid">
      ${APPS.map(a => `<a class="card" href="${a.url}" target="_blank" rel="noopener"><span class="emoji">${a.emoji}</span><span class="label">${a.name}</span></a>`).join('')}
    </div>
  </div>
  <div class="section">
    <h2>🐳 Docker Containers</h2>
    <div id="containers-loading">Loading containers…</div>
    <div id="container-grid" class="container-grid" style="display:none"></div>
  </div>
</main>
<script>
fetch('/api/containers').then(r=>r.json()).then(data=>{
  document.getElementById('containers-loading').style.display='none';
  const g=document.getElementById('container-grid');g.style.display='grid';
  if(!data.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#555;padding:2rem">No containers found</div>';return}
  data.sort((a,b)=>(a.state==='running'?0:1)-(b.state==='running'?0:1)||a.name.localeCompare(b.name));
  g.innerHTML=data.map(c=>\`<div class="ccard">
    <div class="ccard-header"><span class="ccard-name">\${c.name}</span><span class="state \${c.state}">\${c.state}</span></div>
    <div class="ccard-image">\${c.image}</div>
    <div class="ccard-status">\${c.status}</div>
  </div>\`).join('');
}).catch(()=>{document.getElementById('containers-loading').textContent='Could not connect to Docker';});
</script></body></html>`);
});

app.listen(3000, () => console.log('Admin dashboard running on :3000'));
