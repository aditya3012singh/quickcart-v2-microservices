const amqp = require("amqplib");
const { pool } = require("../db/pool");
const { releaseStock } = require("../services/product.service");

async function startConsumer(retries = 20, delay = 2000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      channel.on("error", (err) => console.error("❌ RabbitMQ Channel Error (Product Service):", err.message));
      channel.on("close", () => console.log("⚠️ RabbitMQ Channel Closed (Product Service)"));

      // 1. DLX Setup
      await channel.assertExchange("order_dlx", "direct", { durable: true });

      // 2. EXCHANGE Setup (Saga Outcomes)
      const EXCHANGE_NAME = "payment_exchange";
      await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });

      // 3. Service-Specific Queues & Bindings
      // We use unique queue names so each service gets its own copy of the message
      const SUCCESS_QUEUE = "product_payment_success_queue";
      const FAILED_QUEUE = "product_payment_failed_queue";

      const qOptions = {
        durable: true,
        deadLetterExchange: "order_dlx",
        deadLetterRoutingKey: "dlq"
      };

      await channel.assertQueue(SUCCESS_QUEUE, qOptions);
      await channel.bindQueue(SUCCESS_QUEUE, EXCHANGE_NAME, "payment_success");

      await channel.assertQueue(FAILED_QUEUE, qOptions);
      await channel.bindQueue(FAILED_QUEUE, EXCHANGE_NAME, "payment_failed");

      channel.prefetch(1);

      console.log("📦 Product Service listening for PAYMENT_SUCCESS and PAYMENT_FAILED (Pub-Sub)");

      // 🔄 PAYMENT_SUCCESS -> Confirm Stock
      channel.consume(SUCCESS_QUEUE, async (msg) => {
        if (!msg) return;

        let client;
        try {
          const { orderId, productId, quantity } = JSON.parse(msg.content.toString());
          console.log(`✅ [PAYMENT_SUCCESS] Finalizing stock for order ${orderId}`);

          client = await pool.connect();
          await client.query("BEGIN");

          const idempotencyResult = await client.query(
            "INSERT INTO processed_orders (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING RETURNING *",
            [orderId]
          );

          if (idempotencyResult.rows.length === 0) {
            console.log(`⚠️ Duplicate event ignored for order ${orderId}.`);
            await client.query("ROLLBACK");
            return channel.ack(msg);
          }

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

      // 🔄 PAYMENT_FAILED -> Release Stock
      channel.consume(FAILED_QUEUE, async (msg) => {
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
      console.error("❌ RabbitMQ connection failed (Product Service):", err.message);
      retries--;
      if (retries === 0) process.exit(1);
      console.log(`⏳ Retrying RabbitMQ in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startConsumer;