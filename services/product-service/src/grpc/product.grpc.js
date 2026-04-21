const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const { reserveStock } = require("../services/product.service");

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

    return callback(null, {
      success: false,
      message: "Internal error"
    });
  }
}

function startGrpcServer() {
  const server = new grpc.Server();

  server.addService(productPackage.ProductService.service, {
    ReserveStock,
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