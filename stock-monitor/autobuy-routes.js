const express = require('express');
const path = require('path');
const { encrypt, decrypt, attemptSamsungAutoBuy } = require('./samsung-autobuy');

const ADMIN_PASSWORD = 'ray2026';

function autobuyRoutes(pool) {
  const router = express.Router();

  // Auth middleware
  router.use((req, res, next) => {
    const pw = req.query.pw || req.cookies?.autobuy_auth || req.headers['x-admin-password'];
    if (pw === ADMIN_PASSWORD) {
      if (!req.cookies?.autobuy_auth) res.cookie('autobuy_auth', ADMIN_PASSWORD, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
      return next();
    }
    // Show login form
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title>
    <style>body{background:#0a0a0f;color:#e0e6ed;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{background:#12121a;padding:40px;border-radius:16px;border:1px solid rgba(255,255,255,0.1);text-align:center;max-width:360px;width:90%}
    h2{margin-bottom:20px;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
    input{width:100%;padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:#1a1a2e;color:#e0e6ed;font-size:16px;margin-bottom:16px}
    button{width:100%;padding:14px;border-radius:10px;border:none;background:linear-gradient(135deg,#00d4ff,#7c3aed);color:#fff;font-size:16px;font-weight:600;cursor:pointer}</style></head>
    <body><div class="box"><h2>🔐 Auto-Buy Admin</h2><form method="GET"><input name="pw" type="password" placeholder="Password" autofocus><button type="submit">Login</button></form></div></body></html>`);
  });

  // Dashboard
  router.get('/', async (req, res) => {
    try {
      const profiles = await pool.query('SELECT * FROM autobuy_profiles ORDER BY created_at');
      const products = await pool.query('SELECT p.*, pa.enabled as autobuy_enabled, pa.profile_id FROM products p LEFT JOIN product_autobuy pa ON p.id = pa.product_id ORDER BY p.created_at');
      const orders = await pool.query('SELECT o.*, p.name as product_name FROM autobuy_orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.attempted_at DESC LIMIT 20');
      
      // Check kill switch
      const ks = await pool.query("SELECT enabled FROM autobuy_profiles WHERE name = '__global_kill_switch__' LIMIT 1");
      const killSwitchEnabled = ks.rows.length === 0 || ks.rows[0].enabled;

      res.send(renderDashboard(profiles.rows, products.rows, orders.rows, killSwitchEnabled));
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Setup form
  router.get('/setup', async (req, res) => {
    try {
      const profiles = await pool.query("SELECT * FROM autobuy_profiles WHERE name != '__global_kill_switch__' ORDER BY created_at LIMIT 1");
      const profile = profiles.rows[0] || {};
      res.send(renderSetupForm(profile));
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Save profile
  router.post('/profiles', async (req, res) => {
    try {
      const { name, retailer, email, password, shipping_name, shipping_address1, shipping_address2, shipping_city, shipping_state, shipping_zip, shipping_phone, max_price } = req.body;
      const encPassword = password ? encrypt(password) : null;
      
      // Upsert - check if profile exists
      const existing = await pool.query("SELECT id FROM autobuy_profiles WHERE retailer = $1 AND name != '__global_kill_switch__' LIMIT 1", [retailer || 'samsung']);
      
      if (existing.rows.length > 0) {
        const updates = [];
        const vals = [];
        let i = 1;
        const fields = { name, retailer, email, shipping_name, shipping_address1, shipping_address2, shipping_city, shipping_state, shipping_zip, shipping_phone, max_price };
        for (const [k, v] of Object.entries(fields)) {
          if (v !== undefined && v !== '') { updates.push(`${k} = $${i}`); vals.push(v); i++; }
        }
        if (encPassword) { updates.push(`password_encrypted = $${i}`); vals.push(encPassword); i++; }
        updates.push(`updated_at = NOW()`);
        vals.push(existing.rows[0].id);
        await pool.query(`UPDATE autobuy_profiles SET ${updates.join(', ')} WHERE id = $${i}`, vals);
      } else {
        await pool.query(
          `INSERT INTO autobuy_profiles (name, retailer, email, password_encrypted, shipping_name, shipping_address1, shipping_address2, shipping_city, shipping_state, shipping_zip, shipping_phone, max_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [name || 'Samsung Account', retailer || 'samsung', email, encPassword, shipping_name, shipping_address1, shipping_address2 || '', shipping_city, shipping_state, shipping_zip, shipping_phone, max_price || 3000]
        );
      }
      res.redirect('/admin/autobuy?pw=' + ADMIN_PASSWORD);
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Toggle product autobuy
  router.post('/toggle/:productId', async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const profile = await pool.query("SELECT id FROM autobuy_profiles WHERE name != '__global_kill_switch__' LIMIT 1");
      if (profile.rows.length === 0) return res.redirect('/admin/autobuy/setup?pw=' + ADMIN_PASSWORD);
      
      const existing = await pool.query('SELECT * FROM product_autobuy WHERE product_id = $1', [productId]);
      if (existing.rows.length > 0) {
        await pool.query('UPDATE product_autobuy SET enabled = NOT enabled WHERE product_id = $1', [productId]);
      } else {
        await pool.query('INSERT INTO product_autobuy (product_id, profile_id, enabled) VALUES ($1, $2, true)', [productId, profile.rows[0].id]);
      }
      res.redirect('/admin/autobuy?pw=' + ADMIN_PASSWORD);
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Kill switch
  router.post('/killswitch', async (req, res) => {
    try {
      const existing = await pool.query("SELECT id, enabled FROM autobuy_profiles WHERE name = '__global_kill_switch__' LIMIT 1");
      if (existing.rows.length > 0) {
        await pool.query("UPDATE autobuy_profiles SET enabled = NOT enabled WHERE name = '__global_kill_switch__'");
      } else {
        await pool.query("INSERT INTO autobuy_profiles (name, retailer, enabled) VALUES ('__global_kill_switch__', 'system', true)");
      }
      res.redirect('/admin/autobuy?pw=' + ADMIN_PASSWORD);
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Test (dry run)
  router.post('/test/:productId', async (req, res) => {
    try {
      const product = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.productId]);
      if (product.rows.length === 0) return res.status(404).send('Product not found');
      const profile = await pool.query("SELECT * FROM autobuy_profiles WHERE name != '__global_kill_switch__' AND enabled = true LIMIT 1");
      if (profile.rows.length === 0) return res.redirect('/admin/autobuy/setup?pw=' + ADMIN_PASSWORD);
      
      const result = await attemptSamsungAutoBuy(pool, product.rows[0], profile.rows[0], true);
      res.redirect('/admin/autobuy/orders?pw=' + ADMIN_PASSWORD);
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  // Orders
  router.get('/orders', async (req, res) => {
    try {
      const orders = await pool.query(`
        SELECT o.*, p.name as product_name, ap.name as profile_name
        FROM autobuy_orders o
        LEFT JOIN products p ON o.product_id = p.id
        LEFT JOIN autobuy_profiles ap ON o.profile_id = ap.id
        ORDER BY o.attempted_at DESC LIMIT 100
      `);
      res.send(renderOrders(orders.rows));
    } catch (err) { res.status(500).send('Error: ' + err.message); }
  });

  return router;
}

// --- HTML Renderers ---
function pageWrapper(title, content) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} — Stock Monitor</title>
<style>
:root{--bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a2e;--blue:#00d4ff;--purple:#7c3aed;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--text:#e0e6ed;--text2:#8892a4;--radius:16px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--blue);text-decoration:none}
.container{max-width:900px;margin:0 auto;padding:20px}
.nav{background:rgba(10,10,15,0.9);backdrop-filter:blur(20px);border-bottom:1px solid rgba(255,255,255,0.1);padding:12px 20px;position:sticky;top:0;z-index:100;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nav a{padding:8px 16px;border-radius:8px;font-size:14px;font-weight:500;border:1px solid rgba(255,255,255,0.1);color:var(--text2);transition:all 0.2s}
.nav a:hover,.nav a.active{color:var(--blue);border-color:var(--blue);background:rgba(0,212,255,0.08)}
.nav .brand{font-weight:700;font-size:18px;background:linear-gradient(135deg,var(--blue),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent;border:none;margin-right:auto}
h1{font-size:24px;margin-bottom:20px;background:linear-gradient(135deg,var(--blue),var(--purple));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.card{background:var(--bg2);border:1px solid rgba(255,255,255,0.08);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.card h3{font-size:16px;margin-bottom:12px;color:var(--text)}
.badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600}
.badge-green{background:rgba(34,197,94,0.15);color:var(--green)}
.badge-red{background:rgba(239,68,68,0.15);color:var(--red)}
.badge-yellow{background:rgba(234,179,8,0.15);color:var(--yellow)}
.badge-blue{background:rgba(0,212,255,0.15);color:var(--blue)}
.btn{padding:12px 24px;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;border:none;transition:all 0.2s;display:inline-flex;align-items:center;gap:6px;min-height:44px}
.btn-primary{background:linear-gradient(135deg,var(--blue),var(--purple));color:#fff}
.btn-danger{background:rgba(239,68,68,0.15);color:var(--red);border:1px solid rgba(239,68,68,0.3)}
.btn-success{background:rgba(34,197,94,0.15);color:var(--green);border:1px solid rgba(34,197,94,0.3)}
.btn-outline{background:transparent;color:var(--text2);border:1px solid rgba(255,255,255,0.15)}
.btn:active{transform:scale(0.97)}
.btn-sm{padding:8px 16px;font-size:12px;min-height:36px}
input,select,textarea{width:100%;padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:var(--bg3);color:var(--text);font-size:16px;margin-bottom:12px}
input:focus,select:focus{outline:none;border-color:var(--blue)}
label{display:block;font-size:14px;color:var(--text2);margin-bottom:6px;font-weight:500}
.grid{display:grid;gap:16px}
.grid-2{grid-template-columns:1fr 1fr}
@media(max-width:600px){.grid-2{grid-template-columns:1fr}}
.flex{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.mt{margin-top:16px}
.kill-switch{padding:16px 24px;border-radius:var(--radius);font-size:16px;font-weight:700;width:100%;cursor:pointer;border:none;transition:all 0.2s;min-height:56px}
.kill-on{background:rgba(34,197,94,0.15);color:var(--green);border:2px solid var(--green)}
.kill-off{background:rgba(239,68,68,0.15);color:var(--red);border:2px solid var(--red)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)}
th{color:var(--text2);font-weight:500;font-size:12px;text-transform:uppercase}
.screenshot-thumb{width:120px;height:80px;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.1)}
.empty{text-align:center;padding:40px;color:var(--text2)}
</style></head><body>
<div class="nav">
  <a class="brand" href="/admin/autobuy">🛒 Auto-Buy</a>
  <a href="/admin/autobuy">Dashboard</a>
  <a href="/admin/autobuy/setup">Setup</a>
  <a href="/admin/autobuy/orders">Orders</a>
  <a href="/">← Monitor</a>
</div>
<div class="container">${content}</div>
</body></html>`;
}

function renderDashboard(profiles, products, orders, killSwitchEnabled) {
  const realProfiles = profiles.filter(p => p.name !== '__global_kill_switch__');
  
  let html = `<h1>🛒 Auto-Buy Dashboard</h1>`;
  
  // Kill Switch
  html += `<div class="card">
    <div class="flex" style="justify-content:space-between">
      <div><h3>⚡ Global Kill Switch</h3><p style="color:var(--text2);font-size:14px">Master toggle for all auto-buy operations</p></div>
      <form method="POST" action="/admin/autobuy/killswitch">
        <button type="submit" class="kill-switch ${killSwitchEnabled ? 'kill-on' : 'kill-off'}">${killSwitchEnabled ? '🟢 ENABLED' : '🔴 DISABLED'}</button>
      </form>
    </div>
  </div>`;

  // Profiles summary
  html += `<div class="card"><h3>👤 Profiles</h3>`;
  if (realProfiles.length === 0) {
    html += `<p class="empty">No profiles configured. <a href="/admin/autobuy/setup">Set up your Samsung account →</a></p>`;
  } else {
    for (const p of realProfiles) {
      html += `<div class="flex" style="justify-content:space-between;padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div>
          <strong>${p.name}</strong> <span class="badge badge-blue">${p.retailer}</span>
          ${p.enabled ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-red">Disabled</span>'}
          <br><span style="color:var(--text2);font-size:13px">${p.email || 'No email'} | Max: $${p.max_price || 3000}</span>
        </div>
        <a href="/admin/autobuy/setup" class="btn btn-outline btn-sm">Edit</a>
      </div>`;
    }
  }
  html += `</div>`;

  // Products
  html += `<div class="card"><h3>📦 Products</h3>`;
  if (products.length === 0) {
    html += `<p class="empty">No products tracked</p>`;
  } else {
    for (const p of products) {
      const enabled = p.autobuy_enabled === true;
      html += `<div class="flex" style="justify-content:space-between;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div>
          <strong>${p.name}</strong><br>
          <span style="color:var(--text2);font-size:13px">${p.last_status || 'unknown'} | ${p.url.includes('samsung') ? 'Samsung' : p.url.includes('bestbuy') ? 'Best Buy' : 'Other'}</span>
        </div>
        <div class="flex">
          <form method="POST" action="/admin/autobuy/toggle/${p.id}"><button type="submit" class="btn btn-sm ${enabled ? 'btn-success' : 'btn-outline'}">${enabled ? '✅ Auto-Buy ON' : '⬜ Auto-Buy OFF'}</button></form>
          <form method="POST" action="/admin/autobuy/test/${p.id}" onsubmit="return confirm('Run dry-run test?')"><button type="submit" class="btn btn-sm btn-outline">🧪 Test</button></form>
        </div>
      </div>`;
    }
  }
  html += `</div>`;

  // Recent orders
  html += `<div class="card"><h3>📋 Recent Orders</h3>`;
  if (orders.length === 0) {
    html += `<p class="empty">No orders yet</p>`;
  } else {
    html += `<div style="overflow-x:auto"><table><tr><th>Time</th><th>Product</th><th>Status</th><th>Order #</th></tr>`;
    for (const o of orders.slice(0, 10)) {
      const badge = o.status === 'success' ? 'badge-green' : o.status === 'failed' ? 'badge-red' : 'badge-yellow';
      html += `<tr>
        <td style="white-space:nowrap">${new Date(o.attempted_at).toLocaleString()}</td>
        <td>${o.product_name || 'Unknown'}</td>
        <td><span class="badge ${badge}">${o.status}</span></td>
        <td>${o.order_number || '-'}</td>
      </tr>`;
    }
    html += `</table></div>`;
  }
  html += `<div class="mt"><a href="/admin/autobuy/orders" class="btn btn-outline btn-sm">View All Orders →</a></div></div>`;

  return pageWrapper('Auto-Buy Dashboard', html);
}

function renderSetupForm(profile) {
  const p = profile || {};
  let html = `<h1>⚙️ Samsung Account Setup</h1>
  <form method="POST" action="/admin/autobuy/profiles">
    <div class="card">
      <h3>🔑 Account</h3>
      <div class="grid grid-2">
        <div><label>Profile Name</label><input name="name" value="${p.name || 'Samsung Account'}" required></div>
        <div><label>Retailer</label><select name="retailer"><option value="samsung" ${p.retailer === 'samsung' ? 'selected' : ''}>Samsung</option><option value="bestbuy" ${p.retailer === 'bestbuy' ? 'selected' : ''}>Best Buy</option></select></div>
      </div>
      <div class="grid grid-2">
        <div><label>Email</label><input name="email" type="email" value="${p.email || ''}" required></div>
        <div><label>Password ${p.password_encrypted ? '(saved ✓ leave blank to keep)' : ''}</label><input name="password" type="password" placeholder="${p.password_encrypted ? '••••••••' : 'Enter password'}"></div>
      </div>
      <div><label>Max Price ($)</label><input name="max_price" type="number" value="${p.max_price || 3000}" step="1"></div>
    </div>
    <div class="card">
      <h3>📦 Shipping Address</h3>
      <div><label>Full Name</label><input name="shipping_name" value="${p.shipping_name || ''}"></div>
      <div><label>Address Line 1</label><input name="shipping_address1" value="${p.shipping_address1 || ''}"></div>
      <div><label>Address Line 2</label><input name="shipping_address2" value="${p.shipping_address2 || ''}"></div>
      <div class="grid grid-2">
        <div><label>City</label><input name="shipping_city" value="${p.shipping_city || ''}"></div>
        <div><label>State</label><input name="shipping_state" value="${p.shipping_state || ''}"></div>
      </div>
      <div class="grid grid-2">
        <div><label>ZIP Code</label><input name="shipping_zip" value="${p.shipping_zip || ''}"></div>
        <div><label>Phone</label><input name="shipping_phone" type="tel" value="${p.shipping_phone || ''}"></div>
      </div>
    </div>
    <button type="submit" class="btn btn-primary" style="width:100%">💾 Save Profile</button>
  </form>
  <div class="card mt">
    <h3>💡 Tips</h3>
    <ul style="color:var(--text2);font-size:14px;line-height:1.8;padding-left:20px">
      <li>Log into samsung.com in a browser first, then save your session cookies here</li>
      <li>Make sure you have a payment method saved on your Samsung account</li>
      <li>Run a <strong>dry-run test</strong> from the dashboard before enabling auto-buy</li>
      <li>Default max price is $3,000 — auto-buy will abort if total exceeds this</li>
    </ul>
  </div>`;
  return pageWrapper('Setup', html);
}

function renderOrders(orders) {
  let html = `<h1>📋 Order History</h1>`;
  if (orders.length === 0) {
    html += `<div class="card"><p class="empty">No auto-buy attempts yet</p></div>`;
  } else {
    for (const o of orders) {
      const badge = o.status === 'success' ? 'badge-green' : o.status === 'failed' ? 'badge-red' : 'badge-yellow';
      html += `<div class="card">
        <div class="flex" style="justify-content:space-between;margin-bottom:8px">
          <strong>${o.product_name || 'Unknown Product'}</strong>
          <span class="badge ${badge}">${o.status}</span>
        </div>
        <div style="color:var(--text2);font-size:13px">
          ${new Date(o.attempted_at).toLocaleString()}
          ${o.order_number ? ' | Order #' + o.order_number : ''}
          ${o.profile_name ? ' | Profile: ' + o.profile_name : ''}
        </div>
        ${o.error_message ? `<div style="color:var(--red);font-size:13px;margin-top:8px">❌ ${o.error_message}</div>` : ''}
        ${o.screenshot_path ? `<div class="mt"><a href="/${o.screenshot_path}" target="_blank"><img src="/${o.screenshot_path}" class="screenshot-thumb" alt="Screenshot"></a></div>` : ''}
      </div>`;
    }
  }
  return pageWrapper('Orders', html);
}

module.exports = { autobuyRoutes };
