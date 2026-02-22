const { encryptProfile, decryptProfile } = require('./db');
const { attemptAutoBuyWithRetry } = require('./engine');
const { encrypt, decrypt } = require('./encryption');

const ADMIN_PASSWORD = process.env.AUTOBUY_ADMIN_PASSWORD || 'ray2026';

function authMiddleware(req, res, next) {
  // Check cookie or header
  const authCookie = req.cookies?.autobuy_auth;
  const authHeader = req.headers['x-admin-password'];
  const bodyPw = req.body?.password;
  
  if (authCookie === ADMIN_PASSWORD || authHeader === ADMIN_PASSWORD || bodyPw === ADMIN_PASSWORD) {
    return next();
  }
  
  // Check query param for GET requests
  if (req.query?.password === ADMIN_PASSWORD) {
    return next();
  }
  
  // Return login page for browser requests
  if (req.accepts('html') && req.method === 'GET') {
    return res.send(loginPage());
  }
  
  res.status(401).json({ error: 'Unauthorized' });
}

function loginPage() {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auto-Buy Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e6ed;display:flex;align-items:center;justify-content:center;min-height:100vh}
.login{background:#12121a;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:32px;max-width:380px;width:90%}
h2{margin-bottom:24px;text-align:center;color:#00d4ff}
input{width:100%;padding:12px 16px;background:#1a1a2e;border:1px solid rgba(255,255,255,.15);border-radius:10px;color:#e0e6ed;font-size:16px;margin-bottom:16px}
button{width:100%;padding:12px;background:linear-gradient(135deg,#7c3aed,#00d4ff);border:none;border-radius:10px;color:#fff;font-size:16px;font-weight:600;cursor:pointer}
</style></head><body>
<div class="login"><h2>🔐 Auto-Buy Admin</h2>
<form method="POST" action="/admin/autobuy/login">
<input type="password" name="password" placeholder="Admin password" autofocus>
<button type="submit">Login</button>
</form></div></body></html>`;
}

function setupRoutes(app, pool, sendNtfyFn) {
  const cookieParser = require('cookie-parser');
  app.use(cookieParser());

  // Login
  app.post('/admin/autobuy/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
      res.cookie('autobuy_auth', ADMIN_PASSWORD, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 });
      return res.redirect('/admin/autobuy');
    }
    res.status(401).send(loginPage());
  });

  // Admin page
  app.get('/admin/autobuy', authMiddleware, async (req, res) => {
    res.sendFile(require('path').join(__dirname, '../../public/autobuy-admin.html'));
  });

  // API: Get all profiles
  app.get('/admin/autobuy/api/profiles', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('SELECT id, retailer, shipping_name, shipping_city, shipping_state, payment_last4, enabled, max_price, created_at, updated_at FROM autobuy_profiles ORDER BY id');
      // Don't send encrypted fields to frontend
      res.json({ data: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Create/update profile
  app.post('/admin/autobuy/api/profiles', authMiddleware, async (req, res) => {
    try {
      const { id, retailer, email, password, shipping_name, shipping_address, shipping_city,
              shipping_state, shipping_zip, shipping_phone, payment_last4, max_price } = req.body;
      
      if (id) {
        // Update
        const updates = [];
        const vals = [];
        let idx = 1;
        
        if (retailer) { updates.push(`retailer=$${idx++}`); vals.push(retailer); }
        if (email) { updates.push(`email_encrypted=$${idx++}`); vals.push(encrypt(email)); }
        if (password) { updates.push(`password_encrypted=$${idx++}`); vals.push(encrypt(password)); }
        if (shipping_name) { updates.push(`shipping_name=$${idx++}`); vals.push(shipping_name); }
        if (shipping_address) { updates.push(`shipping_address=$${idx++}`); vals.push(shipping_address); }
        if (shipping_city) { updates.push(`shipping_city=$${idx++}`); vals.push(shipping_city); }
        if (shipping_state) { updates.push(`shipping_state=$${idx++}`); vals.push(shipping_state); }
        if (shipping_zip) { updates.push(`shipping_zip=$${idx++}`); vals.push(shipping_zip); }
        if (shipping_phone) { updates.push(`shipping_phone=$${idx++}`); vals.push(shipping_phone); }
        if (payment_last4) { updates.push(`payment_last4=$${idx++}`); vals.push(payment_last4); }
        if (max_price !== undefined) { updates.push(`max_price=$${idx++}`); vals.push(max_price); }
        updates.push(`updated_at=NOW()`);
        vals.push(id);
        
        const result = await pool.query(
          `UPDATE autobuy_profiles SET ${updates.join(',')} WHERE id=$${idx} RETURNING id, retailer, shipping_name, enabled, max_price`,
          vals
        );
        res.json({ data: result.rows[0] });
      } else {
        // Create
        const result = await pool.query(
          `INSERT INTO autobuy_profiles (retailer, email_encrypted, password_encrypted, shipping_name, shipping_address, shipping_city, shipping_state, shipping_zip, shipping_phone, payment_last4, max_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, retailer, shipping_name, enabled, max_price`,
          [retailer || 'samsung', email ? encrypt(email) : null, password ? encrypt(password) : null,
           shipping_name, shipping_address, shipping_city, shipping_state, shipping_zip, shipping_phone, payment_last4, max_price || 3000]
        );
        res.json({ data: result.rows[0] });
      }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Toggle profile enabled
  app.post('/admin/autobuy/api/profiles/:id/toggle', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE autobuy_profiles SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1 RETURNING id, enabled`,
        [req.params.id]
      );
      res.json({ data: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Product auto-buy settings
  app.get('/admin/autobuy/api/products', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT p.id, p.name, p.url, p.last_status, p.last_price,
               COALESCE(s.enabled, false) as autobuy_enabled,
               s.profile_id, s.max_price as product_max_price
        FROM products p
        LEFT JOIN autobuy_product_settings s ON s.product_id = p.id
        ORDER BY p.id
      `);
      res.json({ data: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Toggle product auto-buy
  app.post('/admin/autobuy/api/products/:id/toggle', authMiddleware, async (req, res) => {
    try {
      const { profile_id, max_price } = req.body;
      const result = await pool.query(`
        INSERT INTO autobuy_product_settings (product_id, profile_id, enabled, max_price)
        VALUES ($1, $2, true, $3)
        ON CONFLICT (product_id) DO UPDATE SET enabled = NOT autobuy_product_settings.enabled, profile_id = COALESCE($2, autobuy_product_settings.profile_id), max_price = COALESCE($3, autobuy_product_settings.max_price)
        RETURNING *
      `, [req.params.id, profile_id || 1, max_price || 3000]);
      res.json({ data: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Test (dry run)
  app.post('/admin/autobuy/api/test/:productId', authMiddleware, async (req, res) => {
    try {
      const pRes = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.productId]);
      if (pRes.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
      
      const sRes = await pool.query(
        `SELECT ps.profile_id FROM autobuy_product_settings ps WHERE ps.product_id = $1`,
        [req.params.productId]
      );
      const profileId = sRes.rows[0]?.profile_id || req.body.profile_id || 1;
      
      const profRes = await pool.query('SELECT * FROM autobuy_profiles WHERE id = $1', [profileId]);
      if (profRes.rows.length === 0) return res.status(404).json({ error: 'No profile configured' });

      const result = await attemptAutoBuyWithRetry(pool, pRes.rows[0], profRes.rows[0], {
        dryRun: true,
        sendNtfy: sendNtfyFn,
      });
      res.json({ data: result });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Orders
  app.get('/admin/autobuy/api/orders', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT o.*, p.name as product_name
        FROM autobuy_orders o
        LEFT JOIN products p ON p.id = o.product_id
        ORDER BY o.created_at DESC LIMIT 100
      `);
      res.json({ data: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Kill switch
  app.get('/admin/autobuy/api/config', authMiddleware, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM autobuy_config');
      const config = {};
      result.rows.forEach(r => config[r.key] = r.value);
      res.json({ data: config });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/admin/autobuy/api/kill-switch', authMiddleware, async (req, res) => {
    try {
      const { enabled } = req.body;
      await pool.query(
        `INSERT INTO autobuy_config (key, value, updated_at) VALUES ('kill_switch', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [enabled ? 'true' : 'false']
      );
      if (enabled) {
        sendNtfyFn('twray-stock-admin', '🛑 Auto-Buy KILLED', 'Kill switch activated — all auto-buys disabled', null, 5);
      }
      res.json({ data: { kill_switch: enabled } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // API: Save session cookies (manual login flow)
  app.post('/admin/autobuy/api/profiles/:id/save-session', authMiddleware, async (req, res) => {
    try {
      const { cookies } = req.body;
      await pool.query(
        `UPDATE autobuy_profiles SET session_cookies = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(cookies), req.params.id]
      );
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Login & capture session
  app.post('/admin/autobuy/api/profiles/:id/capture-session', authMiddleware, async (req, res) => {
    try {
      const profRes = await pool.query('SELECT * FROM autobuy_profiles WHERE id = $1', [req.params.id]);
      if (profRes.rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
      
      const profile = decryptProfile(profRes.rows[0]);
      const retailer = profile.retailer || 'samsung';
      
      let loginUrl = 'https://account.samsung.com/accounts/v1/MBR/signInGate';
      if (retailer === 'bestbuy') loginUrl = 'https://www.bestbuy.com/identity/global/signin';

      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        viewport: { width: 1920, height: 1080 }
      });
      const page = await context.newPage();
      
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Auto-fill credentials
      if (profile.email) {
        const emailField = await page.$('input[type="email"], input[name="email"], #email, #fld-e');
        if (emailField) await emailField.fill(profile.email);
      }
      if (profile.password) {
        const pwField = await page.$('input[type="password"], #fld-p1');
        if (pwField) await pwField.fill(profile.password);
      }

      // Try to submit
      const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
      if (submitBtn) {
        await submitBtn.click();
        await page.waitForTimeout(8000);
      }

      // Capture cookies
      const state = await context.storageState();
      await pool.query(
        `UPDATE autobuy_profiles SET session_cookies = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(state.cookies), req.params.id]
      );

      await browser.close();
      res.json({ success: true, message: 'Session captured', cookieCount: state.cookies.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { setupRoutes };
