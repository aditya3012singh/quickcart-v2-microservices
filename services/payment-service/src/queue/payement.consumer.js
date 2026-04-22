const amqp = require("amqplib");

async function startPaymentConsumer() {
  const conn = await amqp.connect("amqp://rabbitmq");
  const channel = await conn.createChannel();

  // Better error handling
  channel.on("error", (err) => console.error("❌ RabbitMQ Channel Error:", err.message));
  channel.on("close", () => console.log("⚠️ RabbitMQ Channel Closed"));

  // 1. DLX Setup (Must match other services)
  await channel.assertExchange("order_dlx", "direct", { durable: true });
  await channel.assertQueue("order_created_dlq", { durable: true });
  await channel.bindQueue("order_created_dlq", "order_dlx", "dlq");

  // 2. Shared Queue Setup (Must match product-service EXACTLY)
  const qOptions = {
    durable: true,
    deadLetterExchange: "order_dlx",
    deadLetterRoutingKey: "dlq"
  };

  await channel.assertQueue("order_created", qOptions);
  await channel.assertQueue("payment_success", qOptions);
  await channel.assertQueue("payment_failed", qOptions);

  channel.prefetch(1);

  console.log("💳 Payment Service listening for ORDER_CREATED (Saga Orchestrator)");

  channel.consume("order_created", async (msg) => {
    if (!msg) return;

    try {
      const event = JSON.parse(msg.content.toString());
      const { orderId, productId, quantity } = event;

      console.log(`💰 Processing payment for order ${orderId}`);

      // 🔥 Simulate payment (80% success)
      const isSuccess = Math.random() < 0.8;

      if (isSuccess) {
        console.log(`✅ Payment SUCCESS for order ${orderId}`);
        channel.sendToQueue(
          "payment_success",
          Buffer.from(JSON.stringify({ orderId, productId, quantity })),
          { persistent: true }
        );
      } else {
        console.log(`❌ Payment FAILED for order ${orderId}`);
        channel.sendToQueue(
          "payment_failed",
          Buffer.from(JSON.stringify({ orderId, productId, quantity })),
          { persistent: true }
        );
      }

      channel.ack(msg);
    } catch (err) {
      console.error("❌ Payment processing error:", err.message);
      channel.nack(msg, false, true); 
    }
  });
}

module.exports = startPaymentConsumer;