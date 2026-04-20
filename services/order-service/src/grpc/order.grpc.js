const grpc = require("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader");

const packageDef = protoLoader.loadSync("/app/proto/product.proto");
const grpcObject = grpc.loadPackageDefinition(packageDef);
const productPackage = grpcObject.product;

const client = new productPackage.ProductService(
  "product-service:50051",
  grpc.credentials.createInsecure()
);

function reserveStock(productId, quantity) {
  return new Promise((resolve, reject) => {
    client.ReserveStock({ productId, quantity }, (err, res) => {
      if (err) return reject(err);
      resolve(res); // { success, message }
    });
  });
}

module.exports = { reserveStock };