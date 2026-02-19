const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'shop-dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://lobsty:***REMOVED***@localhost:5432/shop';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let stripe;
if (STRIPE_SECRET_KEY) {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

let pool;

// File upload config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|stl|obj|3mf|step|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    cb(null, ext);
  }
});

// Middleware - raw body for Stripe webhooks must come before json parser
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ====================== Database Init ======================
async function initDatabase() {
  const url = new URL(DATABASE_URL);
  const dbName = url.pathname.slice(1);
  const adminUrl = `${url.protocol}//${url.username}:${url.password}@${url.host}/postgres`;

  const adminPool = new Pool({ connectionString: adminUrl });
  try {
    const result = await adminPool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1", [dbName]
    );
    if (result.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${dbName}"`);
      console.log(`Created database: ${dbName}`);
    }
  } catch (err) {
    console.log('Database check/create note:', err.message);
  } finally {
    await adminPool.end();
  }

  pool = new Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        description TEXT DEFAULT '',
        price DECIMAL(10,2) NOT NULL,
        compare_at_price DECIMAL(10,2),
        type TEXT NOT NULL DEFAULT 'physical',
        sku TEXT UNIQUE,
        inventory_quantity INTEGER DEFAULT 0,
        image_url TEXT,
        digital_file_path TEXT,
        active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        order_number TEXT UNIQUE NOT NULL,
        stripe_checkout_session_id TEXT UNIQUE,
        stripe_payment_intent TEXT,
        customer_email TEXT NOT NULL,
        customer_name TEXT,
        shipping_address JSONB,
        subtotal DECIMAL(10,2) NOT NULL,
        tax DECIMAL(10,2) DEFAULT 0,
        shipping_cost DECIMAL(10,2) DEFAULT 0,
        total DECIMAL(10,2) NOT NULL,
        status TEXT DEFAULT 'pending',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        product_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        price DECIMAL(10,2) NOT NULL,
        type TEXT DEFAULT 'physical',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS download_tokens (
        id SERIAL PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
        order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        downloads_remaining INTEGER DEFAULT 5,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS custom_quotes (
        id SERIAL PRIMARY KEY,
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        description TEXT NOT NULL,
        file_url TEXT,
        status TEXT DEFAULT 'pending',
        quoted_price DECIMAL(10,2),
        admin_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(customer_email)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_download_tokens_token ON download_tokens(token)`);

    // Seed default admin if none exists
    const adminCheck = await client.query('SELECT id FROM admin_users LIMIT 1');
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('admin2026', 10);
      await client.query(
        'INSERT INTO admin_users (email, name, password_hash) VALUES ($1, $2, $3)',
        ['ray@twray.dev', 'Ray', hash]
      );
      console.log('Created default admin user: ray@twray.dev / admin2026');
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

// ====================== Auth Middleware ======================
function adminAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.adminId = decoded.adminId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ====================== Auth Routes ======================
app.post('/api/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    const result = await pool.query('SELECT * FROM admin_users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign({ adminId: user.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/me', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name FROM admin_users WHERE id = $1', [req.adminId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ====================== Public Product Routes ======================
app.get('/api/products', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, description, price, compare_at_price, type, inventory_quantity, image_url, active FROM products WHERE active = true ORDER BY sort_order ASC, created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/products/:slug', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, slug, description, price, compare_at_price, type, inventory_quantity, image_url, active FROM products WHERE slug = $1 AND active = true',
      [req.params.slug]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ====================== Cart / Checkout ======================
app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe is not configured' });
    }

    const { items, customer_email } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Validate items and fetch product details
    const productIds = items.map(i => i.product_id);
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(
      `SELECT id, name, price, type, inventory_quantity, image_url, digital_file_path FROM products WHERE id IN (${placeholders}) AND active = true`,
      productIds
    );

    const products = result.rows;
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });

    // Validate all items exist and have stock
    const lineItems = [];
    let hasPhysical = false;
    let hasDigital = false;

    for (const item of items) {
      const product = productMap[item.product_id];
      if (!product) {
        return res.status(400).json({ error: `Product ${item.product_id} not found` });
      }
      if (product.type === 'physical' && product.inventory_quantity < item.quantity) {
        return res.status(400).json({ error: `${product.name} is out of stock` });
      }
      if (product.type === 'physical') hasPhysical = true;
      if (product.type === 'digital') hasDigital = true;

      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            ...(product.image_url ? { images: [`${BASE_URL}${product.image_url}`] } : {})
          },
          unit_amount: Math.round(parseFloat(product.price) * 100)
        },
        quantity: item.quantity
      });
    }

    // Add flat rate shipping for physical items
    if (hasPhysical) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Shipping (USPS)' },
          unit_amount: 500 // $5.00
        },
        quantity: 1
      });
    }

    const sessionConfig = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${BASE_URL}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cart`,
      customer_email: customer_email || undefined,
      metadata: {
        items: JSON.stringify(items),
        has_physical: hasPhysical ? 'true' : 'false',
        has_digital: hasDigital ? 'true' : 'false'
      }
    };

    // Collect shipping address for physical items
    if (hasPhysical) {
      sessionConfig.shipping_address_collection = {
        allowed_countries: ['US']
      };
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);
    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// ====================== Stripe Webhook ======================
app.post('/api/webhooks/stripe', async (req, res) => {
  let event;

  if (STRIPE_WEBHOOK_SECRET) {
    const sig = req.headers['stripe-signature'];
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  } else {
    event = JSON.parse(req.body);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await handleCheckoutComplete(session);
  }

  res.json({ received: true });
});

async function handleCheckoutComplete(session) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if order already exists
    const existing = await client.query(
      'SELECT id FROM orders WHERE stripe_checkout_session_id = $1',
      [session.id]
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return;
    }

    const items = JSON.parse(session.metadata.items);
    const orderNumber = `TWR-${Date.now().toString(36).toUpperCase()}`;

    // Calculate totals
    let subtotal = 0;
    const productIds = items.map(i => i.product_id);
    const placeholders = productIds.map((_, i) => `$${i + 1}`).join(',');
    const productsResult = await client.query(
      `SELECT id, name, price, type, digital_file_path FROM products WHERE id IN (${placeholders})`,
      productIds
    );
    const productMap = {};
    productsResult.rows.forEach(p => { productMap[p.id] = p; });

    for (const item of items) {
      const product = productMap[item.product_id];
      subtotal += parseFloat(product.price) * item.quantity;
    }

    const hasPhysical = session.metadata.has_physical === 'true';
    const shippingCost = hasPhysical ? 5.00 : 0;
    const total = (session.amount_total / 100);

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (order_number, stripe_checkout_session_id, stripe_payment_intent, customer_email, customer_name, shipping_address, subtotal, tax, shipping_cost, total, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'paid')
       RETURNING id`,
      [
        orderNumber,
        session.id,
        session.payment_intent,
        session.customer_details?.email || session.customer_email || '',
        session.customer_details?.name || '',
        session.shipping_details ? JSON.stringify(session.shipping_details) : null,
        subtotal,
        total - subtotal - shippingCost,
        shippingCost,
        total
      ]
    );
    const orderId = orderResult.rows[0].id;

    // Create order items and update inventory
    for (const item of items) {
      const product = productMap[item.product_id];
      const itemResult = await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, price, type)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [orderId, item.product_id, product.name, item.quantity, product.price, product.type]
      );

      // Update inventory for physical products
      if (product.type === 'physical') {
        await client.query(
          'UPDATE products SET inventory_quantity = inventory_quantity - $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );
      }

      // Generate download token for digital products
      if (product.type === 'digital' && product.digital_file_path) {
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours
        await client.query(
          `INSERT INTO download_tokens (token, order_id, order_item_id, product_id, downloads_remaining, expires_at)
           VALUES ($1, $2, $3, $4, 5, $5)`,
          [token, orderId, itemResult.rows[0].id, item.product_id, expiresAt]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`Order ${orderNumber} created successfully`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order creation error:', err);
  } finally {
    client.release();
  }
}

// ====================== Order Confirmation ======================
app.get('/api/orders/by-session/:sessionId', async (req, res) => {
  try {
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE stripe_checkout_session_id = $1',
      [req.params.sessionId]
    );
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }
    const order = orderResult.rows[0];
    const itemsResult = await pool.query(
      'SELECT oi.*, dt.token as download_token FROM order_items oi LEFT JOIN download_tokens dt ON dt.order_item_id = oi.id WHERE oi.order_id = $1',
      [order.id]
    );
    order.items = itemsResult.rows;
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ====================== Digital Downloads ======================
app.get('/api/download/:token', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT dt.*, p.digital_file_path, p.name as product_name
       FROM download_tokens dt
       JOIN products p ON p.id = dt.product_id
       WHERE dt.token = $1`,
      [req.params.token]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Download link not found' });
    }

    const token = result.rows[0];

    if (new Date() > new Date(token.expires_at)) {
      return res.status(410).json({ error: 'Download link has expired' });
    }
    if (token.downloads_remaining <= 0) {
      return res.status(410).json({ error: 'Download limit reached' });
    }

    // Decrement downloads remaining
    await pool.query(
      'UPDATE download_tokens SET downloads_remaining = downloads_remaining - 1 WHERE id = $1',
      [token.id]
    );

    const filePath = path.join(__dirname, token.digital_file_path);
    const filename = `${token.product_name}${path.extname(token.digital_file_path)}`;
    res.download(filePath, filename);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

