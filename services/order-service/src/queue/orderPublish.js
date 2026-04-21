const amqp = require("amqplib");

let channel;

async function initPublisher(retries = 5, delay = 2000) {
  // while (retries > 0) {
  while (true) {
    try {
      const conn = await amqp.connect("amqp://rabbitmq");
      channel = await conn.createChannel();

      await channel.assertQueue("order_created", { durable: true });

      console.log("✅ RabbitMQ publisher ready");
      return;
    } catch (err) {
      console.error("❌ RabbitMQ connection failed:", err.message);

      retries--;

      // if (retries === 0) {
      //   console.error("❌ Exhausted all RabbitMQ retries. Exiting...");
      //   process.exit(1);
      // }

      console.log(`⏳ Retrying RabbitMQ in ${delay / 1000}s... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

function publishOrder(event) {
  if (!channel) {
    throw new Error("RabbitMQ not initialized");
  }

  channel.sendToQueue(
    "order_created",
    Buffer.from(JSON.stringify(event)),
    { persistent: true }
  );

  console.log("📤 ORDER_CREATED published:", event);
}

module.exports = { initPublisher, publishOrder };