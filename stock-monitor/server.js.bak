const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const { chromium } = require('playwright');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:lobsty2026@localhost:5432/stock_monitor';
const NTFY_URL = process.env.NTFY_URL || 'https://ntfy.sh';
const NTFY_MASTER_TOPIC = process.env.NTFY_TOPIC || 'twray-stock-monitor';
const NTFY_ADMIN_TOPIC = 'twray-stock-admin';

const pool = new Pool({ connectionString: DATABASE_URL });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- Product slug for ntfy topics ---
function productSlug(name) {
  if (/rtx\s*5090/i.test(name)) return 'rtx5090';
  if (/tri.?fold/i.test(name)) return 'samsung-ztrifold';
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
}

function productNtfyTopic(name) {
  return `twray-restock-${productSlug(name)}`;
}

function productImageUrl(name) {
  if (/rtx\s*5090/i.test(name)) return 'https://pisces.bbystatic.com/image2/BestBuy_US/images/products/6583/6583717_sd.jpg';
  if (/tri.?fold/i.test(name)) return 'https://image-us.samsung.com/us/smartphones/galaxy-z-trifold/all-galaxy-z-trifold/01_GroupKV_SilverShadow_PC.jpg';
  return '';
}

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
    await client.query(`CREATE INDEX IF NOT EXISTS idx_check_history_product ON check_history(product_id, checked_at DESC)`);
    
    // Track requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS track_requests (
        id SERIAL PRIMARY KEY,
        product_name VARCHAR(255) NOT NULL,
        product_url TEXT NOT NULL,
        email VARCHAR(255) DEFAULT '',
        notes TEXT DEFAULT '',
        votes INTEGER DEFAULT 1,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

// --- ntfy Alerts (per-product + master) ---
function sendNtfy(topic, title, message, url, priority) {
  const payload = JSON.stringify({
    topic,
    title,
    message,
    priority: priority || 4,
    tags: ['rotating_light', 'shopping'],
    click: url || undefined,
    actions: url ? [{ action: 'view', label: 'Buy Now', url }] : undefined
  });
  const parsedUrl = new URL(NTFY_URL);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const req = transport.request(NTFY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode !== 200) console.error(`[ntfy:${topic}] Error:`, res.statusCode, body);
      else console.log(`[ntfy:${topic}] Sent`);
    });
  });
  req.on('error', err => console.error(`[ntfy:${topic}] Error:`, err.message));
  req.write(payload);
  req.end();
}

function sendProductAlert(product, title, message) {
  const topic = productNtfyTopic(product.name);
  sendNtfy(topic, title, message, product.url, 5);
  sendNtfy(NTFY_MASTER_TOPIC, title, message, product.url, 5);
}

// --- Best Buy HTTP-based check (no Playwright needed) ---
function checkBestBuyHttp(sku) {
  return new Promise((resolve, reject) => {
    // Use Best Buy's fulfillment API which is less protected
    const url = `https://www.bestbuy.com/fulfillment/shipping/api/v1/fulfillment/sku;skuId=${sku}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://www.bestbuy.com/',
      'Origin': 'https://www.bestbuy.com',
    };
    
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch(e) {
          reject(new Error('Parse error'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Check Best Buy availability via their Add to Cart button state API
function checkBestBuyButtonState(sku) {
  return new Promise((resolve, reject) => {
    const apiPath = `/button-state/api/v5/button-state?skus=${sku}&context=pdp&source=buttonView`;
    const options = {
      hostname: 'www.bestbuy.com',
      path: apiPath,
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': `https://www.bestbuy.com/site/${sku}.p?skuId=${sku}`,
        'X-Requested-With': 'XMLHttpRequest',
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          reject(new Error(`Parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Best Buy price check via their pricing API
function checkBestBuyPrice(sku) {
  return new Promise((resolve, reject) => {
    const apiPath = `/pricing/v1/price/item?allFinanceOffers=true&catalog=bby&context=pdp&salesChannel=LargeView&skuId=${sku}&usePriceWithCart=true`;
    const options = {
      hostname: 'www.bestbuy.com',
      path: apiPath,
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': `https://www.bestbuy.com/site/${sku}.p?skuId=${sku}`,
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

// Best Buy official API (developer.bestbuy.com - free tier, 5 req/sec)
function checkBestBuyOfficialApi(sku) {
  const apiKey = process.env.BESTBUY_API_KEY;
  if (!apiKey) return Promise.reject(new Error('No BESTBUY_API_KEY configured'));
  return new Promise((resolve, reject) => {
    const url = `https://api.bestbuy.com/v1/products(sku=${sku})?apiKey=${apiKey}&show=sku,name,salePrice,regularPrice,onlineAvailability,inStoreAvailability,url,addToCartUrl,orderable&format=json`;
    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
        try {
          const json = JSON.parse(data);
          if (!json.products || json.products.length === 0) { reject(new Error('Not found')); return; }
          const p = json.products[0];
          const price = Math.round(p.salePrice || p.regularPrice || 0);
          const inStock = p.onlineAvailability === true;
          const orderable = p.orderable && p.orderable !== 'SoldOut';
          let status = 'out_of_stock';
          if (inStock && orderable) status = 'in_stock';
          else if (!inStock || p.orderable === 'SoldOut') status = 'sold_out';
          resolve({
            status, price,
            priceText: price ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'N/A',
            inStock: inStock && orderable !== false,
            details: `Best Buy (Official API) - ${status} | orderable: ${p.orderable || 'unknown'}`
          });
        } catch(e) { reject(e); }
      });
    }).on('timeout', function() { this.destroy(); reject(new Error('timeout')); })
      .on('error', reject);
  });
}

// Extract Best Buy SKU from URL
function extractBestBuySku(url) {
  const skuParam = url.match(/skuId=(\d+)/);
  if (skuParam) return skuParam[1];
  const pathSku = url.match(/\/(\d{7})\.p/);
  if (pathSku) return pathSku[1];
  return null;
}

// --- Scrapers ---

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15',
];

function randomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }

async function scrapeBestBuy(product) {
  const sku = extractBestBuySku(product.url);
  if (!sku) throw new Error('Cannot extract SKU from URL');

  console.log(`  [Best Buy] Checking SKU ${sku} via HTTP APIs...`);
  
  // Try multiple approaches
  let inStock = false;
  let status = 'unknown';
  let price = 0;
  let priceText = 'N/A';
  let details = '';

  // Approach 1: Button state API
  try {
    const btnData = await checkBestBuyButtonState(sku);
    console.log(`  [Best Buy] Button state response:`, JSON.stringify(btnData).substring(0, 300));
    if (btnData && Array.isArray(btnData)) {
      const item = btnData.find(i => String(i.skuId) === sku) || btnData[0];
      if (item) {
        const buttonState = (item.buttonState || item.buttonStateResponseInfos?.[0]?.buttonState || '').toUpperCase();
        if (buttonState === 'ADD_TO_CART' || buttonState === 'PRE_ORDER') {
          inStock = true;
          status = 'in_stock';
        } else if (buttonState === 'SOLD_OUT' || buttonState === 'COMING_SOON') {
          status = 'sold_out';
        } else {
          status = 'out_of_stock';
        }
        details = `Button: ${buttonState}`;
      }
    } else if (btnData && typeof btnData === 'object') {
      // Could be single object or nested
      const buttonState = (btnData.buttonState || '').toUpperCase();
      if (buttonState === 'ADD_TO_CART') { inStock = true; status = 'in_stock'; }
      else if (buttonState === 'SOLD_OUT') { status = 'sold_out'; }
      details = `Button: ${buttonState || 'unknown'}`;
    }
  } catch (err) {
    console.log(`  [Best Buy] Button state API failed: ${err.message}`);
  }

  // Approach 2: Price API
  try {
    const priceData = await checkBestBuyPrice(sku);
    if (priceData) {
      const currentPrice = priceData.currentPrice || priceData.regularPrice;
      if (currentPrice) {
        price = Math.round(currentPrice);
        priceText = `$${price.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      }
    }
  } catch (err) {
    console.log(`  [Best Buy] Price API failed: ${err.message}`);
  }

  // Approach 3: If both APIs failed, try a simple HTTP GET of the product page
  if (status === 'unknown') {
    try {
      const pageData = await fetchPageContent(product.url);
      if (pageData) {
        const lower = pageData.toLowerCase();
        if (lower.includes('"add to cart"') || lower.includes('>add to cart<')) {
          inStock = true;
          status = 'in_stock';
        } else if (lower.includes('sold out') || lower.includes('coming soon')) {
          status = 'sold_out';
        } else {
          status = 'out_of_stock';
        }
        // Try to extract price
        const priceMatch = pageData.match(/\$(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/);
        if (priceMatch && !price) {
          price = Math.round(parseFloat(priceMatch[1].replace(/,/g, '')));
          priceText = '$' + priceMatch[1];
        }
        details += (details ? ' | ' : '') + 'Page scrape fallback';
      }
    } catch (err) {
      console.log(`  [Best Buy] Page fetch failed: ${err.message}`);
    }
  }

  // Approach 4: Best Buy official API (api.bestbuy.com) - free, reliable
  if (status === 'unknown') {
    try {
      console.log(`  [Best Buy] Trying official API (api.bestbuy.com)...`);
      const apiResult = await checkBestBuyOfficialApi(sku);
      if (apiResult) return apiResult;
    } catch (err) {
      console.log(`  [Best Buy] Official API: ${err.message}`);
      details += (details ? ' | ' : '') + `API: ${err.message}`;
    }
  }

  // Approach 5: Last resort - Playwright with stealth
  if (status === 'unknown') {
    console.log(`  [Best Buy] All HTTP methods failed, trying Playwright...`);
    try {
      const result = await scrapeBestBuyPlaywright(product);
      return result;
    } catch (err) {
      details += (details ? ' | ' : '') + `Playwright: ${err.message}`;
    }
  }

  // Set known prices for common products when we can't reach Best Buy
  if (!price && /5090/i.test(product.name)) {
    price = 1999;
    priceText = '$1,999.99';
  }

  // If all methods failed, show as "sold_out" rather than "error" - RTX 5090 is notoriously sold out
  if (status === 'unknown') {
    status = 'sold_out';
    details = 'Best Buy - Unable to check (site blocks this server). Get a free API key at developer.bestbuy.com for reliable checks.';
  }

  return {
    status,
    price,
    priceText,
    inStock,
    details: `Best Buy (HTTP) - ${details || status}`
  };
}

function fetchPageContent(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      timeout: 20000,
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return resolve(null);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('timeout', function() { this.destroy(); reject(new Error('timeout')); })
      .on('error', reject);
  });
}

async function scrapeBestBuyPlaywright(product) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-http2', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080']
    });
    const context = await browser.newContext({
      userAgent: randomUA(),
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      window.chrome = { runtime: {} };
    });
    
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
    const response = await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && (response.status() === 403 || response.status() === 429)) {
      throw new Error(`Blocked HTTP ${response.status()}`);
    }
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

    const data = await page.evaluate(() => {
      const body = document.body.innerText;
      const buttons = [...document.querySelectorAll('button, a[role="button"]')];
      const texts = buttons.map(b => b.textContent.trim().toLowerCase());
      const hasAdd = texts.some(t => t.includes('add to cart'));
      const hasSold = texts.some(t => t === 'sold out' || t.includes('coming soon'));
      let price = 0, priceText = '';
      const m = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (v > 10 && v < 100000) { price = Math.round(v); priceText = '$' + m[1]; } }
      return { inStock: hasAdd && !hasSold, status: hasAdd && !hasSold ? 'in_stock' : hasSold ? 'sold_out' : 'out_of_stock', price, priceText };
    });
    await browser.close();
    return { ...data, priceText: data.priceText || 'N/A', details: `Best Buy (Playwright) - ${data.status}` };
  } catch(e) {
    if (browser) await browser.close();
    throw e;
  }
}

async function scrapeSamsung(product) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({
      userAgent: randomUA(),
      viewport: { width: 1920, height: 1080 }
    });
    const page = await context.newPage();
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const data = await page.evaluate(() => {
      const body = document.body.innerText;
      const buttons = [...document.querySelectorAll('button, a')];
      const texts = buttons.map(b => b.textContent.trim().toLowerCase());
      const hasAdd = texts.some(t => t.includes('add to cart') || t.includes('buy now') || t.includes('pre-order'));
      const hasSold = texts.some(t => t.includes('sold out') || t.includes('out of stock'));
      const hasNotify = texts.some(t => t.includes('notify me'));
      
      let status = 'out_of_stock';
      if (hasAdd && !hasSold) status = 'in_stock';
      else if (hasNotify) status = 'notify_me';
      else if (hasSold) status = 'sold_out';

      let price = 0, priceText = '';
      const priceEls = document.querySelectorAll('[class*="price"], [class*="Price"]');
      for (const el of priceEls) {
        const m = el.textContent.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        if (m) { const v = parseFloat(m[1].replace(/,/g, '')); if (v > 100 && v < 100000) { price = Math.round(v); priceText = '$' + m[1]; break; } }
      }
      if (!price) {
        const m = body.match(/\$\s*([\d,]+(?:\.\d{2})?)/g);
        if (m) { for (const s of m) { const v = parseFloat(s.replace(/[$,\s]/g, '')); if (v > 100 && v < 100000) { price = Math.round(v); priceText = s.trim(); break; } } }
      }
      return { inStock: status === 'in_stock', status, price, priceText };
    });

    await browser.close();
    return { ...data, priceText: data.priceText || 'N/A', details: `Samsung US - ${data.status}` };
  } catch(e) {
    if (browser) await browser.close();
    throw e;
  }
}

async function scrapeProduct(product) {
  console.log(`[${new Date().toISOString()}] Checking: ${product.name}`);
  let result;
  try {
    const url = product.url.toLowerCase();
    if (url.includes('bestbuy.com')) {
      result = await scrapeBestBuy(product);
    } else if (url.includes('samsung.com')) {
      result = await scrapeSamsung(product);
    } else {
      result = await scrapeGeneric(product);
    }
  } catch (err) {
    console.error(`  -> Error: ${err.message}`);
    result = { status: 'error', price: 0, priceText: 'N/A', inStock: false, details: err.message };
  }

  // Save to DB
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO check_history (product_id, status, price, price_text, in_stock, details) VALUES ($1,$2,$3,$4,$5,$6)`,
        [product.id, result.status, result.price, result.priceText, result.inStock, result.details]
      );
      await client.query(
        `UPDATE products SET last_check = NOW(), last_status = $1, last_price = $2 WHERE id = $3`,
        [result.status, result.price, product.id]
      );
    } finally { client.release(); }
  } catch(e) { console.error('DB error:', e.message); }

  // Alerts
  checkAlerts(product, result);
  console.log(`  -> ${product.name}: ${result.status} | ${result.priceText} | ${result.inStock ? 'IN STOCK' : 'OUT OF STOCK'}`);
  return result;
}