// ====================== Custom Quotes ======================
app.post('/api/quotes', upload.single('file'), async (req, res) => {
  try {
    const { name, email, description } = req.body;
    if (!name || !email || !description) {
      return res.status(400).json({ error: 'Name, email, and description are required' });
    }

    const fileUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const result = await pool.query(
      'INSERT INTO custom_quotes (customer_name, customer_email, description, file_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, email, description, fileUrl]
    );
    res.status(201).json({ message: 'Quote request submitted successfully', id: result.rows[0].id });
  } catch (err) {
    console.error('Quote error:', err);
    res.status(500).json({ error: 'Failed to submit quote request' });
  }
});

// ====================== Admin: Products ======================
app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY sort_order ASC, created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/products', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, compare_at_price, type, sku, inventory_quantity, active, sort_order } = req.body;
    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required' });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO products (name, slug, description, price, compare_at_price, type, sku, inventory_quantity, image_url, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        name, slug, description || '', parseFloat(price),
        compare_at_price ? parseFloat(compare_at_price) : null,
        type || 'physical', sku || null,
        parseInt(inventory_quantity) || 0, imageUrl,
        active !== 'false', parseInt(sort_order) || 0
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Create product error:', err);
    res.status(500).json({ error: 'Failed to create product' });
  }
});

