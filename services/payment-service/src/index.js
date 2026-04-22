const startPaymentConsumer = require("./queue/payement.consumer.js");
const logger = require("./utils/logger");
const express = require("express");
const { client } = require("./utils/metrics");

async function start(retries = 10, delay = 3000) {
  logger.info({ event: "SERVICE_STARTING", message: "Starting Payment Service..." });

  // 🔥 Minimal HTTP server for metrics
  const app = express();
  app.get("/metrics", async (req, res) => {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  });

  const port = process.env.PORT || 3004;
  app.listen(port, () => logger.info({ event: "METRICS_SERVER_STARTED", port, message: `Payment Metrics running on ${port}` }));

  while (retries > 0) {
    try {
      await startPaymentConsumer();
      logger.info({ event: "SERVICE_READY", message: "Payment Service running" });
      return;
    } catch (err) {
      logger.error({ event: "SERVICE_STARTUP_FAILED", error: err.message });
      retries--;
      if (retries === 0) {
        process.exit(1);
      }
      logger.info({ event: "SERVICE_STARTUP_RETRY", delaySeconds: delay / 1000, retriesLeft: retries });
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

start();