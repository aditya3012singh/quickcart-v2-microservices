const amqp = require("amqplib");
const { pool } = require("../db/pool");

async function startConsumer(retries = 20, delay = 2000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      await channel.assertExchange("order_dlx", "direct", { durable: true });

      await channel.assertQueue("order_created_dlq", { durable: true });

      await channel.bindQueue("order_created_dlq", "order_dlx", "dlq");

      // ❗ Delete old queue to apply new x-dead-letter-exchange arguments
      await channel.deleteQueue("order_created");

      await channel.assertQueue("order_created", {
        durable: true,
        deadLetterExchange: "order_dlx",
        deadLetterRoutingKey: "dlq"
      });

      channel.prefetch(1);

      console.log("📦 Waiting for ORDER_CREATED events (with DLQ support)");

      channel.consume("order_created", async (msg) => {
        if (!msg) return;

        let data;
        try {
          data = JSON.parse(msg.content.toString());
        } catch (err) {
          console.error("❌ Invalid JSON in message. Removing from queue.");
          return channel.ack(msg); // Permanent failure: ACK to remove
        }

        const { orderId, productId, quantity, correlationId } = data;

        
        // Basic validation
        if (!orderId || !productId || !quantity || quantity <= 0) {
          console.log(`❌ Invalid message data for order ${orderId}. Skipping.`);
          return channel.ack(msg); // Permanent failure: ACK to remove
        }

        console.log(`📝 Processing order ${orderId} (correlation: ${correlationId})`);
        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          // 1. Transactional Idempotency Check
          // Using INSERT ... ON CONFLICT avoids race conditions and double-reading
          const idempotencyResult = await client.query(
            "INSERT INTO processed_orders (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING RETURNING *",
            [orderId]
          );

          if (idempotencyResult.rows.length === 0) {
            console.log(`⚠️ Duplicate event ignored for order ${orderId}.`);
            await client.query("ROLLBACK");
            return channel.ack(msg); // Successfully ignored: ACK to remove
          }

          // 2. Atomic Stock Update
          // Crucial: Decrement BOTH stock and reserved_stock
          // Condition ensures we never go below 0 and only deduct what was reserved
          const result = await client.query(
            `UPDATE products
           SET stock = stock - $1,
               reserved_stock = reserved_stock - $1
           WHERE id = $2 AND reserved_stock >= $1 AND stock >= $1
           RETURNING *`,
            [quantity, productId]
          );

          if (result.rows.length === 0) {
          // This happens if:
          // a) Product doesn't exist
          // b) Physical stock calculation would go negative
          // c) reserved_stock was smaller than requested
          console.error(`❌ Permanent failure: Stock confirmation failed for order ${orderId}.`);

          // We STILL commit the idempotency record so we don't process this failed order again
          await client.query("COMMIT");

          // ❗ Route to DLQ (nack with requeue=false)
          return channel.nack(msg, false, false);
        } else {
          console.log(`✅ Stock confirmed for order ${orderId}`);

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
        console.error(`❌ Temporary error processing order ${orderId}:`, err.message);

        // Transient errors (DB connectivity, Deadlocks) should be retried
        const isTransient = ["57P01", "57P03", "40P01", "ECONNREFUSED"].includes(err.code || err.errno);

        if (isTransient) {
          console.log(`⏳ Requeuing order ${orderId} for retry...`);
          channel.nack(msg, false, true); // Requeue
        } else {
          console.log(`❌ Permanent system error for order ${orderId}. Sending to DLQ.`);
          channel.nack(msg, false, false); // Route to DLQ
        }
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