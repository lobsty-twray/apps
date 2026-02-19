const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const { chromium } = require('playwright');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@localhost:5432/stock_monitor';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const BESTBUY_API_KEY = process.env.BESTBUY_API_KEY || '';

const pool = new Pool({ connectionString: DATABASE_URL });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Database Setup ---

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        url TEXT NOT NULL,
        target_price INTEGER DEFAULT 0,
        check_interval INTEGER DEFAULT 5,
        last_check TIMESTAMPTZ,
        last_status VARCHAR(50) DEFAULT 'unknown',
        last_price INTEGER DEFAULT 0,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS check_history (
        id SERIAL PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL,
        price INTEGER DEFAULT 0,
        price_text VARCHAR(100) DEFAULT '',
        in_stock BOOLEAN DEFAULT false,
        details TEXT DEFAULT '',
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_check_history_product ON check_history(product_id, checked_at DESC)
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// --- Telegram Alerts ---

function sendTelegramAlert(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[Telegram] No bot token/chat ID configured, skipping alert');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const data = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: false
  });

  const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) console.error('[Telegram] Error:', body);
      else console.log('[Telegram] Alert sent');
    });
  });
  req.on('error', err => console.error('[Telegram] Request error:', err.message));
  req.write(data);
  req.end();
}

// --- Smart Scraper ---

