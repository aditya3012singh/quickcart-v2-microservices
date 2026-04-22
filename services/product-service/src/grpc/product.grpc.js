const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const logger = require("../utils/logger");
const { reserveStock, releaseStock } = require("../services/product.service");

const packageDef = protoLoader.loadSync(path.join(__dirname, "../../proto/product.proto"));
const grpcObject = grpc.loadPackageDefinition(packageDef);
const productPackage = grpcObject.product;

async function ReserveStock(call, callback) {
  const { productId, quantity, orderId, eventId } = call.request;
  const correlationId = call.metadata.get("x-correlation-id")[0] || call.request.correlationId;
  const grpcLogger = logger.child({ correlationId });

  try {
    grpcLogger.info({ event: "GRPC_RESERVE_STOCK_RECEIVED", productId, quantity, orderId, eventId });
    const result = await reserveStock(productId, quantity);
    return callback(null, result);
  } catch (err) {
    grpcLogger.error({ event: "GRPC_RESERVE_STOCK_FAILED", productId, error: err.message, orderId, eventId });
    return callback(null, { success: false, message: "Internal error" });
  }
}

async function ReleaseStock(call, callback) {
  const { productId, quantity, orderId, eventId } = call.request;
  const correlationId = call.metadata.get("x-correlation-id")[0] || call.request.correlationId;
  const grpcLogger = logger.child({ correlationId });

  try {
    grpcLogger.info({ event: "GRPC_RELEASE_STOCK_RECEIVED", productId, quantity, orderId, eventId });
    await releaseStock(productId, quantity, orderId, correlationId, eventId);
    return callback(null, { success: true, message: "Stock released via gRPC" });
  } catch (err) {
    grpcLogger.error({ event: "GRPC_RELEASE_STOCK_FAILED", productId, error: err.message, orderId, eventId });
    return callback(null, { success: false, message: "Internal error" });
  }
}

function startGrpcServer() {
  const server = new grpc.Server();

  server.addService(productPackage.ProductService.service, {
    ReserveStock,
    ReleaseStock,
  });

  server.bindAsync(
    "0.0.0.0:50051",
    grpc.ServerCredentials.createInsecure(),
    () => {
      logger.info({ event: "grpc_server_started", message: "gRPC Product running on 50051" });
      server.start();
    }
  );
}

module.exports = startGrpcServer;