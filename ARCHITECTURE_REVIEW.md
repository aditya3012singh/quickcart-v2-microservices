# 🔍 Architecture & Code Review: Order-Product Microservices System

**Reviewer:** Senior Backend Engineer  
**Date:** April 21, 2026  
**System:** Two-Phase Inventory Reservation Pattern  

---

## ⚠️ VERDICT: **NEEDS CRITICAL FIXES**

This system has the **right foundational pattern** but has **several critical production bugs** that will cause data loss and system hangs in production. Not safe to deploy.

---

## 1️⃣ CORRECTNESS OF TWO-PHASE PATTERN

### ✅ What Works
- **Phase 1 (Reserve):** `SELECT ... FOR UPDATE NOWAIT` correctly locks the row and prevents overselling
- **Phase 2 (Confirm):** Atomic decrement of both `stock` and `reserved_stock` maintains invariant
- **Transaction Isolation:** Using explicit transactions prevents dirty reads

### ❌ CRITICAL FLAW: Orphaned Reservations

```javascript
// Order Service index.js
const result = await reserveStock(productId, quantity);  // ✅ Reserved

if (!result.success) {
  return res.status(400).json({ error: result.message });
}

const dbResult = await pool.query(
  `INSERT INTO orders ...`,  // ⚠️ What if this fails?
  [productId, quantity, "CREATED"]
);
```

**Problem:** If order creation fails after reservation, the stock is orphaned:
- Stock reserved in Product Service ✅
- Order **NOT** created ❌
- ORDER_CREATED event **NOT** published ❌
- Consumer never decrements reserved_stock ❌
- **Result:** Stock locked forever or locked until timeout

**Example Scenario:**
```
1. reserveStock(5, 100) → SUCCESS (reserved_stock: 100)
2. Order DB has disk full → INSERT fails
3. res.status(500) returned
4. No ORDER_CREATED event published
5. Consumer never runs
6. reserved_stock stays at 100 FOREVER 🔥
7. All future stock checks fail even though stock is available
```

### Fix Required
```javascript
// Wrap both operations in a distributed transaction or
// Use a saga pattern with compensation

const result = await reserveStock(productId, quantity);
if (!result.success) return res.status(400).json({ error: result.message });

try {
  const dbResult = await pool.query(...);
  publishOrder({...});  // Publish ONLY if order created
} catch (err) {
  // 🔥 MISSING: Need to call Product Service to unreserve stock
  // This is a saga compensation step
  await releaseReservation(productId, quantity);
  throw err;
}
```

---

## 2️⃣ CONCURRENCY & RACE CONDITIONS

### ✅ Correct Parts
- `SELECT ... FOR UPDATE NOWAIT` prevents dirty reads
- Defensive WHERE clause in consumer: `stock >= $1 AND reserved_stock >= $1` ✅

### ❌ CRITICAL: Idempotency Not Implemented

**Consumer has NO deduplication mechanism:**

```javascript
// orderCreated.consumer.js
channel.consume("order_created", async (msg) => {
  const { orderId, productId, quantity, correlationId } = data;
  
  // ❌ PROBLEM: No check if this orderId was already processed
  // Message could be delivered twice
  
  const result = await client.query(
    `UPDATE products SET stock = stock - $1, reserved_stock = reserved_stock - $1
     WHERE id = $2 AND reserved_stock >= $1 AND stock >= $1 RETURNING *`,
    [quantity, productId]
  );
  
  // If message redelivered and stock insufficient, silently fails
  // But first processing succeeded, so data is inconsistent
});
```

**Failure Scenario:**
```
Message: { orderId: 1, productId: 5, quantity: 2 }

First delivery:
  - stock: 100 → 98 ✅
  - reserved_stock: 2 → 0 ✅
  - ACK sent

Consumer crashes before updating orderId offset

Second delivery (reprocessing):
  - stock: 98 → 96 ❌ WRONG (double-deducted!)
  - But WHERE clause prevents if stock < quantity
  - Still: Order Service has 1 order, Product Service deducted twice
```

### ❌ MAJOR: No Consumer Offset Tracking

RabbitMQ auto-acks AFTER processing, but there's no idempotency key. Better pattern:

```javascript
// Create deduplication table in Product Service
CREATE TABLE processed_orders (
  orderId INT PRIMARY KEY,
  processedAt TIMESTAMP
);

// Then in consumer:
const isDuplicate = await client.query(
  `SELECT 1 FROM processed_orders WHERE orderId = $1`, 
  [orderId]
);

if (isDuplicate.rows.length > 0) {
  channel.ack(msg);  // Skip duplicate
  return;
}
```

