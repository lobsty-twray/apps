const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// App registry with URLs and container names
const APPS = [
  { name: 'YouTube Studio', url: 'https://youtube-studio.twray.dev', container: 'lobsty-youtube-studio' },
  { name: 'Script Writer', url: 'https://script-writer.twray.dev', container: 'lobsty-script-writer' },
  { name: 'Thumbnail Analyzer', url: 'https://thumbnail-analyzer.twray.dev', container: 'lobsty-thumbnail-analyzer' },
  { name: 'Content Ideas', url: 'https://content-ideas.twray.dev', container: 'lobsty-content-ideas' },
  { name: 'Video Pipeline', url: 'https://video-pipeline.twray.dev', container: 'lobsty-video-pipeline' },
  { name: 'Stream Planner', url: 'https://stream-planner.twray.dev', container: 'lobsty-stream-planner' },
  { name: 'Kanban Board', url: 'https://board.twray.dev', container: 'lobsty-board' },
  { name: 'Docs Hub', url: 'https://docs.twray.dev', container: 'lobsty-docs' },
  { name: 'Drafts', url: 'https://drafts.twray.dev', container: 'lobsty-drafts' },
  { name: 'Todo', url: 'https://todo.twray.dev', container: 'lobsty-todo' },
  { name: 'Budget Tracker', url: 'https://budget.twray.dev', container: 'lobsty-budget' },
  { name: 'Hardware Monitor', url: 'https://hardware-monitor.twray.dev', container: 'lobsty-hardware-monitor' },
  { name: 'Benchmark Tracker', url: 'https://benchmark-tracker.twray.dev', container: 'lobsty-benchmark-tracker' },
  { name: 'Gear Inventory', url: 'https://gear-inventory.twray.dev', container: 'lobsty-gear-inventory' },
  { name: 'Gaming Logger', url: 'https://gaming-logger.twray.dev', container: 'lobsty-gaming-logger' },
  { name: 'Sponsor Manager', url: 'https://sponsor-manager.twray.dev', container: 'lobsty-sponsor-manager' },
  { name: 'Shop', url: 'https://shop.twray.dev', container: 'lobsty-shop' },
  { name: 'Stock Monitor', url: 'https://monitor.twray.dev', container: 'lobsty-monitor' },
  { name: 'Admin Dashboard', url: 'https://admin.twray.dev', container: 'lobsty-admin' },
  { name: 'Landing Page', url: 'https://twray.dev', container: 'lobsty-landing' },
  { name: 'Komodo', url: 'https://komodo.twray.dev', container: null },
  { name: 'Netdata', url: 'https://netdata.twray.dev', container: null },
  { name: 'Open WebUI', url: 'https://ai.twray.dev', container: null },
  { name: 'Pi-hole', url: 'https://pihole.twray.dev', container: null },
];

// Searchable apps - internal Docker network names
const SEARCH_APPS = [
  { name: 'Kanban Board', emoji: '📋', host: 'lobsty-board', port: 3000, path: '/api/search', searchParam: 'q', urlBase: 'https://board.twray.dev', titleField: 'title', descField: 'description', idField: 'id' },
  { name: 'Docs Hub', emoji: '📄', host: 'lobsty-docs', port: 3000, path: '/api/search', searchParam: 'q', urlBase: 'https://docs.twray.dev', titleField: 'title', descField: 'content', idField: 'id' },
  { name: 'Drafts', emoji: '✏️', host: 'lobsty-drafts', port: 3000, path: '/api/search', searchParam: 'q', urlBase: 'https://drafts.twray.dev', titleField: 'title', descField: 'content', idField: 'id' },
  { name: 'Content Ideas', emoji: '💡', host: 'lobsty-content-ideas', port: 3000, path: '/api/search', searchParam: 'q', urlBase: 'https://content-ideas.twray.dev', titleField: 'title', descField: 'description', idField: 'id' },
];

