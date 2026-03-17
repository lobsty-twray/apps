const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new Database("/app/data/budget.db");

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize database tables
function initDatabase() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL CHECK(type IN ('income', 'expense', 'both')),
      color TEXT NOT NULL,
      icon TEXT NOT NULL,
      is_default BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
      amount REAL NOT NULL,
      category_id INTEGER NOT NULL,
      description TEXT,
      date TEXT NOT NULL,
      recurring BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id),
      UNIQUE(category_id, month, year)
    );

    CREATE TABLE IF NOT EXISTS savings_goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL DEFAULT 0,
      deadline TEXT,
      icon TEXT DEFAULT "🎯",
      color TEXT DEFAULT "#7c3aed",
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration: add recurring_frequency column
  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN recurring_frequency TEXT DEFAULT NULL`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Seed default categories
  const defaultCategories = [
    { name: "Housing", type: "expense", color: "#ff6b6b", icon: "🏠" },
    { name: "Food", type: "expense", color: "#4ecdc4", icon: "🍽️" },
    { name: "Transport", type: "expense", color: "#45b7d1", icon: "🚗" },
    { name: "Entertainment", type: "expense", color: "#f9ca24", icon: "🎬" },
    { name: "Shopping", type: "expense", color: "#f0932b", icon: "🛍️" },
    { name: "Subscriptions", type: "expense", color: "#eb4d4b", icon: "📱" },
    { name: "Health", type: "expense", color: "#6c5ce7", icon: "🏥" },
    { name: "Education", type: "expense", color: "#a29bfe", icon: "📚" },
    { name: "Travel", type: "expense", color: "#fd79a8", icon: "✈️" },
    { name: "Other", type: "both", color: "#636e72", icon: "📋" },
    { name: "Salary", type: "income", color: "#00b894", icon: "💰" },
    { name: "Freelance", type: "income", color: "#00cec9", icon: "💼" }
  ];

  const insertCategory = db.prepare(`
    INSERT OR IGNORE INTO categories (name, type, color, icon, is_default) 
    VALUES (?, ?, ?, ?, 1)
  `);

  for (const cat of defaultCategories) {
    insertCategory.run(cat.name, cat.type, cat.color, cat.icon);
  }
}

// API Routes

// Dashboard
app.get("/api/dashboard", (req, res) => {
  const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
  
  const income = db.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE type = 'income' AND strftime('%m', date) = ? AND strftime('%Y', date) = ?
  `).get(month.toString().padStart(2, "0"), year.toString()).total || 0;

  const expenses = db.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE type = 'expense' AND strftime('%m', date) = ? AND strftime('%Y', date) = ?
  `).get(month.toString().padStart(2, "0"), year.toString()).total || 0;

  const categoryBreakdown = db.prepare(`
    SELECT c.name, c.color, SUM(t.amount) as total 
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE t.type = 'expense' AND strftime('%m', t.date) = ? AND strftime('%Y', t.date) = ?
    GROUP BY c.id, c.name, c.color
    ORDER BY total DESC
  `).all(month.toString().padStart(2, "0"), year.toString());

  res.json({
    income,
    expenses,
    netSavings: income - expenses,
    categoryBreakdown
  });
});

// Transactions
app.get("/api/transactions", (req, res) => {
  let query = `
    SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE 1=1
  `;
  const params = [];

  if (req.query.month) {
    query += ` AND strftime('%m', t.date) = ?`;
    params.push(req.query.month.toString().padStart(2, "0"));
  }
  if (req.query.year) {
    query += ` AND strftime('%Y', t.date) = ?`;
    params.push(req.query.year.toString());
  }
  if (req.query.category) {
    query += ` AND t.category_id = ?`;
    params.push(req.query.category);
  }
  if (req.query.type) {
    query += ` AND t.type = ?`;
    params.push(req.query.type);
  }

  query += ` ORDER BY t.date DESC, t.created_at DESC`;

  const transactions = db.prepare(query).all(...params);
  res.json(transactions);
});

app.post("/api/transactions", (req, res) => {
  const { type, amount, category_id, description, date, recurring, recurring_frequency } = req.body;
  
  if (!type || !amount || !category_id || !date) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const stmt = db.prepare(`
    INSERT INTO transactions (type, amount, category_id, description, date, recurring, recurring_frequency)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(type, amount, category_id, description, date, recurring ? 1 : 0, recurring ? (recurring_frequency || 'monthly') : null);
  res.json({ id: result.lastInsertRowid, success: true });
});

