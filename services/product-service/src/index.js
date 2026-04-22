const startGrpcServer = require("./grpc/product.grpc");
const startConsumer = require("./queue/orderCreated.consumer");
const { connectWithRetry, pool, initDB } = require("./db/pool");
const express = require("express");

async function start() {
  try {
    console.log("🚀 Starting Product Service...");

    await connectWithRetry();
    await initDB();

    // Start gRPC server
    startGrpcServer();

    // Start consumer (RabbitMQ)
    await startConsumer();

    // Minimal HTTP server for gateway reverse-proxy and health checks
    const app = express();

    app.get("/", (req, res) => res.json({ status: "ok" }));

    app.get("/products", async (req, res) => {
      try {
        const result = await pool.query("SELECT id, stock, reserved_stock FROM products ORDER BY id");
        res.json(result.rows);
      } catch (err) {
        console.error("❌ Failed to fetch products:", err);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });

    const port = process.env.PORT || 3002;
    app.listen(port, () => console.log(`🚀 Product HTTP running on ${port}`));

    console.log("✅ Product Service running");
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

start();