const express = require('express');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
const port = 3000;
const PASSWORD = process.env.ADMIN_PASSWORD || 'ray2026';
const SESSION_SECRET = crypto.randomBytes(32).toString('hex');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session tokens
const sessions = new Set();

function authMiddleware(req, res, next) {
  const token = req.cookies?.session;
  if (token && sessions.has(token)) return next();
  if (req.path.startsWith('/api/') && req.headers['x-api-key'] === PASSWORD) return next();
  if (req.path === '/login' && req.method === 'POST') return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.send(loginPage());
}

app.post('/login', (req, res) => {
  if (req.body.password === PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.add(token);
    res.cookie('session', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000 });
    return res.redirect('/');
  }
  res.send(loginPage('Wrong password'));
});

app.use(authMiddleware);

// --- API Routes ---
app.get('/api/activity', async (req, res) => {
  const r = await pool.query('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 100');
  res.json(r.rows);
});
app.post('/api/activity', async (req, res) => {
  const { type, label, details, status } = req.body;
  const r = await pool.query('INSERT INTO activity_log(type,label,details,status) VALUES($1,$2,$3,$4) RETURNING *', [type, label, details, status || 'info']);
  res.json(r.rows[0]);
});

app.get('/api/tokens/summary', async (req, res) => {
  const today = await pool.query("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM token_usage WHERE created_at >= CURRENT_DATE");
  const week = await pool.query("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM token_usage WHERE created_at >= date_trunc('week', CURRENT_DATE)");
  const month = await pool.query("SELECT COALESCE(SUM(input_tokens),0) as input, COALESCE(SUM(output_tokens),0) as output FROM token_usage WHERE created_at >= date_trunc('month', CURRENT_DATE)");
  res.json({ today: today.rows[0], week: week.rows[0], month: month.rows[0] });
});
app.post('/api/tokens', async (req, res) => {
  const { session_type, input_tokens, output_tokens, model, label } = req.body;
  const r = await pool.query('INSERT INTO token_usage(session_type,input_tokens,output_tokens,model,label) VALUES($1,$2,$3,$4,$5) RETURNING *', [session_type, input_tokens, output_tokens, model, label]);
  res.json(r.rows[0]);
});

app.get('/api/status', async (req, res) => {
  const r = await pool.query('SELECT * FROM agent_status ORDER BY updated_at DESC LIMIT 1');
  res.json(r.rows[0] || { status: 'idle', details: 'No status yet' });
});
app.post('/api/status', async (req, res) => {
  const { status, details } = req.body;
  await pool.query('DELETE FROM agent_status');
  const r = await pool.query('INSERT INTO agent_status(status,details,updated_at) VALUES($1,$2,NOW()) RETURNING *', [status, details]);
  res.json(r.rows[0]);
});

