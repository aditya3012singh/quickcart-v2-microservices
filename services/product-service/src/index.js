const startGrpcServer = require("./grpc/product.grpc");
const startConsumer = require("./queue/orderCreated.consumer");
const { connectWithRetry } = require("./db");

async function start() {
  try {
    console.log("🚀 Starting Product Service...");

    await connectWithRetry();

    startGrpcServer();
    await startConsumer();

    console.log("✅ Product Service running");
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
}

start();