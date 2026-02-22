const { encrypt, decrypt } = require('./encryption');

async function initAutobuyDb(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_profiles (
        id SERIAL PRIMARY KEY,
        retailer VARCHAR(100) NOT NULL DEFAULT 'samsung',
        email_encrypted TEXT,
        password_encrypted TEXT,
        shipping_name VARCHAR(255),
        shipping_address TEXT,
        shipping_city VARCHAR(100),
        shipping_state VARCHAR(50),
        shipping_zip VARCHAR(20),
        shipping_phone VARCHAR(30),
        payment_last4 VARCHAR(4),
        session_cookies TEXT,
        enabled BOOLEAN DEFAULT false,
        max_price INTEGER DEFAULT 3000,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_orders (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id),
        profile_id INTEGER REFERENCES autobuy_profiles(id),
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        order_number VARCHAR(255),
        price INTEGER DEFAULT 0,
        screenshot_path TEXT,
        error_message TEXT,
        dry_run BOOLEAN DEFAULT false,
        attempt INTEGER DEFAULT 1,
        restock_id VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_product_settings (
        id SERIAL PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE UNIQUE,
        profile_id INTEGER REFERENCES autobuy_profiles(id),
        enabled BOOLEAN DEFAULT false,
        max_price INTEGER DEFAULT 3000,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Global kill switch
    await client.query(`
      CREATE TABLE IF NOT EXISTS autobuy_config (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      INSERT INTO autobuy_config (key, value) VALUES ('kill_switch', 'false')
      ON CONFLICT (key) DO NOTHING
    `);
    console.log('Auto-buy database initialized');
  } finally {
    client.release();
  }
}

function encryptProfile(data) {
  return {
    ...data,
    email_encrypted: data.email ? encrypt(data.email) : null,
    password_encrypted: data.password ? encrypt(data.password) : null,
  };
}

function decryptProfile(row) {
  if (!row) return null;
  return {
    ...row,
    email: row.email_encrypted ? decrypt(row.email_encrypted) : null,
    password: row.password_encrypted ? decrypt(row.password_encrypted) : null,
  };
}

module.exports = { initAutobuyDb, encryptProfile, decryptProfile };
