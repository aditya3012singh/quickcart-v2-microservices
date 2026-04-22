const amqp = require("amqplib");
const { pool } = require("../db/pool");
const logger = require("../utils/logger");

async function startOutboxWorker(retries = 20, delay = 3000) {
  let connection;
  let channel;

  // 1. RabbitMQ Connection with Retry
  while (retries > 0) {
    try {
      connection = await amqp.connect("amqp://rabbitmq");
      channel = await connection.createChannel();
      
      logger.info({ event: "OUTBOX_MQ_CONNECTED", message: "Outbox Worker connected to RabbitMQ" });
      break;
    } catch (err) {
      logger.error({ 
        event: "outbox_worker_mq_connection_failed", 
        error: err.message,
        retriesLeft: retries - 1 
      });
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
        const { correlationId } = event.payload;
        const outboxLogger = logger.child({ correlationId });

        try {
          outboxLogger.info({ 
            event: "OUTBOX_PROCESSING", 
            eventId: event.id, 
            eventType: event.event_type
          });

          // Logic for different event types
          if (event.event_type === "ORDER_CREATED") {
             const queue = "order_created";
             const qOptions = {
                durable: true,
                deadLetterExchange: "order_dlx",
                deadLetterRoutingKey: "dlq"
             };
             
             await channel.assertQueue(queue, qOptions);

             // 🔥 Inject eventId into the payload before publishing
             const enrichedPayload = { ...event.payload, eventId: event.id };
             
             channel.sendToQueue(queue, Buffer.from(JSON.stringify(enrichedPayload)), { 
                persistent: true,
                headers: { "x-correlation-id": correlationId }
             });
          }

          // Mark as SENT
          await client.query(
            "UPDATE outbox_events SET status = 'SENT' WHERE id = $1",
            [event.id]
          );
          
          outboxLogger.info({ 
            event: "OUTBOX_PUBLISHED", 
            eventId: event.id
          });
          
        } catch (publishErr) {
          outboxLogger.error({ 
            event: "OUTBOX_PUBLISH_FAILED", 
            eventId: event.id, 
            error: publishErr.message
          });
        }
      }
    } catch (err) {
      logger.error({ event: "outbox_worker_error", error: err.message });
    } finally {
      if (client) client.release();
    }
  }, 2000); // Poll every 2 seconds
}

module.exports = startOutboxWorker;
