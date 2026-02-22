const { chromium } = require('playwright');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const ENCRYPTION_KEY = process.env.AUTOBUY_ENCRYPTION_KEY || '';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'twray-stock-monitor';

// --- Encryption ---
function encrypt(text) {
  if (!ENCRYPTION_KEY || !text) return text;
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + tag + ':' + encrypted;
}

function decrypt(data) {
  if (!ENCRYPTION_KEY || !data || !data.includes(':')) return data;
  try {
    const [ivHex, tagHex, encrypted] = data.split(':');
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Decryption failed:', e.message);
    return null;
  }
}

function sendNtfy(topic, title, message, priority) {
  const payload = JSON.stringify({ topic, title, message, priority: priority || 4, tags: ['shopping_cart'] });
  const parsedUrl = new URL(NTFY_URL);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const req = transport.request(NTFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
    let body = ''; res.on('data', c => body += c);
    res.on('end', () => { if (res.statusCode !== 200) console.error(`[ntfy] ${res.statusCode} ${body}`); });
  });
  req.on('error', e => console.error('[ntfy]', e.message));
  req.write(payload); req.end();
}

// --- Samsung Auto-Buy ---
async function attemptSamsungAutoBuy(pool, product, profile, dryRun = false) {
  const screenshotDir = path.join(__dirname, 'public', 'screenshots');
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });

  const timestamp = Date.now();
  const screenshotPath = `screenshots/autobuy-${product.id}-${timestamp}.png`;
  const fullScreenshotPath = path.join(__dirname, 'public', screenshotPath);

  // Create order record
  const orderRes = await pool.query(
    `INSERT INTO autobuy_orders (product_id, profile_id, status, attempted_at) VALUES ($1, $2, 'attempted', NOW()) RETURNING id`,
    [product.id, profile.id]
  );
  const orderId = orderRes.rows[0].id;

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
    });

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    };

    // Load session cookies if available
    const cookies = profile.session_cookies ? JSON.parse(decrypt(profile.session_cookies) || '[]') : [];
    const context = await browser.newContext(contextOptions);
    if (cookies.length > 0) {
      try { await context.addCookies(cookies); } catch (e) { console.log('[autobuy] Cookie load failed:', e.message); }
    }

    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    console.log(`[autobuy] Navigating to ${product.url}`);
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Step 1: Click Add to Cart / Buy Now
    console.log('[autobuy] Looking for Add to Cart...');
    const addToCartBtn = await page.$('button:has-text("Add to Cart"), button:has-text("Buy Now"), button:has-text("Pre-Order"), a:has-text("Add to Cart"), a:has-text("Buy Now")');
    if (!addToCartBtn) {
      throw new Error('Add to Cart button not found - product may be out of stock');
    }
    await addToCartBtn.click();
    await page.waitForTimeout(3000);
    await pool.query(`UPDATE autobuy_orders SET status = 'cart_added' WHERE id = $1`, [orderId]);

    // Step 2: Go to checkout
    console.log('[autobuy] Proceeding to checkout...');
    // Try clicking checkout button in cart modal/flyout
    const checkoutBtn = await page.$('button:has-text("Checkout"), a:has-text("Checkout"), button:has-text("Check Out"), a[href*="checkout"]');
    if (checkoutBtn) {
      await checkoutBtn.click();
      await page.waitForTimeout(5000);
    } else {
      // Navigate directly to cart/checkout
      await page.goto('https://www.samsung.com/us/web/express/cart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const cartCheckout = await page.$('button:has-text("Checkout"), a:has-text("Checkout")');
      if (cartCheckout) { await cartCheckout.click(); await page.waitForTimeout(5000); }
    }
    await pool.query(`UPDATE autobuy_orders SET status = 'checkout_started' WHERE id = $1`, [orderId]);

    // Step 3: Handle login if needed
    const loginField = await page.$('input[type="email"], input[name="email"], #email');
    if (loginField) {
      console.log('[autobuy] Login required, entering credentials...');
      const email = profile.email;
      const password = decrypt(profile.password_encrypted);
      if (!email || !password) throw new Error('Login required but no credentials saved');
      
      await loginField.fill(email);
      const passwordField = await page.$('input[type="password"], input[name="password"]');
      if (passwordField) {
        await passwordField.fill(password);
        const signInBtn = await page.$('button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]');
        if (signInBtn) { await signInBtn.click(); await page.waitForTimeout(5000); }
      }
    }

    // Step 4: Check price before proceeding
    const pageText = await page.innerText('body');
    const priceMatches = pageText.match(/\$\s*([\d,]+\.\d{2})/g);
    let totalPrice = 0;
    if (priceMatches) {
      // Find the largest price (likely the total)
      for (const pm of priceMatches) {
        const val = parseFloat(pm.replace(/[$,\s]/g, ''));
        if (val > totalPrice) totalPrice = val;
      }
    }

    if (totalPrice > 0 && profile.max_price > 0 && totalPrice > profile.max_price) {
      const msg = `Price $${totalPrice} exceeds max $${profile.max_price} - ABORTING`;
      console.log(`[autobuy] ${msg}`);
      await page.screenshot({ path: fullScreenshotPath, fullPage: false });
      await pool.query(`UPDATE autobuy_orders SET status = 'failed', error_message = $1, screenshot_path = $2 WHERE id = $3`,
        [msg, screenshotPath, orderId]);
      sendNtfy(NTFY_TOPIC, `⛔ Auto-buy ABORTED: ${product.name}`, msg, 5);
      await browser.close();
      return { success: false, error: msg, orderId };
    }

    // Step 5: Handle shipping address
    // Look for saved address or fill in new one
    const addressSection = await page.$('[class*="address"], [class*="shipping"]');
    if (addressSection) {
      // Check if there's a saved address already selected
      const savedAddr = await page.$('[class*="selected"], [class*="default"]');
      if (!savedAddr && profile.shipping_name) {
        // Try to fill address fields
        const fields = {
          'input[name*="firstName"], input[name*="first_name"]': profile.shipping_name.split(' ')[0],
          'input[name*="lastName"], input[name*="last_name"]': profile.shipping_name.split(' ').slice(1).join(' '),
          'input[name*="address1"], input[name*="line1"], input[name*="street"]': profile.shipping_address1,
          'input[name*="address2"], input[name*="line2"], input[name*="apt"]': profile.shipping_address2 || '',
          'input[name*="city"]': profile.shipping_city,
          'input[name*="zip"], input[name*="postal"]': profile.shipping_zip,
          'input[name*="phone"], input[type="tel"]': profile.shipping_phone,
        };
        for (const [selector, value] of Object.entries(fields)) {
          if (value) {
            const field = await page.$(selector);
            if (field) await field.fill(value);
          }
        }
        // State dropdown
        if (profile.shipping_state) {
          const stateSelect = await page.$('select[name*="state"], select[name*="region"]');
          if (stateSelect) await stateSelect.selectOption({ label: profile.shipping_state });
        }
      }
    }

    // Step 6: Select payment (use saved payment method)
    const paymentSection = await page.$('[class*="payment"]');
    if (paymentSection) {
      console.log('[autobuy] Payment section found, using saved payment method');
      // Samsung typically shows saved payment methods; just ensure one is selected
    }

    // DRY RUN: Stop here, take screenshot
    if (dryRun) {
      console.log('[autobuy] DRY RUN - stopping before place order');
      await page.screenshot({ path: fullScreenshotPath, fullPage: true });
      await pool.query(`UPDATE autobuy_orders SET status = 'attempted', screenshot_path = $1, error_message = 'Dry run - stopped before placing order' WHERE id = $2`,
        [screenshotPath, orderId]);
      // Save cookies for future use
      const newCookies = await context.cookies();
      const encCookies = encrypt(JSON.stringify(newCookies));
      await pool.query(`UPDATE autobuy_profiles SET session_cookies = $1 WHERE id = $2`, [encCookies, profile.id]);
      await browser.close();
      return { success: true, dryRun: true, screenshotPath, orderId };
    }

    // Step 7: Place order
    console.log('[autobuy] Placing order...');
    const placeOrderBtn = await page.$('button:has-text("Place Order"), button:has-text("Submit Order"), button:has-text("Complete Purchase")');
    if (!placeOrderBtn) {
      await page.screenshot({ path: fullScreenshotPath, fullPage: true });
      throw new Error('Place Order button not found');
    }
    await placeOrderBtn.click();
    await page.waitForTimeout(10000);

    // Step 8: Screenshot confirmation
    await page.screenshot({ path: fullScreenshotPath, fullPage: true });

    // Step 9: Extract order number
    const confirmText = await page.innerText('body');
    let orderNumber = '';
    const orderMatch = confirmText.match(/order\s*(?:#|number|num)?\s*[:\s]*([A-Z0-9-]+)/i);
    if (orderMatch) orderNumber = orderMatch[1];

    // Save cookies
    const newCookies = await context.cookies();
    const encCookies = encrypt(JSON.stringify(newCookies));
    await pool.query(`UPDATE autobuy_profiles SET session_cookies = $1 WHERE id = $2`, [encCookies, profile.id]);

    // Update order record
    await pool.query(
      `UPDATE autobuy_orders SET status = 'success', order_number = $1, screenshot_path = $2 WHERE id = $3`,
      [orderNumber, screenshotPath, orderId]
    );

    // Notify
    sendNtfy(NTFY_TOPIC, `✅ Auto-purchased ${product.name}!`, 
      `Order ${orderNumber ? '#' + orderNumber : 'placed'}${totalPrice ? ' | Total: $' + totalPrice : ''}`, 5);

    await browser.close();
    return { success: true, orderNumber, screenshotPath, orderId };

  } catch (err) {
    console.error('[autobuy] Error:', err.message);
    if (browser) {
      try {
        const pages = browser.contexts()[0]?.pages();
        if (pages && pages.length > 0) {
          await pages[0].screenshot({ path: fullScreenshotPath, fullPage: false }).catch(() => {});
        }
      } catch (e) {}
      await browser.close();
    }
    await pool.query(
      `UPDATE autobuy_orders SET status = 'failed', error_message = $1, screenshot_path = $2 WHERE id = $3`,
      [err.message, screenshotPath, orderId]
    );
    sendNtfy(NTFY_TOPIC, `❌ Auto-buy FAILED: ${product.name}`, err.message, 4);
    return { success: false, error: err.message, orderId };
  }
}

// --- Integration: check if autobuy should trigger ---
async function checkAndTriggerAutoBuy(pool, product) {
  try {
    // Find enabled profile for this retailer
    const retailer = product.url.includes('samsung.com') ? 'samsung' : product.url.includes('bestbuy.com') ? 'bestbuy' : null;
    if (!retailer) return;

    // Check global kill switch
    const killSwitch = await pool.query(`SELECT enabled FROM autobuy_profiles WHERE name = '__global_kill_switch__' LIMIT 1`);
    if (killSwitch.rows.length > 0 && !killSwitch.rows[0].enabled) {
      console.log('[autobuy] Global kill switch is OFF');
      return;
    }

    // Check product-specific autobuy
    const profileRes = await pool.query(
      `SELECT p.* FROM autobuy_profiles p
       WHERE p.retailer = $1 AND p.enabled = true AND p.name != '__global_kill_switch__'
       LIMIT 1`,
      [retailer]
    );
    if (profileRes.rows.length === 0) return;
    const profile = profileRes.rows[0];

    // Check product autobuy enabled (via product_autobuy join or just check profile)
    const productAutobuy = await pool.query(
      `SELECT * FROM product_autobuy WHERE product_id = $1 AND enabled = true LIMIT 1`,
      [product.id]
    );
    if (productAutobuy.rows.length === 0) return;

    // Duplicate check: no purchase in last 24 hours
    const recentOrder = await pool.query(
      `SELECT id FROM autobuy_orders WHERE product_id = $1 AND status = 'success' AND attempted_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [product.id]
    );
    if (recentOrder.rows.length > 0) {
      console.log('[autobuy] Already purchased in last 24h, skipping');
      return;
    }

    // Rate limit: max 1 attempt per hour
    const recentAttempt = await pool.query(
      `SELECT id FROM autobuy_orders WHERE product_id = $1 AND attempted_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [product.id]
    );
    if (recentAttempt.rows.length > 0) {
      console.log('[autobuy] Already attempted in last hour, skipping');
      return;
    }

    console.log(`[autobuy] IN STOCK detected for ${product.name}, triggering auto-buy in 2s...`);
    sendNtfy(NTFY_TOPIC, `🛒 Auto-buy triggered: ${product.name}`, 'Attempting purchase...', 5);
    await new Promise(r => setTimeout(r, 2000));

    // Retry up to 3 times
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[autobuy] Attempt ${attempt}/3`);
      const result = await attemptSamsungAutoBuy(pool, product, profile, false);
      if (result.success) {
        console.log(`[autobuy] SUCCESS on attempt ${attempt}`);
        return result;
      }
      if (attempt < 3) {
        console.log(`[autobuy] Failed, retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    sendNtfy(NTFY_TOPIC, `❌ Auto-buy FAILED after 3 attempts: ${product.name}`, 'All retry attempts exhausted', 5);
  } catch (err) {
    console.error('[autobuy] checkAndTrigger error:', err.message);
  }
}

module.exports = { encrypt, decrypt, attemptSamsungAutoBuy, checkAndTriggerAutoBuy };
