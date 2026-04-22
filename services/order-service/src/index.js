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

const { v4: uuidv4 } = require("uuid");

// 🔥 Correlation ID & Context Logger Middleware
app.use((req, res, next) => {
  req.correlationId = req.headers["x-correlation-id"] || uuidv4();
  res.setHeader("x-correlation-id", req.correlationId);
  req.logger = logger.child({ correlationId: req.correlationId });
  next();
});

app.post("/", async (req, res) => {
  const { productId, quantity } = req.body;
  const { correlationId, logger: reqLogger } = req;
  let reservationSuccessful = false;

  if (!productId || quantity <= 0) {
    return res.status(400).json({ error: "Invalid input" });
  }

  reqLogger.info({ 
    event: "ORDER_REQUEST_RECEIVED", 
    productId, 
    quantity
  });

  const client = await pool.connect();
  try {
    // 🔥 Step 1: Reserve stock (atomic)
    const result = await reserveStockWithRetry(productId, quantity, correlationId);

    if (!result.success) {
      reqLogger.warn({ 
        event: "STOCK_RESERVATION_REFUSED", 
        productId, 
        reason: result.message
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
    
    // 🔥 Add to Outbox Table
    const eventPayload = {
      orderId: order.id,
      productId,
      quantity,
      correlationId // Use the consistent correlationId (UUID)
    };

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      ["ORDER_CREATED", JSON.stringify(eventPayload)]
    );

    await client.query("COMMIT");
    
    // 🔥 Metrics: Inc order count
    ordersCreated.inc();
    
    reqLogger.info({ 
      event: "ORDER_CREATED_AND_OUTBOX_SAVED", 
      orderId: order.id
    });

    res.json(order);

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    
    reqLogger.error({ 
      event: "ORDER_CREATION_FAILED", 
      error: err.message
    });

    // 🧟 Compensation: Release stock if reservation was successful but subsequent steps failed
    if (reservationSuccessful) {
      reqLogger.info({ 
        event: "COMPENSATION_TRIGGERED", 
        productId
      });

      await releaseStock(productId, quantity, correlationId).catch(e => {
        reqLogger.error({ 
          event: "COMPENSATION_FAILED", 
          error: e.message
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