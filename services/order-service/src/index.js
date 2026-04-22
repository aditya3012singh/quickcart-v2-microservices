const express = require("express");
const { connectWithRetry, pool } = require("./db/pool");
const { reserveStockWithRetry, releaseStock } = require("./grpc/order.grpc");
const { initPublisher, publishOrder } = require("./queue/orderPublish");
const startPaymentConsumer = require("./queue/payment.consumer");
const startOutboxWorker = require("./queue/outbox_worker");

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {
  const { productId, quantity } = req.body;
  let reservationSuccessful = false;

  if (!productId || quantity <= 0) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const client = await pool.connect();
  try {
    // 🔥 Step 1: Reserve stock (atomic)
    const result = await reserveStockWithRetry(productId, quantity);

    if (!result.success) {
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
      correlationId: order.id.toString()
    };

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      ["ORDER_CREATED", JSON.stringify(eventPayload)]
    );

    await client.query("COMMIT");
    console.log(`✅ Order ${order.id} and Outbox event saved.`);

    res.json(order);

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Order failed:", err);

    // 🧟 Compensation: Release stock if reservation was successful but subsequent steps failed
    if (reservationSuccessful) {
      console.log(`🔄 [Compensation] Releasing stock for product ${productId}...`);
      await releaseStock(productId, quantity).catch(e => {
        console.error("🚨 [Critical] Stock compensation failed:", e.message);
      });
    }

    res.status(500).json({ error: "Order failed" });
  } finally {
    client.release();
  }
});

app.listen(3003, async () => {
  await connectWithRetry();
  await initPublisher();
  await startPaymentConsumer();
  await startOutboxWorker();
  console.log("🚀 Order service running on 3003");
});