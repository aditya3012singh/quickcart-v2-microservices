const startPaymentConsumer = require("./queue/payement.consumer.js");
const logger = require("./utils/logger");

async function start(retries = 10, delay = 3000) {
  logger.info({ event: "SERVICE_STARTING", message: "Starting Payment Service..." });

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