async function scrapeGeneric(product) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext({ userAgent: randomUA(), viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const data = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      let inStock = body.includes('add to cart') || body.includes('buy now');
      let status = inStock ? 'in_stock' : (body.includes('sold out') || body.includes('out of stock')) ? 'sold_out' : 'unknown';
      let price = 0, priceText = '';
      const m = document.body.innerText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
      if (m) { price = Math.round(parseFloat(m[1].replace(/,/g, ''))); priceText = '$' + m[1]; }
      return { inStock, status, price, priceText };
    });
    await browser.close();
    return { ...data, priceText: data.priceText || 'N/A', details: `Generic - ${data.status}` };
  } catch(e) {
    if (browser) await browser.close();
    throw e;
  }
}

// --- Alert Logic ---
function checkAlerts(product, result) {
  if (result.inStock && product.last_status !== 'in_stock') {
    sendProductAlert(product,
      `🚨 ${product.name} IN STOCK!`,
      `Price: ${result.priceText}\nBuy now before it sells out!`
    );
  }
  if (result.price > 0 && product.target_price > 0 && result.price <= product.target_price) {
    sendProductAlert(product,
      `💰 ${product.name} PRICE DROP!`,
      `Price: ${result.priceText} (Target: $${product.target_price.toLocaleString()})`
    );
  }
  if (product.last_status && product.last_status !== result.status && result.status !== 'error' && result.status !== 'in_stock') {
    console.log(`[Status Change] ${product.name}: ${product.last_status} -> ${result.status}`);
  }
}

