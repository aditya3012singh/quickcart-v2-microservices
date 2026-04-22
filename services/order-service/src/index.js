const express = require("express");
const { connectWithRetry, pool } = require("./db/pool");
const { reserveStockWithRetry, releaseStock } = require("./grpc/order.grpc");
const logger = require("./utils/logger");
const startPaymentConsumer = require("./queue/payment.consumer");
const startOutboxWorker = require("./queue/outbox_worker");

const app = express();
const { client, ordersCreated, httpRequestDuration } = require("./utils/metrics");

app.use(express.json());

// 🔥 HTTP Latency Middleware
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();

  res.on("finish", () => {
    end({
      method: req.method,
      route: req.path,
      status: res.statusCode,
    });
  });

  next();
});

// 🔥 Metrics Endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", client.register.contentType);
  res.end(await client.register.metrics());
});

app.post("/", async (req, res) => {
  const { productId, quantity } = req.body;
  let reservationSuccessful = false;

  if (!productId || quantity <= 0) {
    return res.status(400).json({ error: "Invalid input" });
  }

  // 🔥 Generate Correlation ID early
  const requestId = Math.random().toString(36).substring(7);
  const correlationId = `order-req-${requestId}`;

  logger.info({ 
    event: "ORDER_REQUEST_RECEIVED", 
    productId, 
    quantity, 
    correlationId 
  });

  const client = await pool.connect();
  try {
    // 🔥 Step 1: Reserve stock (atomic)
    const result = await reserveStockWithRetry(productId, quantity, correlationId);

    if (!result.success) {
      logger.warn({ 
        event: "STOCK_RESERVATION_REFUSED", 
        productId, 
        reason: result.message,
        correlationId 
      });
      return res.status(400).json({ error: result.message });
    }

    reservationSuccessful = true;

    // 🔥 Step 2: Create Order & Outbox Event in a SINGLE TRANSACTION
    await client.query("BEGIN");

    const dbResult = await client.query(
      `INSERT INTO orders (product_id, quantity, status)
       VALUES ($1, $2, $3) RETURNING *`,
      [productId, quantity, "CREATED"]
    );

    const order = dbResult.rows[0];
    
    // Update correlationId to be more specific to the order once we have the ID
    const orderCorrelationId = `order-${order.id}`;

    // 🔥 Add to Outbox Table
    const eventPayload = {
      orderId: order.id,
      productId,
      quantity,
      correlationId: orderCorrelationId
    };

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      ["ORDER_CREATED", JSON.stringify(eventPayload)]
    );

    await client.query("COMMIT");
    
    // 🔥 Metrics: Inc order count
    ordersCreated.inc();
    
    logger.info({ 
      event: "ORDER_CREATED_AND_OUTBOX_SAVED", 
      orderId: order.id, 
      correlationId: orderCorrelationId 
    });

    res.json(order);

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    
    logger.error({ 
      event: "ORDER_CREATION_FAILED", 
      error: err.message, 
      correlationId 
    });

    // 🧟 Compensation: Release stock if reservation was successful but subsequent steps failed
    if (reservationSuccessful) {
      logger.info({ 
        event: "COMPENSATION_TRIGGERED", 
        productId, 
        correlationId 
      });

      await releaseStock(productId, quantity, correlationId).catch(e => {
        logger.error({ 
          event: "COMPENSATION_FAILED", 
          error: e.message, 
          correlationId 
        });
      });
    }

    res.status(500).json({ error: "Order failed" });
  } finally {
    client.release();
  }
});

app.listen(3003, async () => {
  await connectWithRetry();
  await startPaymentConsumer();
  await startOutboxWorker();
  logger.info({ event: "SERVICE_STARTED", message: "Order service running on 3003" });
});