function searchApp(appDef, query, timeout = 3000) {
  return new Promise(resolve => {
    const url = `http://${appDef.host}:${appDef.port}${appDef.path}?${appDef.searchParam}=${encodeURIComponent(query)}`;
    const req = http.get(url, { timeout }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          let data = JSON.parse(body);
          if (!Array.isArray(data)) {
            for (const k of ['tasks', 'docs', 'drafts', 'todos', 'ideas', 'items', 'results', 'data']) {
              if (data[k] && Array.isArray(data[k])) { data = data[k]; break; }
            }
          }
          if (!Array.isArray(data)) { resolve([]); return; }
          const results = data.slice(0, 8).map(item => {
            const title = item[appDef.titleField] || item.name || item.text || 'Untitled';
            const desc = item[appDef.descField] || item.description || item.content || item.text || '';
            const id = item[appDef.idField] || item._id || '';
            return {
              title: typeof title === 'string' ? title.substring(0, 100) : String(title),
              desc: typeof desc === 'string' ? desc.replace(/<[^>]*>/g, '').substring(0, 120) : '',
              url: id ? `${appDef.urlBase}#${id}` : appDef.urlBase
            };
          });
          resolve(results);
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ results: [] });
  const appResults = await Promise.all(
    SEARCH_APPS.map(async appDef => {
      const items = await searchApp(appDef, q);
      return items.length ? { app: appDef.name, emoji: appDef.emoji, baseUrl: appDef.urlBase, items } : null;
    })
  );
  res.json({ results: appResults.filter(Boolean) });
});

function checkUrl(url, timeout = 5000) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout, rejectUnauthorized: false }, res => {
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

app.get('/api/health', async (req, res) => {
  const results = {};
  await Promise.all(APPS.map(async app => {
    const up = await checkUrl(app.url);
    results[app.url] = up;
  }));
  res.json(results);
});

app.post('/api/restart/:container', (req, res) => {
  const container = req.params.container;
  if (!/^lobsty-[a-z0-9-]+$/.test(container)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  exec(`sudo docker restart ${container}`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ ok: true, output: stdout.trim() });
  });
});

app.get('/api/logs/:container', (req, res) => {
  const container = req.params.container;
  if (!/^lobsty-[a-z0-9-]+$/.test(container)) {
    return res.status(400).json({ error: 'Invalid container name' });
  }
  exec(`sudo docker logs --tail 50 ${container}`, { timeout: 10000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr || err.message });
    res.json({ logs: (stdout + stderr).trim() });
  });
});

app.listen(PORT, '0.0.0.0', () => {
// Quick Capture endpoint patch - to be inserted before app.listen

const QUICK_CAPTURE_TARGETS = {
  'content-idea': (text, priority) => ({
    url: 'http://lobsty-content-ideas:3000/api/ideas',
    body: { title: text, priority: priority || 'medium', status: 'brainstorm', category: 'Quick Capture' }
  }),
  'board-task': (text, priority) => ({
    url: 'http://lobsty-board:3000/api/projects/1/tasks',
    body: { title: text, priority: priority || 'medium', status: 'backlog' }
  })
};

app.post('/api/quick-capture', async (req, res) => {
  const { text, target, priority } = req.body;
  if (!text || !target) return res.status(400).json({ error: 'text and target are required' });
  const targetDef = QUICK_CAPTURE_TARGETS[target];
  if (!targetDef) return res.status(400).json({ error: 'Invalid target. Use: content-idea, board-task' });

  const { url, body } = targetDef(text, priority);
  const postData = JSON.stringify(body);

  try {
    const result = await new Promise((resolve, reject) => {
      const req2 = http.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 5000
      }, resp => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch { resolve({ ok: true }); }
          } else {
            reject(new Error(`${resp.statusCode}: ${data}`));
          }
        });
      });
      req2.on('error', reject);
      req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout')); });
      req2.write(postData);
      req2.end();
    });
    res.json({ ok: true, target, result });
  } catch (err) {
    res.status(502).json({ error: `Failed to forward to ${target}: ${err.message}` });
  }
});
  console.log(`App Hub running on port ${PORT}`);
});
