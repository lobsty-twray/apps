const express = require('express');
const http = require('http');
const path = require('path');
const app = express();

const services = [
  { name: 'Landing Page', port: 8111, url: 'https://twray.dev' },
  { name: 'App Hub', port: 8110, url: 'https://app-hub.twray.dev' },
  { name: 'Todo', port: 8090, url: 'https://todo.twray.dev' },
  { name: 'Board', port: 8091, url: 'https://board.twray.dev' },
  { name: 'Budget', port: 8092, url: 'https://budget.twray.dev' },
  { name: 'Docs', port: 8093, url: 'https://docs.twray.dev' },
  { name: 'Drafts', port: 8094, url: 'https://drafts.twray.dev' },
  { name: 'Video Pipeline', port: 8097, url: 'https://video-pipeline.twray.dev' },
  { name: 'Stock Monitor', port: 8098, url: 'https://monitor.twray.dev' },
  { name: 'YouTube Studio', port: 8099, url: 'https://youtube-studio.twray.dev' },
  { name: 'Content Ideas', port: 8106, url: 'https://content-ideas.twray.dev' },
  { name: 'Sponsor Manager', port: 8105, url: 'https://sponsor-manager.twray.dev' },
  { name: 'Gaming Logger', port: 8107, url: 'https://gaming-logger.twray.dev' },
  { name: 'Gear Inventory', port: 8101, url: 'https://gear-inventory.twray.dev' },
  { name: 'Script Writer', port: 8104, url: 'https://script-writer.twray.dev' },
  { name: 'Stream Planner', port: 8109, url: 'https://stream-planner.twray.dev' },
  { name: 'Benchmark Tracker', port: 8103, url: 'https://benchmark-tracker.twray.dev' },
  { name: 'Thumbnail Analyzer', port: 8108, url: 'https://thumbnail-analyzer.twray.dev' },
  { name: 'Admin Dashboard', port: 8112, url: 'https://admin.twray.dev' },
];

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30000;

function checkService(svc) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get(`http://host.docker.internal:${svc.port}/`, { timeout: 5000 }, (res) => {
      res.resume();
      const ms = Date.now() - start;
      resolve({
        name: svc.name,
        url: svc.url,
        status: ms < 2000 ? 'operational' : 'degraded',
        responseMs: ms,
        checkedAt: new Date().toISOString(),
      });
    });
    req.on('error', () => {
      resolve({
        name: svc.name,
        url: svc.url,
        status: 'down',
        responseMs: null,
        checkedAt: new Date().toISOString(),
      });
    });
    req.on('timeout', () => {
      req.destroy();
    });
  });
}

async function getStatus() {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  const results = await Promise.all(services.map(checkService));
  const summary = { operational: 0, degraded: 0, down: 0, total: results.length };
  results.forEach((r) => summary[r.status]++);
  cache = { services: results, summary };
  cacheTime = Date.now();
  return cache;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/status', async (req, res) => {
  try {
    res.json(await getStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(8119, () => console.log('Status page running on :8119'));
