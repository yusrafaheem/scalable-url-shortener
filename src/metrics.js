'use strict';

const client = require('prom-client');

// One registry per worker process; the /metrics endpoint on each worker
// exposes its own numbers. In production these are scraped per-pod by
// Prometheus and aggregated (e.g. via `sum by (route)`), which is why the
// metrics are labeled with `worker` -- so per-process behavior stays visible
// even after aggregation.
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code', 'worker'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'worker'],
  registers: [register],
});

const rateLimitedTotal = new client.Counter({
  name: 'rate_limited_requests_total',
  help: 'Requests rejected by the rate limiter',
  labelNames: ['worker'],
  registers: [register],
});

const cacheHitsTotal = new client.Counter({
  name: 'cache_hits_total',
  help: 'Cache-aside store hits vs misses',
  labelNames: ['result', 'worker'],
  registers: [register],
});

module.exports = {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  rateLimitedTotal,
  cacheHitsTotal,
};
