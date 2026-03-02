const express = require("express");
const { Pool } = require("pg");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://lobsty:***REMOVED***@localhost:5432/gear_inventory";

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

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`📸 Gear Inventory running on port ${PORT}`);
  });
});