app.put("/api/transactions/:id", (req, res) => {
  const { type, amount, category_id, description, date, recurring, recurring_frequency } = req.body;
  const stmt = db.prepare(`
    UPDATE transactions 
    SET type = ?, amount = ?, category_id = ?, description = ?, date = ?, recurring = ?, recurring_frequency = ?
    WHERE id = ?
  `);

  const result = stmt.run(type, amount, category_id, description, date, recurring ? 1 : 0, recurring ? (recurring_frequency || 'monthly') : null, req.params.id);
  res.json({ success: result.changes > 0 });
});

app.delete("/api/transactions/:id", (req, res) => {
  const stmt = db.prepare("DELETE FROM transactions WHERE id = ?");
  const result = stmt.run(req.params.id);
  res.json({ success: result.changes > 0 });
});

// Categories
app.get("/api/categories", (req, res) => {
  const categories = db.prepare("SELECT * FROM categories ORDER BY is_default DESC, name").all();
  res.json(categories);
});

app.post("/api/categories", (req, res) => {
  const { name, type, color, icon } = req.body;
  
  if (!name || !type || !color || !icon) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const stmt = db.prepare(`
    INSERT INTO categories (name, type, color, icon) 
    VALUES (?, ?, ?, ?)
  `);

  try {
    const result = stmt.run(name, type, color, icon);
    res.json({ id: result.lastInsertRowid, success: true });
  } catch (error) {
    res.status(400).json({ error: "Category already exists" });
  }
});

app.delete("/api/categories/:id", (req, res) => {
  // Don't allow deletion of default categories
  const category = db.prepare("SELECT is_default FROM categories WHERE id = ?").get(req.params.id);
  if (category && category.is_default) {
    return res.status(400).json({ error: "Cannot delete default category" });
  }

  const stmt = db.prepare("DELETE FROM categories WHERE id = ?");
  const result = stmt.run(req.params.id);
  res.json({ success: result.changes > 0 });
});

// Budgets
app.get("/api/budgets", (req, res) => {
  const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
  
  const budgets = db.prepare(`
    SELECT b.*, c.name as category_name, c.color as category_color,
           COALESCE(spent.total, 0) as spent
    FROM budgets b
    JOIN categories c ON b.category_id = c.id
    LEFT JOIN (
      SELECT category_id, SUM(amount) as total
      FROM transactions 
      WHERE type = 'expense' AND strftime('%m', date) = ? AND strftime('%Y', date) = ?
      GROUP BY category_id
    ) spent ON b.category_id = spent.category_id
    WHERE b.month = ? AND b.year = ?
  `).all(month.toString().padStart(2, "0"), year.toString(), month, year);

  res.json(budgets);
});

app.post("/api/budgets", (req, res) => {
  const { category_id, amount, month, year } = req.body;
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO budgets (category_id, amount, month, year)
    VALUES (?, ?, ?, ?)
  `);

  const result = stmt.run(category_id, amount, month, year);
  res.json({ id: result.lastInsertRowid, success: true });
});

app.delete("/api/budgets/:id", (req, res) => {
  const stmt = db.prepare("DELETE FROM budgets WHERE id = ?");
  const result = stmt.run(req.params.id);
  res.json({ success: result.changes > 0 });
});

// Trends
app.get("/api/trends", (req, res) => {
  const { months = 6 } = req.query;
  
  const trends = db.prepare(`
    SELECT 
      strftime('%Y-%m', date) as month,
      SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END) as expenses
    FROM transactions
    WHERE date >= date('now', '-' || ? || ' months')
    GROUP BY strftime('%Y-%m', date)
    ORDER BY month
  `).all(months);

  res.json(trends);
});

// CSV Export
app.get("/api/transactions/export", (req, res) => {
  let query = `
    SELECT t.date, t.description, t.amount, c.name as category, t.type, t.recurring, t.recurring_frequency
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (req.query.month) {
    const [year, month] = req.query.month.split("-");
    query += ` AND strftime('%Y', t.date) = ? AND strftime('%m', t.date) = ?`;
    params.push(year, month);
  }
  query += ` ORDER BY t.date DESC`;
  const rows = db.prepare(query).all(...params);
  let csv = "date,description,amount,category,type,recurring,recurring_frequency\n";
  for (const r of rows) {
    const desc = (r.description || "").replace(/"/g, '""');
    csv += `${r.date},"${desc}",${r.amount},${r.category},${r.type},${r.recurring ? "yes" : "no"},${r.recurring_frequency || ""}\n`;
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="budget-export.csv"`);
  res.send(csv);
});

// Monthly Summary
app.get("/api/summary", (req, res) => {
  const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
  const m = month.toString().padStart(2, "0");
  const y = year.toString();
  const income = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='income' AND strftime('%m',date)=? AND strftime('%Y',date)=?`).get(m, y).total;
  const expenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='expense' AND strftime('%m',date)=? AND strftime('%Y',date)=?`).get(m, y).total;
  const topCat = db.prepare(`SELECT c.name, SUM(t.amount) as total FROM transactions t JOIN categories c ON t.category_id=c.id WHERE t.type='expense' AND strftime('%m',t.date)=? AND strftime('%Y',t.date)=? GROUP BY c.id ORDER BY total DESC LIMIT 1`).get(m, y);
  let prevM = parseInt(month) - 1;
  let prevY = parseInt(year);
  if (prevM < 1) { prevM = 12; prevY--; }
  const pm = prevM.toString().padStart(2, "0");
  const py = prevY.toString();
  const prevExpenses = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='expense' AND strftime('%m',date)=? AND strftime('%Y',date)=?`).get(pm, py).total;
  let pctChange = 0;
  if (prevExpenses > 0) pctChange = ((expenses - prevExpenses) / prevExpenses * 100);
  res.json({ income, expenses, netSavings: income - expenses, topCategory: topCat ? topCat.name : "N/A", topCategoryAmount: topCat ? topCat.total : 0, prevExpenses, pctChange: Math.round(pctChange * 10) / 10 });
});