app.get('/api/kanban', async (req, res) => {
  const r = await pool.query('SELECT * FROM kanban_cards ORDER BY position');
  const grouped = { backlog: [], in_progress: [], testing: [], done: [] };
  r.rows.forEach(c => { if (grouped[c.column_name]) grouped[c.column_name].push(c); });
  res.json(grouped);
});
app.post('/api/kanban', async (req, res) => {
  const { title, description, url, port: p, column_name, position } = req.body;
  const r = await pool.query('INSERT INTO kanban_cards(title,description,url,port,column_name,position) VALUES($1,$2,$3,$4,$5,$6) RETURNING *', [title, description, url, p, column_name || 'backlog', position || 0]);
  res.json(r.rows[0]);
});
app.put('/api/kanban/:id', async (req, res) => {
  const { title, description, url, port: p, column_name, position } = req.body;
  const r = await pool.query('UPDATE kanban_cards SET title=COALESCE($1,title), description=COALESCE($2,description), url=COALESCE($3,url), port=COALESCE($4,port), column_name=COALESCE($5,column_name), position=COALESCE($6,position), updated_at=NOW() WHERE id=$7 RETURNING *', [title, description, url, p, column_name, position, req.params.id]);
  res.json(r.rows[0]);
});
app.delete('/api/kanban/:id', async (req, res) => {
  await pool.query('DELETE FROM kanban_cards WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/docker', (req, res) => {
  try {
    const out = execSync('docker ps --format "{{.Names}}\\t{{.Status}}\\t{{.Ports}}"', { timeout: 5000 }).toString();
    const containers = out.trim().split('\n').filter(Boolean).map(line => {
      const [name, status, ports] = line.split('\t');
      return { name, status, ports, running: status?.startsWith('Up') };
    });
    res.json(containers);
  } catch(e) {
    res.json([]);
  }
});

app.get('/', (req, res) => res.send(dashboardHTML()));

// --- Init DB & Seed ---
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kanban_cards (
      id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT, url TEXT, port INTEGER,
      column_name TEXT DEFAULT 'backlog', position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY, type TEXT, label TEXT, details TEXT, status TEXT DEFAULT 'info',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY, session_type TEXT, input_tokens INTEGER, output_tokens INTEGER,
      model TEXT, label TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_status (
      id SERIAL PRIMARY KEY, status TEXT DEFAULT 'idle', details TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const { rows } = await pool.query('SELECT COUNT(*) as c FROM kanban_cards');
  if (parseInt(rows[0].c) === 0) {
    const done = [
      ['twray.dev', 'Personal landing page', 'https://twray.dev', 8111],
      ['admin.twray.dev', 'Admin dashboard', 'https://admin.twray.dev', 8112],
      ['ai.twray.dev', 'Open WebUI', 'https://ai.twray.dev', 8113],
      ['monitor.twray.dev', 'Restock monitor', 'https://monitor.twray.dev', 8098],
      ['board.twray.dev', 'Kanban board', 'https://board.twray.dev', 8091],
      ['docs.twray.dev', 'Docs', 'https://docs.twray.dev', 8093],
      ['drafts.twray.dev', 'Drafts', 'https://drafts.twray.dev', 8094],
      ['shop.twray.dev', 'Shop', 'https://shop.twray.dev', 8096],
      ['video-pipeline.twray.dev', 'Video pipeline', 'https://video-pipeline.twray.dev', 8097],
      ['youtube-studio.twray.dev', 'YouTube studio', 'https://youtube-studio.twray.dev', 8099],
      ['hardware-monitor.twray.dev', 'Hardware monitor', 'https://hardware-monitor.twray.dev', 8100],
      ['gear-inventory.twray.dev', 'Gear inventory', 'https://gear-inventory.twray.dev', 8101],
      ['benchmark-tracker.twray.dev', 'Benchmarks', 'https://benchmark-tracker.twray.dev', 8103],
      ['script-writer.twray.dev', 'Script writer', 'https://script-writer.twray.dev', 8104],
      ['sponsor-manager.twray.dev', 'Sponsor manager', 'https://sponsor-manager.twray.dev', 8105],
      ['content-ideas.twray.dev', 'Content ideas', 'https://content-ideas.twray.dev', 8106],
      ['gaming-logger.twray.dev', 'Gaming logger', 'https://gaming-logger.twray.dev', 8107],
      ['thumbnail-analyzer.twray.dev', 'Thumbnail analyzer', 'https://thumbnail-analyzer.twray.dev', 8108],
      ['stream-planner.twray.dev', 'Stream planner', 'https://stream-planner.twray.dev', 8109],
      ['app-hub.twray.dev', 'App hub', 'https://app-hub.twray.dev', 8110],
      ['komodo.twray.dev', 'Komodo', 'https://komodo.twray.dev', 9120],
      ['netdata.twray.dev', 'Netdata', 'https://netdata.twray.dev', 19999],
      ['pihole.twray.dev', 'Pi-hole', 'https://pihole.twray.dev', 8053],
    ];
    for (let i = 0; i < done.length; i++) {
      await pool.query('INSERT INTO kanban_cards(title,description,url,port,column_name,position) VALUES($1,$2,$3,$4,$5,$6)', [...done[i], 'done', i]);
    }
    const inProgress = [
      ['RTX 5090 inference server', 'Waiting for IP', null, null],
      ['Google OAuth for Cloudflare', 'Waiting for Ray', null, null],
      ['Buy Me a Coffee', 'Waiting for account', null, null],
    ];
    for (let i = 0; i < inProgress.length; i++) {
      await pool.query('INSERT INTO kanban_cards(title,description,url,port,column_name,position) VALUES($1,$2,$3,$4,$5,$6)', [...inProgress[i], 'in_progress', i]);
    }
    const backlog = [
      ['Best Buy API integration', 'API integration for monitor', null, null],
      ['Git secrets cleanup', 'Clean up leaked secrets', null, null],
      ['Gemini image generation for twray.dev', 'AI-generated images', null, null],
    ];
    for (let i = 0; i < backlog.length; i++) {
      await pool.query('INSERT INTO kanban_cards(title,description,url,port,column_name,position) VALUES($1,$2,$3,$4,$5,$6)', [...backlog[i], 'backlog', i]);
    }
    await pool.query("INSERT INTO agent_status(status,details) VALUES('idle','Dashboard deployed')");
    console.log('Seeded initial data');
  }

  app.listen(port, () => console.log(`Lobsty Dashboard running on port ${port}`));
}

init().catch(e => { console.error(e); process.exit(1); });

// --- HTML ---
function loginPage(error = '') {
  return `<!DOCTYPE html><html><head><link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🦞 Lobsty Login</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:40px;width:90%;max-width:360px;backdrop-filter:blur(20px);text-align:center}
h1{font-size:2em;margin-bottom:8px}
p.sub{color:#888;margin-bottom:24px}
input{width:100%;padding:14px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;background:rgba(255,255,255,0.05);color:#fff;font-size:16px;margin-bottom:16px;outline:none}
input:focus{border-color:#00d4ff}
button{width:100%;padding:14px;border:none;border-radius:10px;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;font-size:16px;font-weight:600;cursor:pointer}
.err{color:#ff4757;margin-bottom:12px;font-size:14px}
</style></head><body>
<form class="login" method="POST" action="/login">
<h1>🦞</h1><p class="sub">Lobsty Command Center</p>
${error ? `<div class="err">${error}</div>` : ''}
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Enter</button>
</form></body></html>`;
}

function dashboardHTML() {
  return `<!DOCTYPE html><html><head><link rel="stylesheet" href="http://shared-assets:3000/design-tokens.css"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>🦞 Lobsty Command Center</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--card:rgba(255,255,255,0.04);--border:rgba(255,255,255,0.08);--blue:#00d4ff;--purple:#7c3aed;--green:#00e676;--yellow:#ffd600;--red:#ff4757;--text:#e0e0e0;--muted:#888}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;backdrop-filter:blur(12px)}
h1{font-size:1.5em;padding:12px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dot{width:12px;height:12px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot.idle{background:var(--green)}.dot.thinking{background:var(--yellow)}.dot.subagent{background:var(--blue)}.dot.heartbeat{background:var(--purple)}
.grid{display:grid;gap:12px;margin-bottom:12px}
.grid-2{grid-template-columns:1fr 1fr}
.grid-4{grid-template-columns:repeat(4,1fr)}
@media(max-width:768px){.grid-2,.grid-4{grid-template-columns:1fr}}
@media(min-width:769px) and (max-width:1024px){.grid-4{grid-template-columns:1fr 1fr}}
.section-title{font-size:.85em;text-transform:uppercase;color:var(--muted);letter-spacing:1px;margin:16px 0 8px;font-weight:600}
.stat{font-size:2em;font-weight:700;background:linear-gradient(135deg,var(--blue),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-label{font-size:.8em;color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;font-size:.75em;font-weight:600}
.badge.info{background:rgba(0,212,255,0.15);color:var(--blue)}
.badge.success{background:rgba(0,230,118,0.15);color:var(--green)}
.badge.warning{background:rgba(255,214,0,0.15);color:var(--yellow)}
.badge.error{background:rgba(255,71,87,0.15);color:var(--red)}
.activity-item{padding:8px 0;border-bottom:1px solid var(--border);font-size:.85em;display:flex;justify-content:space-between;align-items:center;gap:8px}
.activity-list{max-height:300px;overflow-y:auto}
.kanban{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:768px){.kanban{grid-template-columns:1fr}}
@media(min-width:769px) and (max-width:1024px){.kanban{grid-template-columns:1fr 1fr}}
.kanban-col{background:rgba(255,255,255,0.02);border-radius:12px;padding:10px;min-height:100px}
.kanban-col h3{font-size:.8em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
.kanban-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;font-size:.85em}
.kanban-card .title{font-weight:600;margin-bottom:4px}
.kanban-card .desc{color:var(--muted);font-size:.8em}
.kanban-card a{color:var(--blue);text-decoration:none;font-size:.8em}
.kanban-card .port-badge{background:rgba(124,58,237,0.2);color:var(--purple);padding:1px 6px;border-radius:4px;font-size:.7em;margin-left:4px}
.kanban-card .actions{display:flex;gap:4px;margin-top:6px}
.kanban-card .actions button{padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--muted);font-size:.75em;cursor:pointer;min-height:32px}
.kanban-card .actions button:hover{background:rgba(255,255,255,0.05)}
.docker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.docker-card{font-size:.8em;display:flex;align-items:center;gap:8px}
.docker-card .name{font-weight:600}
.docker-card .uptime{color:var(--muted);font-size:.85em}
.add-btn{width:100%;padding:8px;border:1px dashed var(--border);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:.8em;min-height:44px}
.add-btn:hover{background:rgba(255,255,255,0.03)}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;z-index:100}
.modal-bg.open{display:flex}
.modal{background:#14141f;border:1px solid var(--border);border-radius:16px;padding:24px;width:90%;max-width:400px}
.modal h3{margin-bottom:12px}
.modal input,.modal select,.modal textarea{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:rgba(255,255,255,0.05);color:#fff;font-size:14px;margin-bottom:10px;outline:none}
.modal textarea{height:60px;resize:vertical}
.modal .btns{display:flex;gap:8px;margin-top:8px}
.modal .btns button{flex:1;padding:10px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;min-height:44px}
.btn-primary{background:linear-gradient(135deg,var(--blue),var(--purple));color:#fff}
.btn-secondary{background:rgba(255,255,255,0.1);color:#fff}
.btn-danger{background:rgba(255,71,87,0.2);color:var(--red)}
.bar{height:6px;border-radius:3px;background:rgba(255,255,255,0.1);margin-top:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--blue),var(--purple))}
</style></head><body>
<h1>🦞 Lobsty Command Center <span class="dot idle" id="statusDot"></span></h1>

<div class="section-title">Status & Tokens</div>
<div class="grid grid-2">
  <div class="card" id="statusCard">
    <div class="stat" id="statusText">idle</div>
    <div class="stat-label" id="statusDetails">Loading...</div>
  </div>
  <div class="card">
    <div style="display:flex;gap:16px;flex-wrap:wrap">
      <div><div class="stat" id="tokensToday">0</div><div class="stat-label">Today (in/out)</div></div>
      <div><div class="stat" id="tokensWeek">0</div><div class="stat-label">This Week</div></div>
    </div>
    <div class="bar" style="margin-top:12px"><div class="bar-fill" id="tokenBar" style="width:0%"></div></div>
    <div class="stat-label" style="margin-top:4px" id="tokenBarLabel">0 tokens</div>
  </div>
</div>

<div class="section-title">Activity Log</div>
<div class="card">
  <div class="activity-list" id="activityList"><div class="stat-label">Loading...</div></div>
</div>

<div class="section-title">Kanban Board</div>
<div class="kanban" id="kanban"></div>

<div class="section-title">Docker Containers</div>
<div class="card"><div class="docker-grid" id="dockerGrid"><div class="stat-label">Loading...</div></div></div>

<div class="modal-bg" id="modalBg">
  <div class="modal">
    <h3 id="modalTitle">Add Card</h3>
    <input id="mTitle" placeholder="Title">
    <textarea id="mDesc" placeholder="Description"></textarea>
    <input id="mUrl" placeholder="URL (optional)">
    <input id="mPort" placeholder="Port (optional)" type="number">
    <select id="mCol"><option value="backlog">Backlog</option><option value="in_progress">In Progress</option><option value="testing">Testing</option><option value="done">Done</option></select>
    <input type="hidden" id="mId">
    <div class="btns">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-danger" id="mDel" style="display:none" onclick="deleteCard()">Delete</button>
      <button class="btn-primary" onclick="saveCard()">Save</button>
    </div>
  </div>
</div>

<script>
const $ = id => document.getElementById(id);
const colNames = {backlog:'Backlog',in_progress:'In Progress',testing:'Testing',done:'Done'};

async function loadStatus(){
  try{const r=await(await fetch('/api/status')).json();
  $('statusText').textContent=r.status||'idle';
  $('statusDetails').textContent=r.details||'';
  const d=$('statusDot');d.className='dot '+(r.status||'idle');}catch(e){}
}
async function loadTokens(){
  try{const r=await(await fetch('/api/tokens/summary')).json();
  $('tokensToday').textContent=Number(r.today.input).toLocaleString()+' / '+Number(r.today.output).toLocaleString();
  const wk=Number(r.week.input)+Number(r.week.output);
  $('tokensWeek').textContent=wk.toLocaleString();
  const pct=Math.min(100,wk/1000000*100);
  $('tokenBar').style.width=pct+'%';
  $('tokenBarLabel').textContent=wk.toLocaleString()+' tokens this week';}catch(e){}
}
async function loadActivity(){
  try{const r=await(await fetch('/api/activity')).json();
  $('activityList').innerHTML=r.length?r.map(a=>'<div class="activity-item"><span><span class="badge '+a.status+'">'+a.type+'</span> '+(a.label||'')+' <span style="color:var(--muted)">'+(a.details||'').substring(0,80)+'</span></span><span style="color:var(--muted);font-size:.75em;white-space:nowrap">'+new Date(a.created_at).toLocaleString()+'</span></div>').join(''):'<div class="stat-label">No activity yet</div>';}catch(e){}
}
async function loadKanban(){
  try{const r=await(await fetch('/api/kanban')).json();
  let h='';for(const col of['backlog','in_progress','testing','done']){
    h+='<div class="kanban-col"><h3>'+colNames[col]+' <span style="opacity:0.5">'+((r[col]||[]).length)+'</span></h3>';
    (r[col]||[]).forEach(c=>{
      h+='<div class="kanban-card"><div class="title">'+esc(c.title)+(c.port?'<span class="port-badge">:'+c.port+'</span>':'')+'</div>';
      if(c.description)h+='<div class="desc">'+esc(c.description)+'</div>';
      if(c.url)h+='<a href="'+esc(c.url)+'" target="_blank">'+esc(c.url)+'</a>';
      h+='<div class="actions">';
      const cols=['backlog','in_progress','testing','done'].filter(x=>x!==col);
      cols.forEach(nc=>{h+='<button onclick="moveCard('+c.id+',\\''+nc+'\\')">→ '+colNames[nc].substring(0,4)+'</button>';});
      h+='<button onclick="editCard('+c.id+',\\''+esc(c.title)+'\\',\\''+esc(c.description||'')+'\\',\\''+esc(c.url||'')+'\\',\\''+( c.port||'')+'\\',\\''+col+'\\')">✏️</button>';
      h+='</div></div>';
    });
    h+='<button class="add-btn" onclick="openModal(\\''+col+'\\')">+ Add Card</button></div>';
  }
  $('kanban').innerHTML=h;}catch(e){}
}
async function loadDocker(){
  try{const r=await(await fetch('/api/docker')).json();
  $('dockerGrid').innerHTML=r.length?r.map(c=>'<div class="card docker-card"><span class="dot" style="background:'+(c.running?'var(--green)':'var(--red)')+';width:8px;height:8px"></span><div><div class="name">'+esc(c.name)+'</div><div class="uptime">'+esc(c.status)+'</div></div></div>').join(''):'<div class="stat-label">No containers</div>';}catch(e){}
}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

async function moveCard(id,col){await fetch('/api/kanban/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({column_name:col})});loadKanban();}
function openModal(col){$('mId').value='';$('mTitle').value='';$('mDesc').value='';$('mUrl').value='';$('mPort').value='';$('mCol').value=col;$('mDel').style.display='none';$('modalTitle').textContent='Add Card';$('modalBg').classList.add('open');}
function editCard(id,t,d,u,p,c){$('mId').value=id;$('mTitle').value=t;$('mDesc').value=d;$('mUrl').value=u;$('mPort').value=p;$('mCol').value=c;$('mDel').style.display='block';$('modalTitle').textContent='Edit Card';$('modalBg').classList.add('open');}
function closeModal(){$('modalBg').classList.remove('open');}
async function saveCard(){
  const id=$('mId').value;const body={title:$('mTitle').value,description:$('mDesc').value,url:$('mUrl').value,port:$('mPort').value||null,column_name:$('mCol').value};
  if(id){await fetch('/api/kanban/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
  else{await fetch('/api/kanban',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
  closeModal();loadKanban();
}
async function deleteCard(){const id=$('mId').value;if(id&&confirm('Delete?')){await fetch('/api/kanban/'+id,{method:'DELETE'});closeModal();loadKanban();}}

function loadAll(){loadStatus();loadTokens();loadActivity();loadKanban();loadDocker();}
loadAll();setInterval(loadAll,30000);
</script></body></html>`;
}
