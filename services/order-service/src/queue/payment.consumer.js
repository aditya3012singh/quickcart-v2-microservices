const amqp = require("amqplib");
const { pool } = require("../db/pool");
const logger = require("../utils/logger");

async function startPaymentConsumer(retries = 20, delay = 3000) {
  while (retries > 0) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      const channel = await conn.createChannel();

      channel.on("error", (err) => logger.error({ event: "mq_channel_error", service: "order-service", error: err.message }));
      channel.on("close", () => logger.warn({ event: "mq_channel_closed", service: "order-service" }));

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

      logger.info({ event: "CONSUMER_STARTED", message: "Order Service listening for payment outcomes" });

      // ✅ Handle PAYMENT_SUCCESS
      channel.consume(SUCCESS_QUEUE, async (msg) => {
        if (!msg) return;

        try {
          const { orderId, correlationId, eventId } = JSON.parse(msg.content.toString());
          logger.info({ event: "PAYMENT_SUCCESS_RECEIVED", orderId, correlationId, eventId });

          const result = await pool.query(
            "UPDATE orders SET status = 'PAID' WHERE id = $1 AND status = 'CREATED' RETURNING *",
            [orderId]
          );

          if (result.rows.length === 0) {
            logger.warn({ event: "ORDER_STATUS_UPDATE_IGNORED", orderId, reason: "Invalid state or already processed", correlationId, eventId });
          } else {
            logger.info({ event: "ORDER_PAID", orderId, correlationId, eventId });
            
            // 🎯 End of Lifecycle Summary
            logger.info({ 
              event: "ORDER_FLOW_COMPLETED", 
              finalStatus: "PAID", 
              orderId, 
              correlationId, 
              eventId 
            });
          }

          channel.ack(msg);
        } catch (err) {
          logger.error({ event: "SUCCESS_CONSUMER_ERROR", error: err.message, correlationId });
          channel.nack(msg, false, true); 
        }
      });

      // ❌ Handle PAYMENT_FAILED
      channel.consume(FAILED_QUEUE, async (msg) => {
        if (!msg) return;

        try {
          const { orderId, correlationId, eventId } = JSON.parse(msg.content.toString());
          logger.info({ event: "PAYMENT_FAILED_RECEIVED", orderId, correlationId, eventId });

          const result = await pool.query(
            "UPDATE orders SET status = 'FAILED' WHERE id = $1 AND status = 'CREATED' RETURNING *",
            [orderId]
          );

          if (result.rows.length === 0) {
            logger.warn({ event: "ORDER_STATUS_UPDATE_IGNORED", orderId, reason: "Invalid state or already processed", correlationId, eventId });
          } else {
            logger.info({ event: "ORDER_FAILED", orderId, correlationId, eventId });

            // 🎯 End of Lifecycle Summary
            logger.info({ 
              event: "ORDER_FLOW_COMPLETED", 
              finalStatus: "FAILED", 
              orderId, 
              correlationId, 
              eventId 
            });
          }

          channel.ack(msg);
        } catch (err) {
          logger.error({ event: "FAILED_CONSUMER_ERROR", error: err.message, correlationId });
          channel.nack(msg, false, true);
        }
      });

      return;
    } catch (err) {
      logger.error({ event: "mq_connection_failed", service: "order-service", error: err.message });
      retries--;
      if (retries === 0) process.exit(1);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

module.exports = startPaymentConsumer;
