const express = require("express");
const { connectWithRetry, pool } = require("./db/pool");
const { reserveStock } = require("./grpc/order.grpc");
const { initPublisher, publishOrder } = require("./queue/orderPublish");

const app = express();
app.use(express.json());

app.post("/", async (req, res) => {
  const { productId, quantity } = req.body;

  if (!productId || quantity <= 0) {
    return res.status(400).json({ error: "Invalid input" });
  }

  try {
    // 🔥 Step 1: Reserve stock (atomic)
    // ⚠️ PHASE 1 LIMITATION: If order creation fails below, stock remains reserved forever
    // This will be fixed in Phase 2 with saga compensation (releaseReservation RPC call)
    const result = await reserveStock(productId, quantity);

    if (!result.success) {
      return res.status(400).json({ error: result.message });
    }

    // 🔥 Step 2: Create order
    const dbResult = await pool.query(
      `INSERT INTO orders (product_id, quantity, status)
       VALUES ($1, $2, $3) RETURNING *`,
      [productId, quantity, "CREATED"]
    );

    const order = dbResult.rows[0];

    // 🔥 Step 3: Publish event
    publishOrder({
      orderId: order.id,
      productId,
      quantity,
      correlationId: order.id.toString()
    });

    res.json(order);

  } catch (err) {
    console.error("❌ Order failed:", err);
    // ⚠️ NOTE: Stock may be orphaned if error occurs after reservation
    res.status(500).json({ error: "Order failed" });
  }
});

app.listen(3003, async () => {
  await connectWithRetry();
  await initPublisher();
  console.log("🚀 Order service running on 3003");
});