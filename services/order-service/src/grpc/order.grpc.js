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
    const deadline = Date.now() + 5000;  // 5 second timeout
    
    client.ReserveStock(
      { productId, quantity },
      { deadline },
      (err, res) => {
        if (err) return reject(err);
        resolve(res); // { success, message }
      }
    );
  });
}

module.exports = { reserveStock };