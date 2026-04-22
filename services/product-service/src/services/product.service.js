const { pool } = require("../db/pool");

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
      return { success: false, message: "Product not found" };
    }

    const { stock, reserved_stock } = result.rows[0];
    const available = stock - reserved_stock;

    if (available < quantity) {
      await client.query("ROLLBACK");
      return { success: false, message: "Insufficient stock" };
    }

    await client.query(
      `UPDATE products
       SET reserved_stock = reserved_stock + $1
       WHERE id=$2`,
      [quantity, productId]
    );

    await client.query("COMMIT");

    return { success: true };

  } catch (err) {
    await client.query("ROLLBACK");

     if (err.code === "55P03") { // lock not available
        return { success: false, message: "Resource busy, try again" };
    }

    console.error("❌ reserveStock error:", err);

    return { success: false, message: "Internal error" };
  } finally {
    client.release();
  }
}

async function releaseStock(productId, quantity) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    console.log(`🔄 Releasing ${quantity} unit(s) of reserved stock for product ${productId}`);
    
    await client.query(
      `UPDATE products
       SET reserved_stock = reserved_stock - $1
       WHERE id = $2`,
      [quantity, productId]
    );

    await client.query("COMMIT");
    console.log(`✅ Stock released successfully for product ${productId}`);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ releaseStock error:", err.message);
  } finally {
    client.release();
  }
}

module.exports = { reserveStock, releaseStock };