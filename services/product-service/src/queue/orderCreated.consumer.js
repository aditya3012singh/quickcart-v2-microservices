const amqp = require("amqplib");
const { pool } = require("../db/pool");
const { releaseStock } = require("../services/product.service");

async function startConsumer(retries = 20, delay = 2000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      // Better error handling
      channel.on("error", (err) => console.error("❌ RabbitMQ Channel Error:", err.message));
      channel.on("close", () => console.log("⚠️ RabbitMQ Channel Closed"));

      // 1. DLX Setup
      await channel.assertExchange("order_dlx", "direct", { durable: true });
      await channel.assertQueue("product_error_dlq", { durable: true });
      await channel.bindQueue("product_error_dlq", "order_dlx", "dlq");

      // 2. Shared Queues (Matching payment-service schema exactly)
      const qOptions = {
        durable: true,
        deadLetterExchange: "order_dlx",
        deadLetterRoutingKey: "dlq"
      };

      await channel.assertQueue("payment_success", qOptions);
      await channel.assertQueue("payment_failed", qOptions);

      channel.prefetch(1);

      console.log("📦 Product Service listening for PAYMENT_SUCCESS and PAYMENT_FAILED");

      // 🔄 PAYMENT_SUCCESS -> Confirm Stock
      channel.consume("payment_success", async (msg) => {
        if (!msg) return;

        let client;
        try {
          const { orderId, productId, quantity } = JSON.parse(msg.content.toString());
          console.log(`✅ [PAYMENT_SUCCESS] Finalizing stock for order ${orderId}`);

          client = await pool.connect();
          await client.query("BEGIN");

          // Transactional Idempotency Check
          const idempotencyResult = await client.query(
            "INSERT INTO processed_orders (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING RETURNING *",
            [orderId]
          );

          if (idempotencyResult.rows.length === 0) {
            console.log(`⚠️ Duplicate event ignored for order ${orderId}.`);
            await client.query("ROLLBACK");
            return channel.ack(msg);
          }

          // Atomic Stock Update
          const result = await client.query(
            `UPDATE products
             SET stock = stock - $1,
                 reserved_stock = reserved_stock - $1
             WHERE id = $2 AND reserved_stock >= $1 AND stock >= $1
             RETURNING *`,
            [quantity, productId]
          );

          if (result.rows.length === 0) {
            console.error(`❌ ERROR: Stock confirmation failed for order ${orderId}.`);
            await client.query("COMMIT");
            return channel.nack(msg, false, false);
          }

          console.log(`🎉 Stock confirmed permanently for order ${orderId}`);
          await client.query("COMMIT");
          channel.ack(msg);
        } catch (err) {
          if (client) await client.query("ROLLBACK").catch(() => {});
          console.error(`❌ Error processing payment_success:`, err.message);
          channel.nack(msg, false, true);
        } finally {
          if (client) client.release();
        }
      });

      // 🔄 PAYMENT_FAILED -> Release Stock (Compensation)
      channel.consume("payment_failed", async (msg) => {
        if (!msg) return;

        try {
          const { orderId, productId, quantity } = JSON.parse(msg.content.toString());
          console.log(`🔄 [PAYMENT_FAILED] Compensation: Releasing stock for order ${orderId}`);
          await releaseStock(productId, quantity);
          channel.ack(msg);
        } catch (err) {
          console.error("❌ Error processing payment_failed:", err.message);
          channel.nack(msg, false, true); 
        }
      });

      return;
    } catch (err) {
      console.error("❌ RabbitMQ connection failed:", err.message);
      retries--;
      if (retries === 0) process.exit(1);
      console.log(`⏳ Retrying RabbitMQ in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startConsumer;