const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");
const logger = require("../utils/logger");

const packageDef = protoLoader.loadSync(path.join(__dirname, "../../proto/product.proto"));
const grpcObject = grpc.loadPackageDefinition(packageDef);
const productPackage = grpcObject.product;

const client = new productPackage.ProductService(
  "product-service:50051",
  grpc.credentials.createInsecure()
);

function reserveStock(productId, quantity, correlationId, orderId = "", eventId = "") {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000; // 5 second timeout
    client.ReserveStock(
      { productId, quantity, correlationId, orderId, eventId },
      { deadline },
      (err, res) => {
        if (err) return reject(err);
        resolve(res);
      }
    );
  });
}

function releaseStock(productId, quantity, correlationId, orderId = "", eventId = "") {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    client.ReleaseStock(
      { productId, quantity, correlationId, orderId, eventId },
      { deadline },
      (err, res) => {
        if (err) return reject(err);
        resolve(res);
      }
    );
  });
}

async function reserveStockWithRetry(productId, quantity, correlationId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await reserveStock(productId, quantity, correlationId);

      if (result.success) return result;

      // retry only for lock issue
      if (result.message !== "Resource busy, try again") {
        return result;
      }

      logger.info({ 
        event: "STOCK_RESERVE_RETRY", 
        productId, 
        retryCount: i + 1,
        correlationId 
      });

      await new Promise(res => setTimeout(res, 100)); // small delay

    } catch (err) {
      logger.error({
        event: "STOCK_RESERVE_ERROR",
        productId,
        error: err.message,
        correlationId
      });
      throw err;
    }
  }

  return { success: false, message: "Could not acquire lock, try later" };
}

module.exports = { reserveStockWithRetry, releaseStock };

// function reserveStock(productId, quantity) {
//   return new Promise((resolve, reject) => {
//     const deadline = Date.now() + 5000;  // 5 second timeout
    
//     client.ReserveStock(
//       { productId, quantity },
//       { deadline },
//       (err, res) => {
//         if (err) return reject(err);
//         resolve(res); // { success, message }
//       }
//     );
//   });
// }

// module.exports = { reserveStock };