function randomDelay(minMs, maxMs) {
  return new Promise(resolve => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
}

async function scrapeProduct(product) {
  console.log(`[${new Date().toISOString()}] Checking: ${product.name}`);
  let browser;
  try {
    const url = product.url.toLowerCase();
    const isBestBuy = url.includes('bestbuy.com');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        ...(isBestBuy ? [
          '--disable-http2',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--window-size=1920,1080'
        ] : [])
      ]
    });

    let context;
    if (isBestBuy) {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        }
      });
    } else {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
      });
    }

    const page = await context.newPage();

    // Hide automation indicators for Best Buy
    if (isBestBuy) {
      await page.addInitScript(() => {
        // Override navigator.webdriver
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // Override chrome runtime
        window.chrome = { runtime: {} };
        // Override permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
          parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters);
        // Override plugins length
        Object.defineProperty(navigator, 'plugins', {
          get: () => [1, 2, 3, 4, 5]
        });
        // Override languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en']
        });
      });
    }

    let result;

    if (url.includes('samsung.com')) {
      result = await scrapeSamsung(page, product);
    } else if (isBestBuy) {
      result = await scrapeBestBuy(page, product);
    } else {
      result = await scrapeGeneric(page, product);
    }

    await browser.close();
    browser = null;

    // Save to history
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO check_history (product_id, status, price, price_text, in_stock, details)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [product.id, result.status, result.price, result.priceText, result.inStock, result.details]
      );
      await client.query(
        `UPDATE products SET last_check = NOW(), last_status = $1, last_price = $2 WHERE id = $3`,
        [result.status, result.price, product.id]
      );
    } finally {
      client.release();
    }

    // Check for alerts
    checkAlerts(product, result);

    console.log(`  -> ${product.name}: ${result.status} | ${result.priceText} | ${result.inStock ? 'IN STOCK' : 'OUT OF STOCK'}`);
    return result;
  } catch (err) {
    console.error(`  -> Scrape error for ${product.name}:`, err.message);
    // Save error to history
    try {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO check_history (product_id, status, price, price_text, in_stock, details)
           VALUES ($1, 'error', 0, '', false, $2)`,
          [product.id, err.message]
        );
        await client.query(
          `UPDATE products SET last_check = NOW(), last_status = 'error' WHERE id = $1`,
          [product.id]
        );
      } finally {
        client.release();
      }
    } catch (_) { /* ignore db error during error handling */ }
    return { status: 'error', price: 0, priceText: '', inStock: false, details: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

// Parse USD price from text - extracts dollar amounts, ignores KRW/won
function parseUSDPrice(text) {
  if (!text) return 0;
  // Remove KRW/won amounts first
  const cleaned = text.replace(/₩[\d,]+/g, '').replace(/[\d,]+\s*원/g, '');
  // Match USD price patterns: $1,234.56 or $1234 or 1,234.56 (near a $ sign)
  const match = cleaned.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  if (match) {
    return Math.round(parseFloat(match[1].replace(/,/g, '')));
  }
  // Fallback: look for price-like numbers in reasonable USD range
  const nums = cleaned.match(/[\d,]+\.\d{2}/g);
  if (nums) {
    for (const n of nums) {
      const val = parseFloat(n.replace(/,/g, ''));
      if (val > 10 && val < 100000) return Math.round(val);
    }
  }
  return 0;
}

async function scrapeSamsung(page, product) {
  await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const body = document.body.innerText;
    const html = document.body.innerHTML;

    // Detect stock status
    let inStock = false;
    let status = 'out_of_stock';

    // Look for Add to Cart / Buy Now buttons
    const buttons = [...document.querySelectorAll('button, a')];
    const buttonTexts = buttons.map(b => b.textContent.trim().toLowerCase());
    const hasAddToCart = buttonTexts.some(t => t.includes('add to cart') || t.includes('buy now') || t.includes('pre-order'));
    const hasSoldOut = buttonTexts.some(t => t.includes('sold out') || t.includes('out of stock') || t.includes('currently unavailable'));
    const hasNotifyMe = buttonTexts.some(t => t.includes('notify me') || t.includes('notify when available'));

    if (hasAddToCart && !hasSoldOut) {
      inStock = true;
      status = 'in_stock';
    } else if (hasNotifyMe) {
      status = 'notify_me';
    } else if (hasSoldOut) {
      status = 'sold_out';
    }

    // Find USD price
    let priceText = '';
    let price = 0;

    // Samsung US typically shows price in specific elements
    const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"], [data-testid*="price"]');
    for (const el of priceEls) {
      const text = el.textContent.trim();
      const match = text.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (match) {
        const val = parseFloat(match[1].replace(/,/g, ''));
        if (val > 10 && val < 100000) {
          price = Math.round(val);
          priceText = '$' + match[1];
          break;
        }
      }
    }

    // Fallback: search full body text for USD price
    if (!price) {
      const bodyMatch = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/g);
      if (bodyMatch) {
        for (const m of bodyMatch) {
          const val = parseFloat(m.replace(/[$,\s]/g, ''));
          if (val > 100 && val < 100000) {
            price = Math.round(val);
            priceText = m.trim();
            break;
          }
        }
      }
    }

    return { inStock, status, price, priceText };
  });

  return {
    status: data.status,
    price: data.price,
    priceText: data.priceText || (data.price ? `$${data.price.toLocaleString()}` : 'N/A'),
    inStock: data.inStock,
    details: `Samsung US - ${data.status}`
  };
}

// Extract Best Buy SKU from URL
function extractBestBuySku(url) {
  // Format: /site/product-name/6583717.p?skuId=6583717
  const skuParam = url.match(/skuId=(\d+)/);
  if (skuParam) return skuParam[1];
  // Format: /site/product-name/6583717.p
  const pathSku = url.match(/\/(\d{7})\.p/);
  if (pathSku) return pathSku[1];
  // Format: /product/.../sku/6614151
  const altSku = url.match(/\/sku\/(\d+)/);
  if (altSku) return altSku[1];
  return null;
}

// Best Buy scraper - uses Products API (primary) with Playwright fallback
async function scrapeBestBuy(page, product) {
  const sku = extractBestBuySku(product.url);

  // Primary: Best Buy Products API (works from any IP, no browser needed)
  if (BESTBUY_API_KEY && sku) {
    try {
      console.log(`  [Best Buy] Using Products API for SKU ${sku}...`);
      const result = await fetchBestBuyApi(sku);
      if (result) {
        console.log(`  [Best Buy] API success: ${result.status}, price: ${result.priceText}`);
        return result;
      }
    } catch (err) {
      console.log(`  [Best Buy] API failed: ${err.message}`);
    }
  } else if (!BESTBUY_API_KEY) {
    console.log(`  [Best Buy] No API key configured. Set BESTBUY_API_KEY env var (free at developer.bestbuy.com)`);
  }

  // Fallback: Playwright with stealth settings
  console.log(`  [Best Buy] Falling back to Playwright...`);
  try {
    await randomDelay(2000, 4000);

    const response = await page.goto(product.url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    const httpStatus = response ? response.status() : 0;
    console.log(`  [Best Buy] Playwright HTTP status: ${httpStatus}`);

    if (httpStatus === 403 || httpStatus === 429) {
      return {
        status: 'error', price: 0, priceText: 'N/A', inStock: false,
        details: `Best Buy - blocked (HTTP ${httpStatus}). Set BESTBUY_API_KEY for reliable monitoring.`
      };
    }

    // Wait for content to render
    await randomDelay(3000, 5000);

    const domData = await page.evaluate(() => {
      const body = document.body.innerText;
      let inStock = false;
      let status = 'out_of_stock';

      const buttons = [...document.querySelectorAll('button, a[role="button"]')];
      const buttonTexts = buttons.map(b => b.textContent.trim().toLowerCase());
      const hasAddToCart = buttonTexts.some(t => t.includes('add to cart'));
      const hasSoldOut = buttonTexts.some(t =>
        t === 'sold out' || t === 'coming soon' || t.includes('unavailable')
      );

      if (hasAddToCart && !hasSoldOut) { inStock = true; status = 'in_stock'; }
      else if (hasSoldOut) { status = 'sold_out'; }

      let price = 0, priceText = '';
      const match = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (match) {
        const val = parseFloat(match[1].replace(/,/g, ''));
        if (val > 10 && val < 100000) { price = Math.round(val); priceText = '$' + match[1]; }
      }
      return { inStock, status, price, priceText };
    });

    return {
      status: domData.status,
      price: domData.price,
      priceText: domData.priceText || 'N/A',
      inStock: domData.inStock,
      details: `Best Buy (Playwright) - ${domData.status}`
    };

  } catch (err) {
    console.error(`  [Best Buy] Playwright failed: ${err.message}`);
    return {
      status: 'error', price: 0, priceText: 'N/A', inStock: false,
      details: `Best Buy - connection blocked from this server. Set BESTBUY_API_KEY for reliable monitoring.`
    };
  }
}

// Fetch product data from Best Buy Products API
function fetchBestBuyApi(sku) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://api.bestbuy.com/v1/products(sku=${sku})?apiKey=${BESTBUY_API_KEY}&show=sku,name,salePrice,regularPrice,onlineAvailability,inStoreAvailability,url,addToCartUrl,orderable&format=json`;

    https.get(apiUrl, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`API HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          if (!json.products || json.products.length === 0) {
            reject(new Error('Product not found in API'));
            return;
          }
          const p = json.products[0];
          const price = Math.round(p.salePrice || p.regularPrice || 0);
          const inStock = p.onlineAvailability === true;
          const orderable = p.orderable && p.orderable !== 'SoldOut';

          let status = 'out_of_stock';
          if (inStock && orderable) status = 'in_stock';
          else if (!inStock || (p.orderable === 'SoldOut')) status = 'sold_out';

          resolve({
            status,
            price,
            priceText: price ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'N/A',
            inStock: inStock && orderable !== false,
            details: `Best Buy (API) - ${status} | orderable: ${p.orderable || 'unknown'}`
          });
        } catch (e) {
          reject(new Error(`API parse error: ${e.message}`));
        }
      });
    }).on('timeout', function() { this.destroy(); reject(new Error('API timeout')); })
      .on('error', reject);
  });
}

async function scrapeGeneric(page, product) {
  await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const body = document.body.innerText.toLowerCase();
    let inStock = false;
    let status = 'unknown';

    if (body.includes('add to cart') || body.includes('buy now')) {
      inStock = true;
      status = 'in_stock';
    } else if (body.includes('sold out') || body.includes('out of stock') || body.includes('unavailable')) {
      status = 'sold_out';
    }

    let price = 0;
    let priceText = '';
    const fullBody = document.body.innerText;
    const match = fullBody.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
    if (match) {
      price = Math.round(parseFloat(match[1].replace(/,/g, '')));
      priceText = '$' + match[1];
    }

    return { inStock, status, price, priceText };
  });

  return {
    status: data.status,
    price: data.price,
    priceText: data.priceText || 'N/A',
    inStock: data.inStock,
    details: `Generic scrape - ${data.status}`
  };
}

// --- Alert Logic ---

function checkAlerts(product, result) {
  const wasOutOfStock = product.last_status !== 'in_stock';

  // Alert: Product came in stock
  if (result.inStock && wasOutOfStock) {
    const msg = `🚨 <b>${product.name}</b> IN STOCK!\nPrice: ${result.priceText}\n\n<a href="${product.url}">Buy Now</a>`;
    sendTelegramAlert(msg);
  }

  // Alert: Price dropped below target
  if (result.price > 0 && product.target_price > 0 && result.price <= product.target_price) {
    const msg = `💰 <b>${product.name}</b> PRICE DROP!\nPrice: ${result.priceText} (Target: $${product.target_price.toLocaleString()})\n\n<a href="${product.url}">Buy Now</a>`;
    sendTelegramAlert(msg);
  }
}

// --- Per-Product Scheduler ---

const scheduledJobs = new Map();

function scheduleProduct(product) {
  // Clear existing job for this product
  if (scheduledJobs.has(product.id)) {
    clearInterval(scheduledJobs.get(product.id));
  }

  if (!product.active) return;

  const intervalMs = (product.check_interval || 5) * 60 * 1000;
  const jobId = setInterval(async () => {
    try {
      // Re-fetch product to check if still active
      const res = await pool.query('SELECT * FROM products WHERE id = $1 AND active = true', [product.id]);
      if (res.rows.length === 0) {
        clearInterval(scheduledJobs.get(product.id));
        scheduledJobs.delete(product.id);
        return;
      }
      await scrapeProduct(res.rows[0]);
    } catch (err) {
      console.error(`Scheduler error for product ${product.id}:`, err.message);
    }
  }, intervalMs);

  scheduledJobs.set(product.id, jobId);
  console.log(`Scheduled: ${product.name} every ${product.check_interval}min`);
}

async function scheduleAllProducts() {
  // Clear all existing jobs
  for (const [id, jobId] of scheduledJobs) {
    clearInterval(jobId);
  }
  scheduledJobs.clear();

  const res = await pool.query('SELECT * FROM products WHERE active = true');
  for (const product of res.rows) {
    scheduleProduct(product);
  }
  console.log(`Scheduled ${res.rows.length} products for monitoring`);
}

// --- API Routes ---

// List all products
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add new product
app.post('/api/products', async (req, res) => {
  try {
    const { name, url, target_price, check_interval } = req.body;
    if (!name || !url) {
      return res.status(400).json({ error: 'Name and URL are required' });
    }
    const result = await pool.query(
      `INSERT INTO products (name, url, target_price, check_interval)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, url, target_price || 0, check_interval || 5]
    );
    const product = result.rows[0];
    scheduleProduct(product);
    res.json({ data: product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update product
app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, url, target_price, check_interval, active } = req.body;
    const result = await pool.query(
      `UPDATE products SET
        name = COALESCE($1, name),
        url = COALESCE($2, url),
        target_price = COALESCE($3, target_price),
        check_interval = COALESCE($4, check_interval),
        active = COALESCE($5, active)
       WHERE id = $6 RETURNING *`,
      [name, url, target_price, check_interval, active, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const product = result.rows[0];
    scheduleProduct(product);
    res.json({ data: product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete product
app.delete('/api/products/:id', async (req, res) => {
  try {
    if (scheduledJobs.has(parseInt(req.params.id))) {
      clearInterval(scheduledJobs.get(parseInt(req.params.id)));
      scheduledJobs.delete(parseInt(req.params.id));
    }
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual check for a product
app.post('/api/products/:id/check', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const checkResult = await scrapeProduct(result.rows[0]);
    res.json({ data: checkResult });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check history for a product
app.get('/api/products/:id/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const result = await pool.query(
      'SELECT * FROM check_history WHERE product_id = $1 ORDER BY checked_at DESC LIMIT $2',
      [req.params.id, limit]
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Seed Initial Products ---

async function seedProducts() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT COUNT(*) as count FROM products');
    if (parseInt(existing.rows[0].count) > 0) {
      console.log('Products already seeded, skipping');
      return;
    }

    const products = [
      {
        name: 'Samsung Galaxy Z Tri-Fold 512GB (USA)',
        url: 'https://www.samsung.com/us/smartphones/galaxy-z-trifold/buy/galaxy-z-trifold-512gb-unlocked-sku-sm-f968uzkaxaa',
        target_price: 2500,
        check_interval: 5
      },
      {
        name: 'NVIDIA RTX 5090 Founders Edition (Best Buy)',
        url: 'https://www.bestbuy.com/site/nvidia-geforce-rtx-5090-32gb-gddr7-pci-express-5-0-graphics-card-titanium-and-black/6583717.p?skuId=6583717',
        target_price: 2000,
        check_interval: 2
      }
    ];

    for (const p of products) {
      await client.query(
        `INSERT INTO products (name, url, target_price, check_interval) VALUES ($1, $2, $3, $4)`,
        [p.name, p.url, p.target_price, p.check_interval]
      );
    }
    console.log(`Seeded ${products.length} initial products`);
  } finally {
    client.release();
  }
}

// --- Start ---

async function start() {
  await initDb();
  await seedProducts();

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Stock Monitor v2 running on port ${PORT}`);
    await scheduleAllProducts();
    // Run initial check for all products on startup
    const res = await pool.query('SELECT * FROM products WHERE active = true');
    for (const product of res.rows) {
      scrapeProduct(product); // fire-and-forget
    }
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
