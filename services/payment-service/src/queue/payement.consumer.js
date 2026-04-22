const amqp = require("amqplib");
const logger = require("../utils/logger");
const { paymentSuccess, paymentFailed } = require("../utils/metrics");

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
      const { orderId, productId, quantity, correlationId: payloadId, eventId } = event;
      
      // 🔥 Extract from headers or fallback to payload
      const correlationId = msg.properties.headers?.["x-correlation-id"] || payloadId;
      const childLogger = logger.child({ correlationId });

      childLogger.info({ 
        event: "PAYMENT_PROCESSING_STARTED", 
        orderId, 
        eventId 
      });

      // 🔥 Simulate payment (80% success)
      const isSuccess = Math.random() < 0.8;
      const durationMs = Date.now() - start;

      const payload = { orderId, productId, quantity, correlationId, eventId };

      if (isSuccess) {
        // 🔥 Metrics: Inc success
        paymentSuccess.inc();

        childLogger.info({ 
          event: "PAYMENT_SUCCESS", 
          orderId, 
          eventId,
          durationMs 
        });
        channel.publish(
          EXCHANGE_NAME,
          "payment_success",
          Buffer.from(JSON.stringify(payload)),
          { 
            persistent: true,
            headers: { "x-correlation-id": correlationId }
          }
        );
      } else {
        // 🔥 Metrics: Inc failure
        paymentFailed.inc();

        childLogger.warn({ 
          event: "PAYMENT_FAILED", 
          orderId, 
          eventId,
          durationMs 
        });
        channel.publish(
          EXCHANGE_NAME,
          "payment_failed",
          Buffer.from(JSON.stringify(payload)),
          { 
            persistent: true,
            headers: { "x-correlation-id": correlationId }
          }
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