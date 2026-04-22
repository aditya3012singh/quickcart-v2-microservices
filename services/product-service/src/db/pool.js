const { Pool } = require("pg");
const logger = require("../utils/logger");

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
      logger.info({ event: "DB_CONNECTED", message: "Connected to PostgreSQL" });
      return;
    } catch (err) {
      logger.error({ 
        event: "DB_CONNECTION_FAILED", 
        error: err.message,
        stack: err.stack 
      });

      retries--;

      if (retries === 0) {
        logger.error({ event: "DB_RETRIES_EXHAUSTED", message: "Exhausted all retries. Exiting..." });
        process.exit(1);
      }

      logger.info({ 
        event: "DB_CONNECTION_RETRY", 
        delaySeconds: delay / 1000, 
        retriesLeft: retries 
      });
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
    logger.info({ event: "DB_INITIALIZED", message: "Database tables initialized (processed_orders)" });
  } catch (err) {
    logger.error({ event: "DB_INITIALIZATION_FAILED", error: err.message });
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