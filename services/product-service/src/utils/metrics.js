const client = require("prom-client");

// collect default metrics (CPU, memory, etc.)
client.collectDefaultMetrics();

// 🔥 Custom metrics
const ordersCreated = new client.Counter({
  name: "orders_created_total",
  help: "Total number of orders created",
});

const paymentSuccess = new client.Counter({
  name: "payments_success_total",
  help: "Total successful payments",
});

const paymentFailed = new client.Counter({
  name: "payments_failed_total",
  help: "Total failed payments",
});

const stockReserveSuccess = new client.Counter({
  name: "stock_reserve_success_total",
  help: "Successful stock reservations",
});

const stockReserveFailed = new client.Counter({
  name: "stock_reserve_failed_total",
  help: "Failed stock reservations",
});

// HTTP latency histogram
const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency",
  labelNames: ["method", "route", "status"],
  buckets: [0.1, 0.3, 0.5, 1, 2, 5],
});

module.exports = {
  client,
  ordersCreated,
  paymentSuccess,
  paymentFailed,
  stockReserveSuccess,
  stockReserveFailed,
  httpRequestDuration,
};
