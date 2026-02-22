const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { decryptProfile } = require('./db');

const SCREENSHOT_DIR = path.join(__dirname, '../../public/screenshots');

// Track active purchases to prevent duplicates
const activePurchases = new Set();

async function attemptAutoBuy(pool, product, profile, { dryRun = false, sendNtfy } = {}) {
  const restockId = `${product.id}-${Date.now()}`;
  
  // Duplicate guard
  const purchaseKey = `${product.id}`;
  if (activePurchases.has(purchaseKey) && !dryRun) {
    console.log(`[AutoBuy] Already processing purchase for product ${product.id}, skipping`);
    return { status: 'skipped', message: 'Purchase already in progress' };
  }
  
  if (!dryRun) activePurchases.add(purchaseKey);
  
  let browser;
  let order = {
    product_id: product.id,
    profile_id: profile.id,
    status: 'pending',
    dry_run: dryRun,
    restock_id: restockId,
    attempt: 1,
  };

  try {
    // Check kill switch
    const ksRes = await pool.query("SELECT value FROM autobuy_config WHERE key = 'kill_switch'");
    if (ksRes.rows[0]?.value === 'true') {
      throw new Error('Kill switch is ON — auto-buy disabled');
    }

    // Check price cap
    const decrypted = decryptProfile(profile);
    const maxPrice = profile.max_price || 3000;
    if (product.last_price > 0 && product.last_price > maxPrice * 100) {
      throw new Error(`Price $${(product.last_price/100).toFixed(0)} exceeds cap $${maxPrice}`);
    }

    // Check for duplicate recent orders (same product in last hour)
    if (!dryRun) {
      const dupCheck = await pool.query(
        `SELECT id FROM autobuy_orders WHERE product_id = $1 AND status = 'success' AND dry_run = false AND created_at > NOW() - INTERVAL '1 hour'`,
        [product.id]
      );
      if (dupCheck.rows.length > 0) {
        throw new Error('Already purchased this product in the last hour');
      }
    }

    // Insert pending order
    const orderRes = await pool.query(
      `INSERT INTO autobuy_orders (product_id, profile_id, status, dry_run, restock_id, attempt)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [order.product_id, order.profile_id, 'pending', order.dry_run, order.restock_id, order.attempt]
    );
    const orderId = orderRes.rows[0].id;

    console.log(`[AutoBuy] Starting ${dryRun ? 'DRY RUN' : 'LIVE'} purchase for "${product.name}" (order #${orderId})`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled']
    });

    const contextOpts = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    };

    // Load session cookies if available
    if (profile.session_cookies) {
      try {
        const cookies = JSON.parse(profile.session_cookies);
        contextOpts.storageState = { cookies, origins: [] };
      } catch (e) {
        console.log('[AutoBuy] Could not parse session cookies, starting fresh');
      }
    }

    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();
    
    // Anti-detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });

    let result;
    const url = product.url.toLowerCase();
    if (url.includes('samsung.com')) {
      result = await samsungCheckoutFlow(page, context, product, decrypted, dryRun);
    } else if (url.includes('bestbuy.com')) {
      result = await bestbuyCheckoutFlow(page, context, product, decrypted, dryRun);
    } else {
      throw new Error(`No auto-buy flow implemented for this retailer`);
    }

    // Screenshot
    const ssFilename = `order-${orderId}-${Date.now()}.png`;
    const ssPath = path.join(SCREENSHOT_DIR, ssFilename);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: ssPath, fullPage: false });

    // Save cookies for next time
    const state = await context.storageState();
    await pool.query(
      `UPDATE autobuy_profiles SET session_cookies = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(state.cookies), profile.id]
    );

    await browser.close();
    browser = null;

    // Update order
    const status = dryRun ? 'dry_run_success' : (result.success ? 'success' : 'failed');
    await pool.query(
      `UPDATE autobuy_orders SET status = $1, order_number = $2, price = $3, screenshot_path = $4, error_message = $5 WHERE id = $6`,
      [status, result.orderNumber || null, result.price || 0, `/screenshots/${ssFilename}`, result.error || null, orderId]
    );

    // Notify
    if (sendNtfy) {
      if (result.success && !dryRun) {
        sendNtfy('twray-stock-monitor',
          `✅ Auto-purchased: ${product.name}`,
          `Order #${result.orderNumber || 'pending'}\nPrice: $${result.price || 'unknown'}\n\nCheck order history for details.`,
          product.url, 5);
      } else if (dryRun) {
        sendNtfy('twray-stock-admin',
          `🧪 Dry Run Complete: ${product.name}`,
          `Would have purchased at $${result.price || 'unknown'}\nStopped before placing order.`,
          null, 3);
      } else {
        sendNtfy('twray-stock-admin',
          `❌ Auto-buy Failed: ${product.name}`,
          `Error: ${result.error || 'Unknown error'}\nAttempt ${order.attempt}/3`,
          null, 4);
      }
    }

    return { status, orderNumber: result.orderNumber, orderId, error: result.error };

  } catch (err) {
    if (browser) await browser.close();
    console.error(`[AutoBuy] Error:`, err.message);
    
    // Update order if it was created
    await pool.query(
      `UPDATE autobuy_orders SET status = 'failed', error_message = $1 WHERE restock_id = $2 AND status = 'pending'`,
      [err.message, restockId]
    );

    if (sendNtfy) {
      sendNtfy('twray-stock-admin',
        `❌ Auto-buy Error: ${product.name}`,
        err.message, null, 4);
    }

    return { status: 'failed', error: err.message };
  } finally {
    activePurchases.delete(purchaseKey);
  }
}

