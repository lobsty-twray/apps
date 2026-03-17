const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://lobsty:lobsty2026@localhost:5432/gear_inventory";

const pool = new Pool({ connectionString: DATABASE_URL });

// Setup uploads
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadDir));
app.use(express.json());

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS gear (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        brand TEXT,
        model TEXT,
        purchase_date DATE,
        purchase_price DECIMAL(10,2),
        warranty_until DATE,
        location TEXT,
        notes TEXT,
        image_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kits (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT DEFAULT '📦',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS kit_items (
        id SERIAL PRIMARY KEY,
        kit_id INTEGER REFERENCES kits(id) ON DELETE CASCADE,
        gear_id INTEGER REFERENCES gear(id) ON DELETE CASCADE,
        UNIQUE(kit_id, gear_id)
      )
    `);
    console.log("✅ Database initialized");
  } finally {
    client.release();
  }
}

// Get all gear
app.get("/api/gear", async (req, res) => {
  try {
    const { category } = req.query;
    let query = "SELECT * FROM gear";
    const params = [];
    if (category) {
      query += " WHERE category = $1";
      params.push(category);
    }
    query += " ORDER BY created_at DESC";
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add gear
app.post("/api/gear", upload.single("image"), async (req, res) => {
  try {
    const { name, category, brand, model, purchase_date, purchase_price, warranty_until, location, notes } = req.body;
    const image_url = req.file ? "/uploads/" + req.file.filename : null;
    
    const result = await pool.query(
      `INSERT INTO gear (name, category, brand, model, purchase_date, purchase_price, warranty_until, location, notes, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [name, category, brand || null, model || null, purchase_date || null, purchase_price || null, warranty_until || null, location || null, notes || null, image_url]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats endpoint
app.get("/api/gear/stats", async (req, res) => {
  try {
    const total = await pool.query("SELECT COUNT(*) as count, COALESCE(SUM(purchase_price::numeric),0) as value FROM gear");
    const byCat = await pool.query("SELECT category, COUNT(*) as count, COALESCE(SUM(purchase_price::numeric),0) as value FROM gear GROUP BY category ORDER BY value DESC");
    const recent = await pool.query("SELECT name, category, purchase_price, purchase_date FROM gear ORDER BY created_at DESC LIMIT 5");
    const expiring = await pool.query("SELECT name, warranty_until FROM gear WHERE warranty_until IS NOT NULL AND warranty_until > NOW() AND warranty_until < NOW() + interval '90 days' ORDER BY warranty_until");
    res.json({
      total_items: parseInt(total.rows[0].count),
      total_value: parseFloat(total.rows[0].value),
      by_category: byCat.rows,
      recent: recent.rows,
      expiring_warranty: expiring.rows
    });
  } catch(e) { res.status(500).json({error:"Failed"}); }
});

// Update gear
app.put("/api/gear/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, brand, model, purchase_date, purchase_price, warranty_until, location, notes } = req.body;
    let image_url = req.body.image_url;
    
    if (req.file) {
      image_url = "/uploads/" + req.file.filename;
    }
    
    const result = await pool.query(
      `UPDATE gear SET name=$1, category=$2, brand=$3, model=$4, purchase_date=$5, purchase_price=$6, warranty_until=$7, location=$8, notes=$9, image_url=$10
       WHERE id=$11 RETURNING *`,
      [name, category, brand, model, purchase_date, purchase_price, warranty_until, location, notes, image_url, id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete gear
app.delete("/api/gear/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const gear = await pool.query("SELECT image_url FROM gear WHERE id=$1", [id]);
    if (gear.rows[0]?.image_url) {
      const imagePath = path.join(__dirname, "public", gear.rows[0].image_url);
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    }
    await pool.query("DELETE FROM gear WHERE id=$1", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get categories
app.get("/api/categories", async (req, res) => {
  try {
    const result = await pool.query("SELECT DISTINCT category FROM gear ORDER BY category");
    res.json(result.rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== KITS API ==========

// List all kits with item count and total value
app.get("/api/kits", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT k.*, 
        COUNT(ki.id)::int as item_count,
        COALESCE(SUM(g.purchase_price::numeric), 0) as total_value,
        COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name, 'image_url', g.image_url, 'category', g.category)) FILTER (WHERE g.id IS NOT NULL), '[]') as items_preview
      FROM kits k
      LEFT JOIN kit_items ki ON ki.kit_id = k.id
      LEFT JOIN gear g ON g.id = ki.gear_id
      GROUP BY k.id
      ORDER BY k.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create kit
app.post("/api/kits", async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    const result = await pool.query(
      "INSERT INTO kits (name, description, icon) VALUES ($1, $2, $3) RETURNING *",
      [name, description || null, icon || '📦']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single kit with full gear items
app.get("/api/kits/:id", async (req, res) => {
  try {
    const kit = await pool.query("SELECT * FROM kits WHERE id = $1", [req.params.id]);
    if (!kit.rows.length) return res.status(404).json({ error: "Kit not found" });
    const items = await pool.query(`
      SELECT g.* FROM gear g
      JOIN kit_items ki ON ki.gear_id = g.id
      WHERE ki.kit_id = $1
      ORDER BY g.name
    `, [req.params.id]);
    res.json({ ...kit.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update kit
app.put("/api/kits/:id", async (req, res) => {
  try {
    const { name, description, icon } = req.body;
    const result = await pool.query(
      "UPDATE kits SET name=$1, description=$2, icon=$3 WHERE id=$4 RETURNING *",
      [name, description || null, icon || '📦', req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete kit
app.delete("/api/kits/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM kits WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add gear to kit
app.post("/api/kits/:id/items", async (req, res) => {
  try {
    const { gear_id } = req.body;
    await pool.query(
      "INSERT INTO kit_items (kit_id, gear_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [req.params.id, gear_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove gear from kit
app.delete("/api/kits/:id/items/:gear_id", async (req, res) => {
  try {
    await pool.query("DELETE FROM kit_items WHERE kit_id = $1 AND gear_id = $2", [req.params.id, req.params.gear_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`📸 Gear Inventory running on port ${PORT}`);
  });
});
