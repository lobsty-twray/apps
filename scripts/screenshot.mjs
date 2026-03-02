import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import path from 'path';

const ALL_APPS = [
  ['todo', 8090], ['board', 8091], ['budget', 8092], ['docs', 8093],
  ['drafts', 8094], ['shop', 8096], ['video-pipeline', 8097],
  ['stock-monitor', 8098], ['youtube-studio', 8099], ['hardware-monitor', 8100],
  ['gear-inventory', 8101], ['benchmark-tracker', 8103], ['script-writer', 8104],
  ['sponsor-manager', 8105], ['content-ideas', 8106], ['gaming-logger', 8107],
  ['thumbnail-analyzer', 8108], ['stream-planner', 8109], ['app-hub', 8110],
  ['landing-page', 8111], ['admin-dashboard', 8112],
];

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
];

const args = process.argv.slice(2);
let apps;
if (args.length >= 2) {
  apps = [[args[0], parseInt(args[1])]];
} else {
  apps = ALL_APPS;
}

const outDir = path.resolve(process.env.HOME, 'apps/screenshots');

const browser = await chromium.launch({ headless: true });
const results = [];

for (const [name, port] of apps) {
  for (const vp of VIEWPORTS) {
    const file = `${name}-${vp.name}.png`;
    const outPath = path.join(outDir, file);
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    try {
      await page.goto(`http://localhost:${port}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.screenshot({ path: outPath, fullPage: false });
      results.push({ name, vp: vp.name, file, ok: true });
      console.log(`✓ ${file}`);
    } catch (e) {
      results.push({ name, vp: vp.name, file, ok: false, err: e.message });
      console.log(`✗ ${file} - ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
}

await browser.close();

// Generate index.html
if (apps.length > 1) {
  const cards = ALL_APPS.map(([name]) => `
    <div class="app">
      <h3>${name}</h3>
      <div class="shots">
        <div><img src="${name}-desktop.png" alt="${name} desktop" loading="lazy"><span>Desktop</span></div>
        <div><img src="${name}-mobile.png" alt="${name} mobile" loading="lazy"><span>Mobile</span></div>
      </div>
    </div>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>App Screenshots</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui;background:#111;color:#eee;padding:2rem}
h1{margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(500px,1fr));gap:1.5rem}
.app{background:#1a1a1a;border-radius:12px;padding:1rem;border:1px solid #333}
.app h3{margin-bottom:.75rem;color:#7dd3fc}
.shots{display:flex;gap:1rem;flex-wrap:wrap}
.shots>div{flex:1;min-width:200px;text-align:center}
.shots img{width:100%;border-radius:8px;border:1px solid #333}
.shots span{display:block;margin-top:.25rem;font-size:.8rem;color:#888}
</style></head><body>
<h1>📸 App Screenshots</h1>
<p style="color:#888;margin-bottom:1.5rem">Generated: ${new Date().toISOString()}</p>
<div class="grid">${cards}</div>
</body></html>`;

  writeFileSync(path.join(outDir, 'index.html'), html);
  console.log('✓ index.html generated');
}

const failed = results.filter(r => !r.ok).length;
process.exit(failed > 0 ? 1 : 0);
