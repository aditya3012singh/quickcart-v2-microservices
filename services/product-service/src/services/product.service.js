const { pool } = require("../db/pool");
const logger = require("../utils/logger");
const { stockReserveSuccess, stockReserveFailed } = require("../utils/metrics");

async function reserveStock(productId, quantity) {
  if (!productId || quantity <= 0) {
    return { success: false, message: "Invalid input" };
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT stock, reserved_stock
       FROM products
       WHERE id=$1
       FOR UPDATE NOWAIT`,
      [productId]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      stockReserveFailed.inc();
      return { success: false, message: "Product not found" };
    }

    const { stock, reserved_stock } = result.rows[0];
    const available = stock - reserved_stock;

    if (available < quantity) {
      await client.query("ROLLBACK");
      stockReserveFailed.inc();
      return { success: false, message: "Insufficient stock" };
    }

    await client.query(
      `UPDATE products
       SET reserved_stock = reserved_stock + $1
       WHERE id=$2`,
      [quantity, productId]
    );

    await client.query("COMMIT");

    stockReserveSuccess.inc();
    return { success: true };

  } catch (err) {
    await client.query("ROLLBACK");
    stockReserveFailed.inc();

     if (err.code === "55P03") { // lock not available
        return { success: false, message: "Resource busy, try again" };
    }

    logger.error({ event: "reserve_stock_error", productId, error: err.message });

    return { success: false, message: "Internal error" };
  } finally {
    client.release();
  }
}

async function releaseStock(productId, quantity, orderId, correlationId, eventId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    logger.info({ 
      event: "RELEASING_STOCK", 
      orderId, 
      productId, 
      quantity, 
      correlationId, 
      eventId 
    });
    
    await client.query(
      `UPDATE products
       SET reserved_stock = reserved_stock - $1
       WHERE id = $2`,
      [quantity, productId]
    );

    await client.query("COMMIT");
    logger.info({ 
      event: "STOCK_RELEASED", 
      orderId, 
      productId, 
      quantity, 
      correlationId, 
      eventId 
    });

  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ 
      event: "RELEASE_STOCK_ERROR", 
      orderId, 
      productId, 
      error: err.message, 
      correlationId, 
      eventId 
    });
  } finally {
    client.release();
  }
}

module.exports = { reserveStock, releaseStock };