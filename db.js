const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
  connectionString: process.env.SUPABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const getDb = async () => {
  return {
    get: async (sql, params = []) => {
      const res = await pool.query(sql, params);
      return res.rows[0];
    },
    all: async (sql, params = []) => {
      const res = await pool.query(sql, params);
      return res.rows;
    },
    run: async (sql, params = []) => {
      await pool.query(sql, params);
    },
    exec: async (sql) => {
      await pool.query(sql);
    }
  };
};

async function initDb() {
  const db = await getDb();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  try {
    await db.exec(schema);
  } catch(err) {
    console.error("Schema execution error", err);
  }

  try {
    await db.run("ALTER TABLE system_control ADD COLUMN live_company_id INTEGER REFERENCES companies(id)");
  } catch (err) {}
  try { await db.run("ALTER TABLE system_control ADD COLUMN default_bidding_purse REAL DEFAULT 1000000.0"); } catch (err) {}
  try { await db.run("ALTER TABLE system_control ADD COLUMN default_allocation_purse REAL DEFAULT 2000000.0"); } catch (err) {}
  try { await db.run("ALTER TABLE teams ADD COLUMN allocation_purse REAL DEFAULT 0.0"); } catch (err) {}
  
  // Clean up legacy tables just in case they are clogging DB visually
  try { await db.run("DROP TABLE IF EXISTS company_results"); } catch (err) {}
  try { await db.run("DROP TABLE IF EXISTS scores"); } catch (err) {}

  console.log('Database initialized successfully.');
  
  const bcrypt = require('bcrypt');
  const adminExists = await db.get("SELECT * FROM users WHERE role = 'admin'");
  if (!adminExists) {
    const defaultPassword = 'admin';
    const hash = await bcrypt.hash(defaultPassword, 10);
    await db.run("INSERT INTO users (username, password, role) VALUES ($1, $2, $3)", ['admin', hash, 'admin']);
    console.log('Default admin created. Username: admin, Password: admin');
  }

  const controlExists = await db.get("SELECT * FROM system_control LIMIT 1");
  if (!controlExists) {
      await db.run("INSERT INTO system_control (id, current_phase) VALUES (1, 'closed')");
      console.log('System control defaults set (Phase: closed).');
  }
}

module.exports = {
  getDb,
  initDb,
  pool
};