app.put('/api/admin/products/:id', adminAuth, upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, compare_at_price, type, sku, inventory_quantity, active, sort_order } = req.body;
    const productId = req.params.id;

    // Check if product exists
    const existing = await pool.query('SELECT * FROM products WHERE id = $1', [productId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const slug = name ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') : existing.rows[0].slug;
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : existing.rows[0].image_url;

    const result = await pool.query(
      `UPDATE products SET name=$1, slug=$2, description=$3, price=$4, compare_at_price=$5, type=$6, sku=$7, inventory_quantity=$8, image_url=$9, active=$10, sort_order=$11, updated_at=NOW()
       WHERE id=$12 RETURNING *`,
      [
        name || existing.rows[0].name, slug,
        description !== undefined ? description : existing.rows[0].description,
        price ? parseFloat(price) : existing.rows[0].price,
        compare_at_price ? parseFloat(compare_at_price) : (compare_at_price === '' ? null : existing.rows[0].compare_at_price),
        type || existing.rows[0].type,
        sku !== undefined ? (sku || null) : existing.rows[0].sku,
        inventory_quantity !== undefined ? parseInt(inventory_quantity) : existing.rows[0].inventory_quantity,
        imageUrl,
        active !== undefined ? active !== 'false' : existing.rows[0].active,
        sort_order !== undefined ? parseInt(sort_order) : existing.rows[0].sort_order,
        productId
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

app.post('/api/admin/products/:id/digital-file', adminAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filePath = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE products SET digital_file_path = $1 WHERE id = $2', [filePath, req.params.id]);
    res.json({ digital_file_path: filePath });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

app.delete('/api/admin/products/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM products WHERE id = $1', [req.params.id]);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

// ====================== Admin: Orders ======================
app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM orders';
    const params = [];
    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Order not found' });

    const order = orderResult.rows[0];
    const itemsResult = await pool.query(
      'SELECT oi.*, dt.token as download_token, dt.downloads_remaining, dt.expires_at FROM order_items oi LEFT JOIN download_tokens dt ON dt.order_item_id = oi.id WHERE oi.order_id = $1',
      [order.id]
    );
    order.items = itemsResult.rows;
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/orders/:id', adminAuth, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const result = await pool.query(
      'UPDATE orders SET status = COALESCE($1, status), notes = COALESCE($2, notes), updated_at = NOW() WHERE id = $3 RETURNING *',
      [status, notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update order' });
  }
});

// ====================== Admin: Quotes ======================
app.get('/api/admin/quotes', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM custom_quotes ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/quotes/:id', adminAuth, async (req, res) => {
  try {
    const { status, quoted_price, admin_notes } = req.body;
    const result = await pool.query(
      'UPDATE custom_quotes SET status = COALESCE($1, status), quoted_price = COALESCE($2, quoted_price), admin_notes = COALESCE($3, admin_notes), updated_at = NOW() WHERE id = $4 RETURNING *',
      [status, quoted_price, admin_notes, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Quote not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update quote' });
  }
});

// ====================== Admin: Analytics ======================
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  try {
    const [totalRevenue, orderCount, productCount, recentOrders, topProducts] = await Promise.all([
      pool.query("SELECT COALESCE(SUM(total), 0) as revenue FROM orders WHERE status IN ('paid', 'shipped', 'fulfilled')"),
      pool.query("SELECT COUNT(*) as count FROM orders WHERE status != 'pending'"),
      pool.query("SELECT COUNT(*) as count FROM products WHERE active = true"),
      pool.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 5"),
      pool.query(`
        SELECT p.name, SUM(oi.quantity) as total_sold, SUM(oi.price * oi.quantity) as revenue
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status IN ('paid', 'shipped', 'fulfilled')
        GROUP BY p.id, p.name
        ORDER BY total_sold DESC
        LIMIT 5
      `)
    ]);

    res.json({
      total_revenue: parseFloat(totalRevenue.rows[0].revenue),
      order_count: parseInt(orderCount.rows[0].count),
      product_count: parseInt(productCount.rows[0].count),
      recent_orders: recentOrders.rows,
      top_products: topProducts.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ====================== Stripe Config (public) ======================
app.get('/api/config', (req, res) => {
  res.json({
    stripe_publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || '',
    has_stripe: !!STRIPE_SECRET_KEY
  });
});

// ====================== SPA Catch-all ======================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ====================== Start Server ======================
initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🛒 Shop running on port ${PORT}`);
    if (!STRIPE_SECRET_KEY) {
      console.log('⚠️  Stripe is not configured - checkout will not work');
    }
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
