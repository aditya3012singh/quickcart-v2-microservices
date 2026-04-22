const startGrpcServer = require("./grpc/product.grpc");
const startConsumer = require("./queue/orderCreated.consumer");
const { connectWithRetry, pool, initDB } = require("./db/pool");
const express = require("express");
const logger = require("./utils/logger");

async function start() {
  try {
    logger.info({ event: "SERVICE_STARTING", message: "Starting Product Service..." });

    await connectWithRetry();
    await initDB();

    // Start gRPC server
    startGrpcServer();

    // Start consumer (RabbitMQ)
    await startConsumer();

    // Minimal HTTP server for gateway reverse-proxy and health checks
    const app = express();
    const { client, httpRequestDuration } = require("./utils/metrics");

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

    app.get("/", (req, res) => res.json({ status: "ok" }));

    app.get("/products", async (req, res) => {
      try {
        const result = await pool.query("SELECT id, stock, reserved_stock FROM products ORDER BY id");
        res.json(result.rows);
      } catch (err) {
        logger.error({ event: "FETCH_PRODUCTS_FAILED", error: err.message });
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });

    const port = process.env.PORT || 3002;
    app.listen(port, () => logger.info({ event: "HTTP_SERVER_STARTED", port, message: `Product HTTP running on ${port}` }));

    logger.info({ event: "SERVICE_READY", message: "Product Service running" });
  } catch (err) {
    logger.error({ event: "SERVICE_STARTUP_FAILED", error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();