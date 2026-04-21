const { Pool } = require("pg");

const pool = new Pool({
  host: "order-db",
  user: "postgres",
  password: "postgres",
  database: "orderdb",
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

module.exports = { pool, connectWithRetry };