---

## 3️⃣ FAILURE SCENARIOS

### Scenario A: gRPC Call Fails (Product Service Down)

```javascript
// Order Service: order.grpc.js
client.ReserveStock({ productId, quantity }, (err, res) => {
  if (err) return reject(err);  // ❌ No retry, no timeout
  resolve(res);
});
```

**Problem:**
- ❌ No timeout configured (will hang forever)
- ❌ No retry logic
- ❌ No circuit breaker
- ❌ If Product Service is slow, Order Service hangs

**Production Impact:**
```
Product Service crashes
↓
All reserve calls timeout (default: undefined - INFINITE)
↓
Order Service threads exhaust
↓
Order Service becomes unresponsive
↓
Cascading failure
```

### Scenario B: RabbitMQ Fails

**Publisher (orderPublish.js):**
```javascript
async function initPublisher() {
  const conn = await amqp.connect("amqp://rabbitmq");  // ❌ No retry
  // If RabbitMQ down → CRASH
}

function publishOrder(event) {
  channel.sendToQueue(...);  // ❌ No error handling if channel closed
}
```

**Consumer (orderCreated.consumer.js):**
```javascript
async function startConsumer() {
  const conn = await amqp.connect("amqp://rabbitmq");  // ❌ No retry
  // If RabbitMQ down → CRASH
}
```

**Problem:**
- ❌ No reconnect logic
- ❌ No exponential backoff
- ❌ Both processes crash if RabbitMQ unavailable

**Production Impact:**
```
RabbitMQ restarts (0.5s maintenance)
↓
Both services crash
↓
Manual restart required
↓
Orders created but not confirmed = stuck in limbo
```

### Scenario C: Consumer Crashes Mid-Processing

```javascript
channel.consume("order_created", async (msg) => {
  try {
    // Process...
    await client.query("COMMIT");  // ✅ Committed
    channel.ack(msg);  // ❌ But crashes BEFORE ACK
  } catch (err) {
    await client.query("ROLLBACK");
    channel.nack(msg, false, true);  // Requeue = infinite loop if persistent error
  }
});
```

**Timeline:**
```
1. Message consumed
2. Stock decremented (COMMIT)
3. About to ACK
4. Process crashes
5. Consumer group rebalances
6. Same message reprocessed
7. Stock decremented AGAIN 🔥
```

**With defensive WHERE clause** (`stock >= $1`), second deduction might fail silently, but data is still inconsistent.

---

## 4️⃣ CODE-LEVEL REVIEW

### gRPC Issues (order.grpc.js)

❌ **No Timeout:**
```javascript
const client = new productPackage.ProductService(
  "product-service:50051",
  grpc.credentials.createInsecure()
  // ❌ Missing: { maxRetries: 3, maxRetryDelay: 5000, maxSendMessageLength: ... }
);
```

**Fix:**
```javascript
const client = new productPackage.ProductService(
  "product-service:50051",
  grpc.credentials.createInsecure(),
  {
    "grpc.max_receive_message_length": 4 * 1024 * 1024,
    "grpc.max_send_message_length": 4 * 1024 * 1024,
  }
);

function reserveStock(productId, quantity) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;  // 5s timeout
    
    client.ReserveStock(
      { productId, quantity },
      { deadline },  // Add deadline
      (err, res) => {
        if (err) {
          // Check if retryable
          if (err.code === grpc.status.UNAVAILABLE) {
            return reject(new RetryableError(err));
          }
          return reject(err);
        }
        resolve(res);
      }
    );
  });
}
```

❌ **No Error Recovery:**
```javascript
// Current: Generic catch in index.js
catch (err) {
  console.error("❌ Order failed:", err);
  res.status(500).json({ error: "Order failed" });
}

// ✅ Should distinguish errors:
catch (err) {
  if (err instanceof RetryableError) {
    return res.status(503).json({ error: "Service temporarily unavailable" });
  }
  if (err.code === 'RESOURCE_EXHAUSTED') {
    return res.status(429).json({ error: "Too many requests" });
  }
  res.status(500).json({ error: "Order failed" });
}
```

### PostgreSQL Issues (product.service.js)

❌ **Missing Lock Timeout:**
```javascript
const result = await client.query(
  `SELECT stock, reserved_stock FROM products WHERE id=$1 FOR UPDATE NOWAIT`,
  [productId]
);

// ✅ CORRECT: NOWAIT will fail immediately if locked
// But should handle 55P03 error gracefully
// Currently does ✅, but could use WAIT 5 syntax for better UX
```

