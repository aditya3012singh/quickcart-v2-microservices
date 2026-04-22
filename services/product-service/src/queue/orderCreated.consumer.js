const amqp = require("amqplib");
const { pool } = require("../db/pool");
const { releaseStock } = require("../services/product.service");
const logger = require("../utils/logger");

async function startConsumer(retries = 20, delay = 2000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      channel.on("error", (err) => logger.error({ event: "MQ_CHANNEL_ERROR", service: "product-service", error: err.message }));
      channel.on("close", () => logger.warn({ event: "MQ_CHANNEL_CLOSED", service: "product-service" }));

      // 1. DLX Setup
      await channel.assertExchange("order_dlx", "direct", { durable: true });

      // 2. EXCHANGE Setup (Saga Outcomes)
      const EXCHANGE_NAME = "payment_exchange";
      await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });

      // 3. Service-Specific Queues & Bindings
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

      logger.info({ event: "CONSUMER_STARTED", message: "Product Service listening for payment outcomes" });

      // 🔄 PAYMENT_SUCCESS -> Confirm Stock
      channel.consume(SUCCESS_QUEUE, async (msg) => {
        if (!msg) return;

        let client;
        try {
          const payload = JSON.parse(msg.content.toString());
          const { orderId, productId, quantity, correlationId: payloadId, eventId } = payload;
          
          const correlationId = msg.properties.headers?.["x-correlation-id"] || payloadId;
          const childLogger = logger.child({ correlationId });

          childLogger.info({ event: "PROCESSING_PAYMENT_SUCCESS", orderId, eventId });

          client = await pool.connect();
          await client.query("BEGIN");

          const idempotencyResult = await client.query(
            "INSERT INTO processed_orders (order_id) VALUES ($1) ON CONFLICT (order_id) DO NOTHING RETURNING *",
            [orderId]
          );

          if (idempotencyResult.rows.length === 0) {
            childLogger.warn({ event: "DUPLICATE_EVENT_IGNORED", orderId, eventId });
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
            childLogger.error({ event: "STOCK_CONFIRMATION_FAILED", orderId, eventId });
            await client.query("COMMIT");
            return channel.nack(msg, false, false);
          }

          childLogger.info({ event: "STOCK_CONFIRMED", orderId, eventId });
          await client.query("COMMIT");
          channel.ack(msg);
        } catch (err) {
          if (client) await client.query("ROLLBACK").catch(() => {});
          logger.error({ event: "PAYMENT_SUCCESS_PROCESSING_ERROR", error: err.message });
          channel.nack(msg, false, true);
        } finally {
          if (client) client.release();
        }
      });

      // 🔄 PAYMENT_FAILED -> Release Stock
      channel.consume(FAILED_QUEUE, async (msg) => {
        if (!msg) return;

        try {
          const payload = JSON.parse(msg.content.toString());
          const { orderId, productId, quantity, correlationId: payloadId, eventId } = payload;
          
          const correlationId = msg.properties.headers?.["x-correlation-id"] || payloadId;
          const childLogger = logger.child({ correlationId });

          childLogger.info({ event: "PROCESSING_PAYMENT_FAILED", orderId, eventId });
          
          await releaseStock(productId, quantity, orderId, correlationId, eventId);
          
          channel.ack(msg);
        } catch (err) {
          logger.error({ event: "PAYMENT_FAILED_PROCESSING_ERROR", error: err.message });
          channel.nack(msg, false, true); 
        }
      });

      return;
    } catch (err) {
      logger.error({ event: "MQ_CONNECTION_FAILED", service: "product-service", error: err.message });
      retries--;
      if (retries === 0) process.exit(1);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startConsumer;