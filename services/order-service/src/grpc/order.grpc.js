const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");
const path = require("path");

const packageDef = protoLoader.loadSync(path.join(__dirname, "../../proto/product.proto"));
const grpcObject = grpc.loadPackageDefinition(packageDef);
const productPackage = grpcObject.product;

const client = new productPackage.ProductService(
  "product-service:50051",
  grpc.credentials.createInsecure()
);


function reserveStock(productId, quantity) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000; // 5 second timeout
    client.ReserveStock(
      { productId, quantity },
      { deadline },
      (err, res) => {
        if (err) return reject(err);
        resolve(res);
      }
    );
  });
}

async function reserveStockWithRetry(productId, quantity, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await reserveStock(productId, quantity);

      if (result.success) return result;

      // retry only for lock issue
      if (result.message !== "Resource busy, try again") {
        return result;
      }

      console.log(`🔁 Retry ${i + 1} for product ${productId}`);

      await new Promise(res => setTimeout(res, 100)); // small delay

    } catch (err) {
      throw err;
    }
  }

  return { success: false, message: "Could not acquire lock, try later" };
}

module.exports = { reserveStockWithRetry };

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