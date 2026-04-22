const startPaymentConsumer = require("./queue/payement.consumer.js");

async function start(retries = 10, delay = 3000) {
  console.log("🚀 Starting Payment Service...");

  while (retries > 0) {
    try {
      await startPaymentConsumer();
      console.log("💳 Payment Service running");
      return;
    } catch (err) {
      console.error("❌ Payment Service startup failed:", err.message);
      retries--;
      if (retries === 0) {
        process.exit(1);
      }
      console.log(`⏳ Retrying in ${delay / 1000}s... (${retries} left)`);
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

start();