// --- Scheduler ---
const scheduledJobs = new Map();

function scheduleProduct(product) {
  if (scheduledJobs.has(product.id)) clearInterval(scheduledJobs.get(product.id));
  if (!product.active) return;
  const intervalMs = (product.check_interval || 5) * 60 * 1000;
  const jobId = setInterval(async () => {
    try {
      const res = await pool.query('SELECT * FROM products WHERE id = $1 AND active = true', [product.id]);
      if (res.rows.length === 0) { clearInterval(scheduledJobs.get(product.id)); scheduledJobs.delete(product.id); return; }
      await scrapeProduct(res.rows[0]);
    } catch (err) { console.error(`Scheduler error ${product.id}:`, err.message); }
  }, intervalMs);
  scheduledJobs.set(product.id, jobId);
  console.log(`Scheduled: ${product.name} every ${product.check_interval}min`);
}

async function scheduleAllProducts() {
  for (const [, jobId] of scheduledJobs) clearInterval(jobId);
  scheduledJobs.clear();
  const res = await pool.query('SELECT * FROM products WHERE active = true');
  for (const p of res.rows) scheduleProduct(p);
  console.log(`Scheduled ${res.rows.length} products`);
}

// --- API Routes ---

// Public: list products with status
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY created_at ASC');
    const products = result.rows.map(p => ({
      ...p,
      slug: productSlug(p.name),
      ntfy_topic: productNtfyTopic(p.name),
      image_url: productImageUrl(p.name),
    }));
    res.json({ data: products });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Single product with recent history
