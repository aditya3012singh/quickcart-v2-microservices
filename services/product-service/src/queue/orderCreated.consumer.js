const amqp = require("amqplib");
const { pool } = require("../db/pool");

async function startConsumer(retries = 20, delay = 2000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      await channel.assertQueue("order_created", { durable: true });

      channel.prefetch(1);

      console.log("📦 Waiting for ORDER_CREATED events");

      channel.consume("order_created", async (msg) => {
    if (!msg) return;

    let data;
    try {
      data = JSON.parse(msg.content.toString());
    } catch (err) {
      console.error("❌ Invalid JSON in message:", err.message);
      channel.ack(msg);
      return;
    }

    const { orderId, productId, quantity, correlationId } = data;

    if (!orderId || !productId || quantity <= 0) {
      console.log("❌ Invalid message");

      channel.ack(msg);
      return;
    }

    console.log(`📝 Processing order ${orderId} (correlation: ${correlationId})`);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(
        `UPDATE products
         SET stock = stock - $1,
             reserved_stock = reserved_stock - $1
         WHERE id = $2 AND reserved_stock >= $1 AND stock >= $1
         RETURNING *`,
        [quantity, productId]
      );

      if (result.rows.length === 0) {
        console.log("❌ Stock confirmation failed");

        channel.sendToQueue(
          "stock_failed",
          Buffer.from(JSON.stringify({ orderId, correlationId })),
          { persistent: true }
        );

        await client.query("ROLLBACK");
      } else {
        console.log("✅ Stock confirmed");

        channel.sendToQueue(
          "stock_confirmed",
          Buffer.from(JSON.stringify({ orderId, correlationId })),
          { persistent: true }
        );

        await client.query("COMMIT");
      }

      channel.ack(msg);

    } catch (err) {
      await client.query("ROLLBACK");
      console.error("❌ Processing error:", err);

      channel.nack(msg, false, true);
    } finally {
      client.release();
    }
  });

      // If we get here, connection is established, so return
      return;
    } catch (err) {
      console.error("❌ RabbitMQ connection failed:", err.message);

      retries--;

      if (retries === 0) {
        console.error("❌ Exhausted all RabbitMQ retries. Exiting...");
        process.exit(1);
      }

      console.log(`⏳ Retrying RabbitMQ in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startConsumer;