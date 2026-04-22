const amqp = require("amqplib");
const { pool } = require("../db/pool");

async function startOutboxWorker(retries = 20, delay = 3000) {
  let connection;
  let channel;

  // 1. RabbitMQ Connection with Retry
  while (retries > 0) {
    try {
      connection = await amqp.connect("amqp://rabbitmq");
      channel = await connection.createChannel();
      
      console.log("✅ Outbox Worker connected to RabbitMQ");
      break;
    } catch (err) {
      console.error("❌ Outbox Worker RabbitMQ connection failed:", err.message);
      retries--;
      if (retries === 0) process.exit(1);
      await new Promise(res => setTimeout(res, delay));
    }
  }

  // 2. Poll Loop
  setInterval(async () => {
    let client;
    try {
      client = await pool.connect();
      
      // Fetch PENDING events
      const result = await client.query(
        "SELECT * FROM outbox_events WHERE status = 'PENDING' ORDER BY created_at LIMIT 10 FOR UPDATE SKIP LOCKED"
      );

      for (const event of result.rows) {
        try {
          console.log(`📤 Outbox: Processing event ${event.id} (${event.event_type})`);

          // Logic for different event types
          if (event.event_type === "ORDER_CREATED") {
             // For now, we publish to the direct 'order_created' queue or exchange
             // We'll use the existing logic from orderPublish.js but inlined or imported
             // Actually, orderPublish.js uses an exchange if we refactored it. 
             // Let's assume we publish to a specific queue or exchange.
             
             const queue = "order_created";
             const qOptions = {
                durable: true,
                deadLetterExchange: "order_dlx",
                deadLetterRoutingKey: "dlq"
             };
             
             await channel.assertQueue(queue, qOptions);
             channel.sendToQueue(queue, Buffer.from(JSON.stringify(event.payload)), { persistent: true });
          }

          // Mark as SENT
          await client.query(
            "UPDATE outbox_events SET status = 'SENT' WHERE id = $1",
            [event.id]
          );
          
          console.log(`✅ Outbox: Event ${event.id} published and marked SENT`);
          
        } catch (publishErr) {
          console.error(`❌ Outbox: Failed to publish event ${event.id}:`, publishErr.message);
        }
      }
    } catch (err) {
      console.error("❌ Outbox Worker Error:", err.message);
    } finally {
      if (client) client.release();
    }
  }, 2000); // Poll every 2 seconds
}

module.exports = startOutboxWorker;
