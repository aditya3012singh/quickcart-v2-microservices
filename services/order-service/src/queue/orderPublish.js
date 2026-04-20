const amqp = require("amqplib");

let channel;

async function initPublisher() {
  const conn = await amqp.connect("amqp://rabbitmq");
  channel = await conn.createChannel();

  await channel.assertQueue("order_created", { durable: true });

  console.log("✅ RabbitMQ publisher ready");
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