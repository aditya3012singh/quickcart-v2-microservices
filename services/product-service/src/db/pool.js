const { Pool } = require("pg");

const pool = new Pool({
  host: "product-db",
  user: "postgres",
  password: "postgres",
  database: "productdb",
  port: 5432,

  // ✅ Important configs
  max: 10, // max connections
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

async function connectWithRetry(retries = 5, delay = 2000) {
  while (retries > 0) {
    try {
      await pool.query("SELECT 1");
      console.log("✅ Connected to PostgreSQL");
      return;
    } catch (err) {
      console.error("❌ DB connection failed:", err.message);

      retries--;

      if (retries === 0) {
        console.error("❌ Exhausted all retries. Exiting...");
        process.exit(1);
      }

      console.log(`⏳ Retrying in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS processed_orders (
        order_id INT PRIMARY KEY
      )
    `);
    console.log("✅ Database tables initialized (processed_orders)");
  } catch (err) {
    console.error("❌ Database initialization failed:", err.message);
    throw err;
  }
}

module.exports = { pool, connectWithRetry, initDB };


// const pool = new Pool({
//   connectionString: process.env.DB_URL,
// });

// async function initDB() {
//   await pool.query(`
//     CREATE TABLE IF NOT EXISTS products (
//       id SERIAL PRIMARY KEY,
//       name TEXT,
//       price INT,
//       stock INT,
//       reserved_stock INT DEFAULT 0
//     )
//   `);
// }