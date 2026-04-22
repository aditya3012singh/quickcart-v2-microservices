const amqp = require("amqplib");
const { pool } = require("../db/pool");

async function startPaymentConsumer(retries = 20, delay = 3000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      channel.on("error", (err) => console.error("❌ RabbitMQ Channel Error (Order Service):", err.message));
      channel.on("close", () => console.log("⚠️ RabbitMQ Channel Closed (Order Service)"));

      // 1. DLX Setup
      await channel.assertExchange("order_dlx", "direct", { durable: true });

      // 2. EXCHANGE Setup (Saga Outcomes)
      const EXCHANGE_NAME = "payment_exchange";
      await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });

      // 3. Service-Specific Queues & Bindings
      const SUCCESS_QUEUE = "order_payment_success_queue";
      const FAILED_QUEUE = "order_payment_failed_queue";

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

      console.log("📩 Order Service listening for payment_success and payment_failed (Pub-Sub)");

      // ✅ Handle PAYMENT_SUCCESS
      channel.consume(SUCCESS_QUEUE, async (msg) => {
        if (!msg) return;

        try {
          const { orderId } = JSON.parse(msg.content.toString());
          console.log(`💰 [PAYMENT_SUCCESS] Processing order ${orderId}`);

          const result = await pool.query(
            "UPDATE orders SET status = 'PAID' WHERE id = $1 AND status = 'CREATED' RETURNING *",
            [orderId]
          );

          if (result.rows.length === 0) {
            console.log(`⚠️ Order ${orderId} status update ignored (Already processed or invalid state)`);
          } else {
            console.log(`✅ Order ${orderId} marked as PAID`);
          }

          channel.ack(msg);
        } catch (err) {
          console.error("❌ Error updating order to PAID:", err.message);
          channel.nack(msg, false, true); 
        }
      });

      // ❌ Handle PAYMENT_FAILED
      channel.consume(FAILED_QUEUE, async (msg) => {
        if (!msg) return;

        try {
          const { orderId } = JSON.parse(msg.content.toString());
          console.log(`❌ [PAYMENT_FAILED] Processing order ${orderId}`);

          const result = await pool.query(
            "UPDATE orders SET status = 'FAILED' WHERE id = $1 AND status = 'CREATED' RETURNING *",
            [orderId]
          );

          if (result.rows.length === 0) {
            console.log(`⚠️ Order ${orderId} status update ignored (Already processed or invalid state)`);
          } else {
            console.log(`⚠️ Order ${orderId} marked as FAILED`);
          }

          channel.ack(msg);
        } catch (err) {
          console.error("❌ Error updating order to FAILED:", err.message);
          channel.nack(msg, false, true);
        }
      });

      return;
    } catch (err) {
      console.error("❌ RabbitMQ connection failed (Order Service):", err.message);
      retries--;
      if (retries === 0) process.exit(1);
      console.log(`⏳ Retrying RabbitMQ in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startPaymentConsumer;
