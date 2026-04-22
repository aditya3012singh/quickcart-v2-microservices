const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const { reserveStock, releaseStock } = require("../services/product.service");

const packageDef = protoLoader.loadSync(path.join(__dirname, "../../proto/product.proto"));
const grpcObject = grpc.loadPackageDefinition(packageDef);
const productPackage = grpcObject.product;

async function ReserveStock(call, callback) {
  try {
    const { productId, quantity } = call.request;
    const result = await reserveStock(productId, quantity);
    return callback(null, result);
  } catch (err) {
    console.error("❌ gRPC ReserveStock error:", err);
    return callback(null, { success: false, message: "Internal error" });
  }
}

async function ReleaseStock(call, callback) {
  try {
    const { productId, quantity } = call.request;
    console.log(`📡 [gRPC] ReleaseStock called for product ${productId}, quantity ${quantity}`);
    
    await releaseStock(productId, quantity);
    
    return callback(null, { success: true, message: "Stock released via gRPC" });
  } catch (err) {
    console.error("❌ gRPC ReleaseStock error:", err);
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
      console.log("🚀 gRPC Product running on 50051");
      server.start();
    }
  );
}

module.exports = startGrpcServer;