const pino = require("pino");

const logger = pino({
  level: "info",
  base: {
    service: process.env.SERVICE_NAME || "unknown-service",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;