✅ **Actually handled correctly:**
```javascript
if (err.code === "55P03") {  // Lock not available
  return { success: false, message: "Resource busy, try again" };
}
```

⚠️ **But Missing:**
```javascript
// What if:
// - Product doesn't exist? ✅ Handled ("Product not found")
// - Concurrent update causes deadlock? ❌ Not handled
// - Network interrupted mid-transaction? ❌ Not handled

// Should add:
if (err.code === "40P01") {  // Serialization failure / Deadlock
  return { success: false, message: "Temporarily unavailable, try again" };
}
```

### Consumer Issues (orderCreated.consumer.js)

❌ **Missing Correlation ID Usage:**
```javascript
const { orderId, productId, quantity, correlationId } = data;

console.log(`📝 Processing order ${orderId} (correlation: ${correlationId})`);
// ✅ Logged but not used
// ❌ Should be used for:
// 1. Deduplication
// 2. Distributed tracing
// 3. Linking logs across services
```

❌ **Broken Failure Handling:**
```javascript
if (result.rows.length === 0) {
  console.log("❌ Stock confirmation failed");
  
  channel.sendToQueue("stock_failed", ...);
  await client.query("ROLLBACK");
} else {
  channel.sendToQueue("stock_confirmed", ...);
  await client.query("COMMIT");
}

channel.ack(msg);  // ✅ Acked in both cases
```

**Problem:** Stock confirmation failed but order still exists in CREATED state. No compensating transaction in Order Service.

❌ **Silent Failure Risk:**
```javascript
const { orderId, productId, quantity, correlationId } = data;

if (!orderId || !productId || quantity <= 0) {
  console.log("❌ Invalid message");
  channel.ack(msg);  // ✅ Good: ACK invalid messages
  return;
}

// ✅ Good defensive check
// But should log to monitoring/alerting system
```

---

## 5️⃣ MISSING PRODUCTION FEATURES

### ❌ No Idempotency Key Tracking
```javascript
// Missing in both services:
// - No deduplication table
// - No idempotent key generation
// - No consumer offset/checkpoint

// Result: Duplicate processing possible
```

### ❌ No Dead Letter Queue (DLQ)
```javascript
channel.nack(msg, false, true);  // Requeue forever on error
// ❌ If error is permanent (e.g., invalid data), infinite loop

// ✅ Should be:
if (isPermanentError(err)) {
  channel.sendToQueue("dlq_orders", msg);
  channel.ack(msg);
} else {
  channel.nack(msg, false, true);  // Retry
}
```

### ❌ No Circuit Breaker
```javascript
// If Product Service is slow:
// Order Service will hang
// No fallback, no timeout protection

// ✅ Should implement:
const circuitBreaker = new CircuitBreaker(
  (productId, qty) => reserveStock(productId, qty),
  {
    timeout: 5000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
  }
);
```

### ❌ No Distributed Tracing
```javascript
// No requestId propagated through:
// - Order Service → gRPC call
// - Product Service → RabbitMQ
// - RabbitMQ → Consumer

// Makes debugging production issues impossible
```

### ❌ No Structured Logging
```javascript
console.error("❌ Order failed:", err);
// Should be:
logger.error({
  component: "order-service",
  operation: "createOrder",
  productId,
  quantity,
  error: err.message,
  stack: err.stack,
  timestamp: new Date(),
  duration: endTime - startTime,
});
```

### ❌ No Metrics
```javascript
// Missing:
// - Reservation success rate
// - gRPC latency
// - Message processing latency
// - Queue depth
// - Error rates by type
```

### ❌ No Saga Compensation (Distributed Transaction)

When order creation fails after reservation:
```javascript
// Order Service should call back to Product Service
// to release the reservation

const releaseReservation = async (productId, quantity) => {
  return new Promise((resolve, reject) => {
    client.ReleaseReservation({ productId, quantity }, (err, res) => {
      if (err) return reject(err);
      resolve(res);
    });
  });
};

try {
  await reserveStock(productId, quantity);
  await createOrder(productId, quantity);
  await publishOrder(order);
} catch (err) {
  // Compensation: Release the reservation
  await releaseReservation(productId, quantity);
  throw err;
}
```

---

## 6️⃣ ADDITIONAL ISSUES

### ❌ Missing Database Schema
- No schema file
- No migration system
- Product and Order tables assumed to exist
- Will fail on first deployment

### ❌ No Connection Recovery
- RabbitMQ connection crash → service crash
- No automatic reconnect with backoff
- No health checks

