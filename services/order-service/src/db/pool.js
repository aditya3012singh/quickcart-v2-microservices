const { Pool } = require("pg");
const logger = require("../utils/logger");

const pool = new Pool({
  host: "order-db",
  user: "postgres",
  password: "postgres",
  database: "orderdb",
  port: 5432,
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

module.exports = { pool, connectWithRetry };