// Recurring transactions
app.get("/api/transactions/recurring", (req, res) => {
  const transactions = db.prepare(`
    SELECT t.*, c.name as category_name, c.color as category_color, c.icon as category_icon
    FROM transactions t
    JOIN categories c ON t.category_id = c.id
    WHERE t.recurring = 1
    ORDER BY t.date DESC
  `).all();
  res.json(transactions);
});

app.get("/api/transactions/recurring/status", (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const m = month.toString().padStart(2, "0");
  const y = year.toString();
  const recurring = db.prepare("SELECT * FROM transactions WHERE recurring = 1").all();
  let pending = 0;
  for (const tx of recurring) {
    const freq = tx.recurring_frequency || 'monthly';
    
    // For yearly: only pending if original month matches target month
    if (freq === 'yearly') {
      const origMonth = new Date(tx.date).getMonth() + 1;
      if (origMonth !== month) continue;
    }
    
    if (freq === 'weekly') {
      // Check if 4 weekly transactions exist
      const count = db.prepare(`
        SELECT COUNT(*) as cnt FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y).cnt;
      if (count < 4) pending++;
    } else if (freq === 'biweekly') {
      const count = db.prepare(`
        SELECT COUNT(*) as cnt FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y).cnt;
      if (count < 2) pending++;
    } else {
      // monthly or yearly (single)
      const exists = db.prepare(`
        SELECT 1 FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y);
      if (!exists) pending++;
    }
  }
  res.json({ pending, month, year });
});

app.post("/api/transactions/generate-recurring", (req, res) => {
  const month = parseInt(req.query.month) || new Date().getMonth() + 1;
  const year = parseInt(req.query.year) || new Date().getFullYear();
  const m = month.toString().padStart(2, "0");
  const y = year.toString();
  const recurring = db.prepare("SELECT * FROM transactions WHERE recurring = 1").all();
  let generated = 0, skipped = 0;
  const insert = db.prepare(`
    INSERT INTO transactions (type, amount, category_id, description, date, recurring)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  
  for (const tx of recurring) {
    const freq = tx.recurring_frequency || 'monthly';
    const maxDay = new Date(year, month, 0).getDate();
    
    if (freq === 'yearly') {
      const origMonth = new Date(tx.date).getMonth() + 1;
      if (origMonth !== month) { skipped++; continue; }
      // Same as monthly — generate one
      const exists = db.prepare(`
        SELECT 1 FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y);
      if (exists) { skipped++; continue; }
      const origDay = new Date(tx.date).getDate();
      const day = Math.min(origDay, maxDay);
      insert.run(tx.type, tx.amount, tx.category_id, tx.description, `${y}-${m}-${day.toString().padStart(2, "0")}`);
      generated++;
    } else if (freq === 'weekly') {
      // Generate 4 transactions for each week
      const existingCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y).cnt;
      if (existingCount >= 4) { skipped++; continue; }
      const needed = 4 - existingCount;
      // Place on days 1, 8, 15, 22
      const weekDays = [1, 8, 15, 22];
      let added = 0;
      for (const d of weekDays) {
        if (added >= needed) break;
        if (d > maxDay) break;
        const dateStr = `${y}-${m}-${d.toString().padStart(2, "0")}`;
        // Check this exact date doesn't already exist
        const dup = db.prepare(`
          SELECT 1 FROM transactions
          WHERE category_id = ? AND amount = ? AND type = ? AND description = ? AND date = ? AND recurring = 0
        `).get(tx.category_id, tx.amount, tx.type, tx.description, dateStr);
        if (dup) continue;
        insert.run(tx.type, tx.amount, tx.category_id, tx.description, dateStr);
        generated++;
        added++;
      }
    } else if (freq === 'biweekly') {
      // Generate 2 transactions on 1st and 15th
      const existingCount = db.prepare(`
        SELECT COUNT(*) as cnt FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y).cnt;
      if (existingCount >= 2) { skipped++; continue; }
      const biDays = [1, 15];
      for (const d of biDays) {
        const dateStr = `${y}-${m}-${d.toString().padStart(2, "0")}`;
        const dup = db.prepare(`
          SELECT 1 FROM transactions
          WHERE category_id = ? AND amount = ? AND type = ? AND description = ? AND date = ? AND recurring = 0
        `).get(tx.category_id, tx.amount, tx.type, tx.description, dateStr);
        if (dup) continue;
        insert.run(tx.type, tx.amount, tx.category_id, tx.description, dateStr);
        generated++;
      }
    } else {
      // monthly (default)
      const exists = db.prepare(`
        SELECT 1 FROM transactions
        WHERE category_id = ? AND amount = ? AND type = ? AND description = ?
        AND strftime('%m', date) = ? AND strftime('%Y', date) = ? AND recurring = 0
      `).get(tx.category_id, tx.amount, tx.type, tx.description, m, y);
      if (exists) { skipped++; continue; }
      const origDay = new Date(tx.date).getDate();
      const day = Math.min(origDay, maxDay);
      insert.run(tx.type, tx.amount, tx.category_id, tx.description, `${y}-${m}-${day.toString().padStart(2, "0")}`);
      generated++;
    }
  }
  res.json({ generated, skipped });
});


// ─── Savings Goals ───
app.get("/api/savings-goals/summary", (req, res) => {
  const summary = db.prepare(`
    SELECT 
      COALESCE(SUM(current_amount), 0) as total_saved,
      COALESCE(SUM(target_amount), 0) as total_target,
      COUNT(*) as goal_count
    FROM savings_goals
  `).get();
  summary.progress = summary.total_target > 0 ? Math.round((summary.total_saved / summary.total_target) * 1000) / 10 : 0;
  res.json(summary);
});

app.get("/api/savings-goals", (req, res) => {
  const goals = db.prepare("SELECT * FROM savings_goals ORDER BY created_at DESC").all();
  const result = goals.map(g => ({
    ...g,
    progress: g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 1000) / 10 : 0
  }));
  res.json(result);
});

app.post("/api/savings-goals", (req, res) => {
  const { name, target_amount, icon, color, deadline } = req.body;
  if (!name || !target_amount) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const stmt = db.prepare(`
    INSERT INTO savings_goals (name, target_amount, icon, color, deadline)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(name, target_amount, icon || '🎯', color || '#7c3aed', deadline || null);
  res.json({ id: result.lastInsertRowid, success: true });
});

app.put("/api/savings-goals/:id", (req, res) => {
  const { name, target_amount, icon, color, deadline } = req.body;
  const stmt = db.prepare(`
    UPDATE savings_goals SET name = ?, target_amount = ?, icon = ?, color = ?, deadline = ?
    WHERE id = ?
  `);
  const result = stmt.run(name, target_amount, icon, color, deadline || null, req.params.id);
  res.json({ success: result.changes > 0 });
});

app.delete("/api/savings-goals/:id", (req, res) => {
  const stmt = db.prepare("DELETE FROM savings_goals WHERE id = ?");
  const result = stmt.run(req.params.id);
  res.json({ success: result.changes > 0 });
});

app.post("/api/savings-goals/:id/contribute", (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }
  const stmt = db.prepare("UPDATE savings_goals SET current_amount = current_amount + ? WHERE id = ?");
  const result = stmt.run(amount, req.params.id);
  if (result.changes > 0) {
    const goal = db.prepare("SELECT * FROM savings_goals WHERE id = ?").get(req.params.id);
    goal.progress = goal.target_amount > 0 ? Math.round((goal.current_amount / goal.target_amount) * 1000) / 10 : 0;
    res.json({ success: true, goal });
  } else {
    res.status(404).json({ error: "Goal not found" });
  }
});

// Serve frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Initialize database and start server
initDatabase();

app.listen(PORT, () => {
  console.log(`Lobsty Budget server running on port ${PORT}`);
});