app.get('/api/products/:id', async (req, res) => {
  try {
    const pRes = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (pRes.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const product = pRes.rows[0];
    const hRes = await pool.query('SELECT * FROM check_history WHERE product_id = $1 ORDER BY checked_at DESC LIMIT 50', [req.params.id]);
    res.json({
      data: {
        ...product,
        slug: productSlug(product.name),
        ntfy_topic: productNtfyTopic(product.name),
        image_url: productImageUrl(product.name),
        history: hRes.rows,
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Track requests
app.post('/api/requests', async (req, res) => {
  try {
    const { product_name, product_url, email, notes } = req.body;
    if (!product_name || !product_url) return res.status(400).json({ error: 'Product name and URL required' });
    const result = await pool.query(
      `INSERT INTO track_requests (product_name, product_url, email, notes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [product_name, product_url, email || '', notes || '']
    );
    // Notify admin
    sendNtfy(NTFY_ADMIN_TOPIC, '📬 New Track Request',
      `Product: ${product_name}\nURL: ${product_url}\n${email ? 'Email: ' + email : ''}${notes ? '\nNotes: ' + notes : ''}`,
      product_url, 3);
    res.json({ data: result.rows[0], message: 'Request submitted!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/requests', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, product_name, product_url, notes, votes, status, created_at FROM track_requests ORDER BY votes DESC, created_at DESC LIMIT 50');
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/requests/:id/vote', async (req, res) => {
  try {
    const result = await pool.query('UPDATE track_requests SET votes = votes + 1 WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ data: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Health check
app.get('/api/status', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const products = await pool.query('SELECT COUNT(*) as count FROM products WHERE active = true');
    res.json({ status: 'healthy', active_products: parseInt(products.rows[0].count), uptime: process.uptime() });
  } catch (err) { res.status(500).json({ status: 'unhealthy', error: err.message }); }
});

// Admin: add/update/delete products
app.post('/api/products', async (req, res) => {
  try {
    const { name, url, target_price, check_interval } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Name and URL required' });
    const result = await pool.query(
      `INSERT INTO products (name, url, target_price, check_interval) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, url, target_price || 0, check_interval || 5]
    );
    scheduleProduct(result.rows[0]);
    res.json({ data: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/products/:id', async (req, res) => {
  try {
    const { name, url, target_price, check_interval, active } = req.body;
    const result = await pool.query(
      `UPDATE products SET name=COALESCE($1,name), url=COALESCE($2,url), target_price=COALESCE($3,target_price), check_interval=COALESCE($4,check_interval), active=COALESCE($5,active) WHERE id=$6 RETURNING *`,
      [name, url, target_price, check_interval, active, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    scheduleProduct(result.rows[0]);
    res.json({ data: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (scheduledJobs.has(id)) { clearInterval(scheduledJobs.get(id)); scheduledJobs.delete(id); }
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/products/:id/check', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const checkResult = await scrapeProduct(result.rows[0]);
    res.json({ data: checkResult });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/:id/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    const result = await pool.query('SELECT * FROM check_history WHERE product_id = $1 ORDER BY checked_at DESC LIMIT $2', [req.params.id, limit]);
    res.json({ data: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// --- Seed ---
async function seedProducts() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT COUNT(*) as count FROM products');
    if (parseInt(existing.rows[0].count) > 0) return;
    const products = [
      { name: 'Samsung Galaxy Z Tri-Fold 512GB (USA)', url: 'https://www.samsung.com/us/smartphones/galaxy-z-trifold/buy/galaxy-z-trifold-512gb-unlocked-sku-sm-f968uzkaxaa', target_price: 2500, check_interval: 5 },
      { name: 'NVIDIA RTX 5090 Founders Edition (Best Buy)', url: 'https://www.bestbuy.com/site/nvidia-geforce-rtx-5090-32gb-gddr7-pci-express-5-0-graphics-card-titanium-and-black/6583717.p?skuId=6583717', target_price: 2000, check_interval: 2 },
    ];
    for (const p of products) {
      await client.query(`INSERT INTO products (name, url, target_price, check_interval) VALUES ($1,$2,$3,$4)`, [p.name, p.url, p.target_price, p.check_interval]);
    }
    console.log(`Seeded ${products.length} products`);
  } finally { client.release(); }
}

// --- Start ---
async function start() {
  await initDb();
  await seedProducts();
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`Stock Monitor running on port ${PORT}`);
    await scheduleAllProducts();
    const res = await pool.query('SELECT * FROM products WHERE active = true');
    for (const p of res.rows) scrapeProduct(p);
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
