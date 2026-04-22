const amqp = require("amqplib");
const logger = require("../utils/logger");

async function startPaymentConsumer() {
  const conn = await amqp.connect("amqp://rabbitmq");
  const channel = await conn.createChannel();

  channel.on("error", (err) => logger.error({ event: "mq_channel_error", service: "payment-service", error: err.message }));
  channel.on("close", () => logger.warn({ event: "mq_channel_closed", service: "payment-service" }));

  // 1. DLX Setup
  await channel.assertExchange("order_dlx", "direct", { durable: true });
  await channel.assertQueue("order_created_dlq", { durable: true });
  await channel.bindQueue("order_created_dlq", "order_dlx", "dlq");

  // 2. EXCHANGE Setup (Saga Outcomes)
  const EXCHANGE_NAME = "payment_exchange";
  await channel.assertExchange(EXCHANGE_NAME, "direct", { durable: true });

  // 3. Entry Queue (order_created)
  const entryQOptions = {
    durable: true,
    deadLetterExchange: "order_dlx",
    deadLetterRoutingKey: "dlq"
  };
  await channel.assertQueue("order_created", entryQOptions);

  channel.prefetch(1);

  logger.info({ event: "CONSUMER_STARTED", message: "Payment Service listening for ORDER_CREATED events" });

  channel.consume("order_created", async (msg) => {
    if (!msg) return;

    const start = Date.now();
    try {
      const event = JSON.parse(msg.content.toString());
      const { orderId, productId, quantity, correlationId, eventId } = event;

      logger.info({ 
        event: "PAYMENT_PROCESSING_STARTED", 
        orderId, 
        correlationId,
        eventId 
      });

      // 🔥 Simulate payment (80% success)
      const isSuccess = Math.random() < 0.8;
      const durationMs = Date.now() - start;

      const payload = { orderId, productId, quantity, correlationId, eventId };

      if (isSuccess) {
        logger.info({ 
          event: "PAYMENT_SUCCESS", 
          orderId, 
          correlationId, 
          eventId,
          durationMs 
        });
        channel.publish(
          EXCHANGE_NAME,
          "payment_success",
          Buffer.from(JSON.stringify(payload)),
          { persistent: true }
        );
      } else {
        logger.warn({ 
          event: "PAYMENT_FAILED", 
          orderId, 
          correlationId, 
          eventId,
          durationMs 
        });
        channel.publish(
          EXCHANGE_NAME,
          "payment_failed",
          Buffer.from(JSON.stringify(payload)),
          { persistent: true }
        );
      }

      channel.ack(msg);
    } catch (err) {
      logger.error({ event: "PAYMENT_PROCESSING_ERROR", error: err.message });
      channel.nack(msg, false, true); 
    }
  });
}

module.exports = startPaymentConsumer;