async function samsungCheckoutFlow(page, context, product, profile, dryRun) {
  console.log('[AutoBuy:Samsung] Navigating to product page...');
  await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if product is available
  const addToCartBtn = await page.$('button:has-text("Add to Cart"), button:has-text("Buy Now"), button:has-text("Pre-Order"), a:has-text("Add to Cart")');
  if (!addToCartBtn) {
    return { success: false, error: 'Add to Cart button not found — product may be out of stock' };
  }

  console.log('[AutoBuy:Samsung] Clicking Add to Cart...');
  await addToCartBtn.click();
  await page.waitForTimeout(3000);

  // Handle any popups/modals for cart
  const goToCartBtn = await page.$('button:has-text("Go to Cart"), a:has-text("Go to Cart"), button:has-text("View Cart"), a:has-text("Checkout")');
  if (goToCartBtn) {
    await goToCartBtn.click();
    await page.waitForTimeout(3000);
  } else {
    // Navigate directly to cart
    await page.goto('https://www.samsung.com/us/web/express/cart/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
  }

  // Extract price from cart
  let price = 0;
  try {
    const priceText = await page.textContent('[class*="price"], [class*="Price"], [class*="total"], [class*="Total"]');
    const m = priceText?.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (m) price = Math.round(parseFloat(m[1].replace(/,/g, '')));
  } catch (e) {}

  // Proceed to checkout
  console.log('[AutoBuy:Samsung] Proceeding to checkout...');
  const checkoutBtn = await page.$('button:has-text("Checkout"), a:has-text("Checkout"), button:has-text("Proceed")');
  if (checkoutBtn) {
    await checkoutBtn.click();
    await page.waitForTimeout(5000);
  }

  // Check if login is needed
  const loginForm = await page.$('input[type="email"], input[name="email"], #email');
  if (loginForm && profile.email) {
    console.log('[AutoBuy:Samsung] Logging in...');
    await loginForm.fill(profile.email);
    const pwField = await page.$('input[type="password"]');
    if (pwField && profile.password) {
      await pwField.fill(profile.password);
    }
    const signInBtn = await page.$('button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")');
    if (signInBtn) {
      await signInBtn.click();
      await page.waitForTimeout(5000);
    }
  }

  // DRY RUN — stop here
  if (dryRun) {
    console.log('[AutoBuy:Samsung] DRY RUN — stopping before placing order');
    return { success: true, price, orderNumber: null, error: null };
  }

  // Look for Place Order button
  const placeOrderBtn = await page.$('button:has-text("Place Order"), button:has-text("Submit Order"), button:has-text("Complete Purchase")');
  if (!placeOrderBtn) {
    return { success: false, error: 'Place Order button not found — may need manual intervention', price };
  }

  console.log('[AutoBuy:Samsung] Placing order...');
  await placeOrderBtn.click();
  await page.waitForTimeout(10000);

  // Extract order number from confirmation
  let orderNumber = null;
  try {
    const pageText = await page.textContent('body');
    const orderMatch = pageText.match(/order\s*(?:#|number|num)?\s*:?\s*([A-Z0-9-]{6,})/i);
    if (orderMatch) orderNumber = orderMatch[1];
  } catch (e) {}

  return { success: true, price, orderNumber };
}

async function bestbuyCheckoutFlow(page, context, product, profile, dryRun) {
  console.log('[AutoBuy:BestBuy] Navigating to product page...');
  await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const addBtn = await page.$('button.add-to-cart-button:not([disabled]), button:has-text("Add to Cart"):not([disabled])');
  if (!addBtn) {
    return { success: false, error: 'Add to Cart not available — sold out' };
  }

  console.log('[AutoBuy:BestBuy] Adding to cart...');
  await addBtn.click();
  await page.waitForTimeout(4000);

  // Go to cart
  await page.goto('https://www.bestbuy.com/cart', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  let price = 0;
  try {
    const priceText = await page.textContent('[class*="price"], .order-summary__total');
    const m = priceText?.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (m) price = Math.round(parseFloat(m[1].replace(/,/g, '')));
  } catch (e) {}

  const checkoutBtn = await page.$('button:has-text("Checkout"), a:has-text("Checkout")');
  if (checkoutBtn) {
    await checkoutBtn.click();
    await page.waitForTimeout(5000);
  }

  // Login if needed
  const emailField = await page.$('#fld-e, input[name="emailAddress"]');
  if (emailField && profile.email) {
    await emailField.fill(profile.email);
    const pwField = await page.$('#fld-p1, input[name="password"]');
    if (pwField && profile.password) await pwField.fill(profile.password);
    const signIn = await page.$('button[type="submit"], button:has-text("Sign In")');
    if (signIn) {
      await signIn.click();
      await page.waitForTimeout(5000);
    }
  }

  if (dryRun) {
    console.log('[AutoBuy:BestBuy] DRY RUN — stopping before placing order');
    return { success: true, price, orderNumber: null };
  }

  const placeBtn = await page.$('button:has-text("Place Your Order"), button:has-text("Place Order")');
  if (!placeBtn) {
    return { success: false, error: 'Place Order button not found', price };
  }

  await placeBtn.click();
  await page.waitForTimeout(10000);

  let orderNumber = null;
  try {
    const text = await page.textContent('body');
    const m = text.match(/order\s*(?:#|number)?\s*:?\s*([A-Z0-9-]{6,})/i);
    if (m) orderNumber = m[1];
  } catch (e) {}

  return { success: true, price, orderNumber };
}

// Retry wrapper
async function attemptAutoBuyWithRetry(pool, product, profile, opts = {}) {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[AutoBuy] Attempt ${attempt}/${maxRetries} for "${product.name}"`);
    const result = await attemptAutoBuy(pool, product, profile, opts);
    if (result.status === 'success' || result.status === 'dry_run_success' || result.status === 'skipped') {
      return result;
    }
    if (attempt < maxRetries) {
      console.log(`[AutoBuy] Retrying in 5 seconds...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return { status: 'failed', error: 'All retry attempts failed' };
}

module.exports = { attemptAutoBuy, attemptAutoBuyWithRetry };