### ❌ Docker-Compose Incomplete
```yaml
# Missing:
# - order-db service (Order Service uses it but not defined!)
# - order-service service configuration
# - network definition
# - volume mounts for persistence
```

### ❌ No Input Validation Beyond Nulls
```javascript
// Current:
if (!productId || quantity <= 0) {
  return res.status(400).json({ error: "Invalid input" });
}

// Should also validate:
if (productId <= 0 || !Number.isInteger(productId)) ...
if (quantity > 1000000) ...  // Prevent DoS
if (!Number.isInteger(quantity)) ...
```

### ❌ Credentials in Code
```javascript
const pool = new Pool({
  user: "postgres",
  password: "postgres",  // ❌ Hardcoded!
  // Should use: process.env.DB_USER, process.env.DB_PASSWORD
});
```

---

## 📋 DETAILED FIXES REQUIRED

| Issue | Severity | Fix |
|-------|----------|-----|
| Orphaned reservations | 🔴 CRITICAL | Implement saga pattern for compensation |
| No consumer idempotency | 🔴 CRITICAL | Add deduplication table + processing log |
| No gRPC timeout | 🔴 CRITICAL | Add 5s deadline to all calls |
| RabbitMQ crash → service crash | 🔴 CRITICAL | Add reconnect logic with backoff |
| Missing DLQ | 🟠 HIGH | Implement DLQ for permanent failures |
| No circuit breaker | 🟠 HIGH | Add timeout + fallback for gRPC |
| Missing distributed tracing | 🟠 HIGH | Propagate requestId through system |
| Consumer offset not tracked | 🟠 HIGH | Implement consumer group offset management |
| Docker-compose missing order-db | 🔴 CRITICAL | Add order-db service |
| Credentials hardcoded | 🟠 HIGH | Move to environment variables |

---

## 🎯 CORRECTED FLOW (Safe Version)

```
1. Order POST /
   ↓
2. [TRY] reserveStock (with 5s timeout + retry)
   ↓
3. [IF FAIL] Return 400/503 ← compensate (if needed)
   ↓
4. [IF OK] INSERT order with saga status="PENDING"
   ↓
5. [TRY] publishOrder with correlationId
   ↓
6. [IF FAIL] ← compensation: releaseReservation + UPDATE saga status
   ↓
7. [IF OK] UPDATE order status="CONFIRMED"
   ↓
8. Consumer processes ORDER_CREATED
   ↓
9. Check deduplication table (correlationId)
   ↓
10. [IF DUPLICATE] ACK (idempotent)
   ↓
11. [IF NEW] UPDATE stock + reserved_stock (atomic)
   ↓
12. [TRY] publish stock_confirmed
   ↓
13. [IF FAIL] → DLQ (not retry forever)
   ↓
14. UPDATE product_saga status="CONFIRMED"
   ↓
15. ACK message
```

---

## 🏁 FINAL VERDICT

### ❌ **NOT PRODUCTION SAFE**

#### What Works ✅
- Transaction isolation model is sound
- Row-level locking prevents concurrent updates
- Defensive WHERE clauses exist
- Input validation present

#### What Fails ❌
1. **Orphaned reservations** (data loss)
2. **No consumer idempotency** (duplicate orders)
3. **No timeout on gRPC** (cascading hangs)
4. **RabbitMQ crashes kill system** (no reconnect)
5. **Docker setup incomplete** (order-db missing)
6. **No distributed transaction semantics** (saga pattern missing)
7. **No observability** (debugging impossible)
8. **No failure recovery** (system hangs on timeouts)

### ⚠️ **Current Status: Phase 0.5**
- Core pattern is correct
- Implementation has critical bugs
- Needs 2-3 weeks of hardening before "Phase 1 Ready"

### ✅ **To Reach Phase 1 Production-Ready:**
1. **Immediately:** Add saga compensation (DLQ + retry logic)
2. **Immediately:** Add gRPC timeout + circuit breaker
3. **This week:** Implement idempotency tracking
4. **This week:** Add structured logging + distributed tracing
5. **Before deploy:** Complete Docker setup + schema migrations
6. **Ongoing:** Add metrics, alerting, monitoring dashboards

---

## 📞 Questions for Clarification

1. Is this a learning project or targeting real production?
2. What's the expected throughput (RPS)?
3. Are you using a saga framework (Temporal, Cadence) or rolling custom?
4. What's your acceptable data loss window if service crashes?

---

**Reviewer Note:** The architecture foundation is solid, but production readiness requires addressing the critical concurrency and failure handling issues outlined above. Focus on idempotency and saga compensation first.
