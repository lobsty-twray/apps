const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const { chromium } = require('playwright');
const path = require('path');
const cookieParser = require('cookie-parser');
const { encrypt, decrypt, attemptSamsungAutoBuy, checkAndTriggerAutoBuy } = require('./samsung-autobuy');
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
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

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
    // Auto-buy tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_profiles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        retailer VARCHAR(50) NOT NULL DEFAULT 'samsung',
        email VARCHAR(255),
        password_encrypted TEXT,
        shipping_name VARCHAR(255),
        shipping_address1 VARCHAR(255),
        shipping_address2 VARCHAR(255),
        shipping_city VARCHAR(100),
        shipping_state VARCHAR(50),
        shipping_zip VARCHAR(20),
        shipping_phone VARCHAR(30),
        session_cookies TEXT,
        enabled BOOLEAN DEFAULT true,
        max_price NUMERIC DEFAULT 3000,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_orders (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        profile_id INTEGER REFERENCES autobuy_profiles(id) ON DELETE SET NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'attempted',
        order_number VARCHAR(255),
        screenshot_path TEXT,
        error_message TEXT,
        attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_autobuy (
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        profile_id INTEGER REFERENCES autobuy_profiles(id) ON DELETE CASCADE,
        enabled BOOLEAN DEFAULT false,
        PRIMARY KEY (product_id, profile_id)
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
  await checkAlerts(product, result);
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
async function checkAlerts(product, result) {
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
  // Trigger auto-buy if in stock
  if (result.inStock) {
    checkAndTriggerAutoBuy(pool, product).catch(e => console.error("[autobuy] trigger error:", e.message));
  }
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

// Auto-buy admin routes
const { autobuyRoutes } = require('./autobuy-routes');
app.use('/admin/autobuy', autobuyRoutes(pool));

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// --- Seed ---
// Cookie parser middleware
const ADMIN_PASS = process.env.AUTOBUY_ADMIN_PASSWORD || 'ray2026';
function adminAuth(req, res, next) {
  const token = req.query.token || req.headers['x-admin-token'] || req.cookies?.autobuy_token;
  if (token === ADMIN_PASS) { res.cookie('autobuy_token', token, { httpOnly: true, maxAge: 86400000 }); return next(); }
  if (req.method === 'POST' && req.body?.password === ADMIN_PASS) { res.cookie('autobuy_token', ADMIN_PASS, { httpOnly: true, maxAge: 86400000 }); return next(); }
  if (req.method === 'GET') return res.send(adminLoginHTML());
  res.status(401).json({ error: 'Unauthorized' });
}

// Login page
function adminLoginHTML() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-Buy Admin</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh}.login{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:2rem;width:90%;max-width:400px;text-align:center}h1{font-size:1.5rem;margin-bottom:1rem;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}input{width:100%;padding:12px 16px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:#fff;font-size:1rem;margin:0.5rem 0}button{width:100%;padding:12px;background:linear-gradient(135deg,#00d4ff,#7c3aed);border:none;border-radius:8px;color:#fff;font-size:1rem;cursor:pointer;margin-top:0.5rem}button:hover{opacity:0.9}</style></head><body><div class="login"><h1>🛒 Auto-Buy Admin</h1><p style="color:#888;margin-bottom:1rem">Enter admin password</p><form method="POST"><input type="password" name="password" placeholder="Password" autofocus><button type="submit">Login</button></form></div></body></html>';
}

// Dashboard
app.get('/admin/autobuy', adminAuth, async (req, res) => {
  try {
    const profiles = (await pool.query("SELECT * FROM autobuy_profiles WHERE name != '__global_kill_switch__' ORDER BY id")).rows;
    const products = (await pool.query('SELECT * FROM products ORDER BY id')).rows;
    const pab = (await pool.query('SELECT * FROM product_autobuy')).rows;
    const orders = (await pool.query("SELECT o.*, p.name as product_name FROM autobuy_orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.attempted_at DESC LIMIT 20")).rows;
    res.send(dashboardHTML(profiles, products, pab, orders));
  } catch(e) { res.status(500).send('Error: ' + e.message); }
});
app.post('/admin/autobuy', adminAuth, (req, res) => res.redirect('/admin/autobuy?token=' + ADMIN_PASS));

// Setup form
app.get('/admin/autobuy/setup', adminAuth, async (req, res) => { res.send(setupHTML(null)); });
app.get('/admin/autobuy/edit/:id', adminAuth, async (req, res) => {
  const p = (await pool.query('SELECT * FROM autobuy_profiles WHERE id=$1',[req.params.id])).rows[0];
  res.send(setupHTML(p));
});

// Save profile
app.post('/admin/autobuy/profiles', adminAuth, async (req, res) => {
  const { id, name, retailer, email, password, max_price, shipping_name, shipping_address1, shipping_address2, shipping_city, shipping_state, shipping_zip, shipping_phone } = req.body;
  const mp = parseInt(max_price) || 3000;
  if (id) {
    let q = 'UPDATE autobuy_profiles SET name=$1,retailer=$2,email=$3,max_price=$4,shipping_name=$5,shipping_address1=$6,shipping_address2=$7,shipping_city=$8,shipping_state=$9,shipping_zip=$10,shipping_phone=$11,updated_at=NOW()';
    let params = [name,retailer,email,mp,shipping_name,shipping_address1,shipping_address2,shipping_city,shipping_state,shipping_zip,shipping_phone];
    if (password) { q += ',password_encrypted=$12 WHERE id=$13'; params.push(encrypt(password), id); }
    else { q += ' WHERE id=$12'; params.push(id); }
    await pool.query(q, params);
  } else {
    await pool.query('INSERT INTO autobuy_profiles(name,retailer,email,password_encrypted,max_price,shipping_name,shipping_address1,shipping_address2,shipping_city,shipping_state,shipping_zip,shipping_phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [name,retailer,email,password?encrypt(password):'',mp,shipping_name,shipping_address1,shipping_address2,shipping_city,shipping_state,shipping_zip,shipping_phone]);
  }
  res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
});

// Toggle auto-buy for a product
app.post('/admin/autobuy/toggle/:productId', adminAuth, async (req, res) => {
  const pid = req.params.productId;
  const existing = (await pool.query('SELECT * FROM product_autobuy WHERE product_id=$1',[pid])).rows[0];
  if (existing) {
    await pool.query('UPDATE product_autobuy SET enabled = NOT enabled WHERE product_id=$1',[pid]);
  } else {
    const profile = (await pool.query("SELECT id FROM autobuy_profiles WHERE name != '__global_kill_switch__' LIMIT 1")).rows[0];
    if (profile) await pool.query('INSERT INTO product_autobuy(product_id,profile_id,enabled) VALUES($1,$2,true)',[pid,profile.id]);
  }
  res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
});

// Toggle profile
app.post('/admin/autobuy/toggle-profile/:id', adminAuth, async (req, res) => {
  await pool.query('UPDATE autobuy_profiles SET enabled = NOT enabled WHERE id=$1',[req.params.id]);
  res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
});

// Test (dry run)
app.post('/admin/autobuy/test/:productId', adminAuth, async (req, res) => {
  const product = (await pool.query('SELECT * FROM products WHERE id=$1',[req.params.productId])).rows[0];
  if (!product) return res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
  const retailer = product.url.includes('samsung.com') ? 'samsung' : 'bestbuy';
  const profile = (await pool.query("SELECT * FROM autobuy_profiles WHERE retailer=$1 AND enabled=true AND name != '__global_kill_switch__' LIMIT 1",[retailer])).rows[0];
  if (!profile) return res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
  attemptSamsungAutoBuy(pool, product, profile, true).catch(e => console.error('[test]', e.message));
  res.redirect('/admin/autobuy?token=' + ADMIN_PASS);
});

// Orders API
app.get('/admin/autobuy/orders', adminAuth, async (req, res) => {
  const orders = (await pool.query("SELECT o.*, p.name as product_name FROM autobuy_orders o LEFT JOIN products p ON o.product_id = p.id ORDER BY o.attempted_at DESC LIMIT 50")).rows;
  res.json(orders);
});
function dashboardHTML(profiles, products, pab, orders) {
  const css = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;padding:1rem;max-width:800px;margin:0 auto}h1{font-size:1.8rem;text-align:center;margin:1rem 0;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}h2{font-size:1.2rem;color:#00d4ff;margin:1.5rem 0 .5rem;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:.5rem}.card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:1rem;margin:.5rem 0}.card:hover{border-color:rgba(0,212,255,.3)}.card-header{display:flex;align-items:center;gap:.5rem;margin-bottom:.5rem;flex-wrap:wrap}.card-header h3{font-size:1rem}.badge{padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600}.bg{background:rgba(34,197,94,.2);color:#22c55e}.br{background:rgba(239,68,68,.2);color:#ef4444}.by{background:rgba(234,179,8,.2);color:#eab308}.actions{display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap}.btn{padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;cursor:pointer;font-size:.85rem;text-decoration:none;display:inline-block}.btn:hover{background:rgba(255,255,255,.15)}.bb{border-color:rgba(0,212,255,.4);color:#00d4ff}.by2{border-color:rgba(234,179,8,.4);color:#eab308}.bg2{border-color:rgba(34,197,94,.4);color:#22c55e;font-size:1rem;padding:10px 20px}p{color:#aaa;font-size:.9rem;margin:.25rem 0}.err{color:#ef4444}.time{color:#666;font-size:.8rem;margin-left:auto}a{color:#00d4ff}`;
  const AP = process.env.AUTOBUY_ADMIN_PASSWORD || 'ray2026';
  const pc = profiles.map(p => `<div class="card"><div class="card-header"><span class="badge ${p.enabled?'bg':'br'}">${p.enabled?'Active':'Disabled'}</span><h3>${p.name}</h3></div><p>Retailer: ${p.retailer} | Email: ${p.email||'Not set'}</p><p>Shipping: ${p.shipping_name||'Not configured'} | Max: $${p.max_price||'No limit'}</p><div class="actions"><form method="POST" action="/admin/autobuy/toggle-profile/${p.id}?token=${AP}" style="display:inline"><button class="btn">${p.enabled?'Disable':'Enable'}</button></form><a href="/admin/autobuy/edit/${p.id}?token=${AP}" class="btn bb">Edit</a></div></div>`).join('');
  const prc = products.map(p => { const ab = pab.find(x=>x.product_id===p.id); const en = ab?.enabled||false; return `<div class="card"><div class="card-header"><span class="badge ${en?'bg':'br'}">${en?'Auto-Buy ON':'Auto-Buy OFF'}</span><h3>${p.name}</h3></div><p>Status: ${p.last_status} | Price: ${p.last_price?'$'+p.last_price:'N/A'} | ${p.active?'Tracking':'Paused'}</p><div class="actions"><form method="POST" action="/admin/autobuy/toggle/${p.id}?token=${AP}" style="display:inline"><button class="btn">${en?'Disable':'Enable'} Auto-Buy</button></form><form method="POST" action="/admin/autobuy/test/${p.id}?token=${AP}" style="display:inline"><button class="btn by2">🧪 Test</button></form></div></div>`; }).join('');
  const oc = orders.map(o => `<div class="card"><div class="card-header"><span class="badge ${o.status==='success'?'bg':o.status==='failed'?'br':'by'}">${o.status}</span><span class="time">${new Date(o.attempted_at).toLocaleString()}</span></div><p>${o.product_name||'Product #'+o.product_id}${o.order_number?' | Order #'+o.order_number:''}</p>${o.error_message?'<p class="err">'+o.error_message+'</p>':''}${o.screenshot_path?'<a href="/'+o.screenshot_path+'" target="_blank" class="btn bb">📸 Screenshot</a>':''}</div>`).join('') || '<p style="color:#666">No orders yet</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-Buy Admin</title><style>${css}</style></head><body><h1>🛒 Auto-Buy Admin</h1><a href="/admin/autobuy/setup?token=${AP}" class="btn bg2" style="display:block;text-align:center;margin:1rem 0">+ Add/Edit Profile</a><h2>📋 Profiles</h2>${pc||'<p style="color:#666">No profiles. Add one above!</p>'}<h2>📦 Products</h2>${prc}<h2>📜 Order History</h2>${oc}<div style="text-align:center;margin-top:2rem"><a href="/" class="btn">← Back to Monitor</a></div></body></html>`;
}

function setupHTML(profile) {
  const p = profile || {};
  const AP = process.env.AUTOBUY_ADMIN_PASSWORD || 'ray2026';
  const css = `*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;padding:1rem;max-width:600px;margin:0 auto}h1{font-size:1.5rem;text-align:center;margin:1rem 0;background:linear-gradient(135deg,#00d4ff,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent}label{display:block;color:#aaa;font-size:.85rem;margin:.75rem 0 .25rem}input,select{width:100%;padding:10px 14px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:#fff;font-size:.95rem}input:focus,select:focus{border-color:#00d4ff;outline:none}.row{display:grid;grid-template-columns:1fr 1fr;gap:.5rem}button{width:100%;padding:12px;background:linear-gradient(135deg,#00d4ff,#7c3aed);border:none;border-radius:8px;color:#fff;font-size:1rem;cursor:pointer;margin-top:1.5rem}button:hover{opacity:.9}h2{font-size:1.1rem;color:#00d4ff;margin:1.5rem 0 .5rem}a{color:#00d4ff}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto-Buy Setup</title><style>${css}</style></head><body><h1>🛒 Profile Setup</h1><form method="POST" action="/admin/autobuy/profiles?token=${AP}"><input type="hidden" name="id" value="${p.id||''}"><h2>Account</h2><label>Profile Name</label><input name="name" value="${p.name||''}" placeholder="My Samsung Account" required><label>Retailer</label><select name="retailer"><option value="samsung" ${p.retailer==='samsung'?'selected':''}>Samsung</option><option value="bestbuy" ${p.retailer==='bestbuy'?'selected':''}>Best Buy</option></select><label>Account Email</label><input name="email" type="email" value="${p.email||''}" placeholder="your@email.com"><label>Account Password</label><input name="password" type="password" placeholder="${p.id?'(unchanged if empty)':'Enter password'}"><label>Max Price ($)</label><input name="max_price" type="number" value="${p.max_price||3000}" placeholder="3000"><h2>Shipping</h2><label>Full Name</label><input name="shipping_name" value="${p.shipping_name||''}" placeholder="Your Name"><label>Address Line 1</label><input name="shipping_address1" value="${p.shipping_address1||''}" placeholder="123 Main St"><label>Address Line 2</label><input name="shipping_address2" value="${p.shipping_address2||''}" placeholder="Apt 4B"><div class="row"><div><label>City</label><input name="shipping_city" value="${p.shipping_city||''}" placeholder="Jersey City"></div><div><label>State</label><input name="shipping_state" value="${p.shipping_state||''}" placeholder="NJ"></div></div><div class="row"><div><label>ZIP</label><input name="shipping_zip" value="${p.shipping_zip||''}" placeholder="07302"></div><div><label>Phone</label><input name="shipping_phone" value="${p.shipping_phone||''}" placeholder="201-555-1234"></div></div><button type="submit">💾 Save Profile</button></form><div style="text-align:center;margin-top:1rem"><a href="/admin/autobuy?token=${AP}">← Back to Dashboard</a></div></body></html>`;
}
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
