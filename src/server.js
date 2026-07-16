'use strict';

const Fastify = require('fastify');
const { SnowflakeGenerator } = require('./idgen');
const { ShardedStore } = require('./store');
const { RateLimiter } = require('./rateLimiter');
const {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  rateLimitedTotal,
  cacheHitsTotal,
} = require('./metrics');

/**
 * Builds one instance of the API. Called once per worker process by
 * cluster.js (or directly by server.js when run standalone). Every piece of
 * state below (store, idempotency map, rate limiter, id generator) is
 * process-local and shares nothing with other workers -- this "shared
 * nothing" design is exactly what makes horizontal scaling as simple as
 * "run more of these" behind a load balancer.
 */
function buildApp({ workerId = 0, logger = false } = {}) {
  const app = Fastify({ logger, trustProxy: true });

  const idGen = new SnowflakeGenerator(workerId);
  const codeStore = new ShardedStore(); // code -> longUrl
  const idempotencyStore = new ShardedStore(); // contentHash -> code

  const rateLimiter = new RateLimiter({
    capacity: Number(process.env.RATE_LIMIT_CAPACITY || 20_000),
    refillPerSec: Number(process.env.RATE_LIMIT_REFILL_PER_SEC || 20_000),
  });

  const workerLabel = String(workerId);

  app.addHook('onRequest', (req, reply, done) => {
    req._startHrTime = process.hrtime.bigint();
    const key = req.ip || 'unknown';
    if (!rateLimiter.allow(key)) {
      rateLimitedTotal.inc({ worker: workerLabel });
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    const route = req.routeOptions?.url || req.url;
    const durationSec = Number(process.hrtime.bigint() - req._startHrTime) / 1e9;
    const labels = {
      method: req.method,
      route,
      status_code: reply.statusCode,
      worker: workerLabel,
    };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
    done();
  });

  app.get('/health', async () => ({ status: 'ok', worker: workerId, pid: process.pid }));

  app.get('/metrics', async (req, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });

  app.post('/api/shorten', async (req, reply) => {
    const { url } = req.body || {};

    if (typeof url !== 'string' || url.length === 0 || url.length > 8192) {
      reply.code(400);
      return { error: 'invalid_url' };
    }
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      reply.code(400);
      return { error: 'invalid_url' };
    }

    // Idempotency: resubmitting the same long URL returns the existing code
    // instead of minting a new one. This matters at scale because retries
    // (client timeouts, load balancer failover) are common, and without
    // this you'd leak a new short code on every retried request.
    const contentKey = ShardedStore.contentKey(url);
    const existing = idempotencyStore.get(contentKey);
    if (existing.value) {
      return { code: existing.value, shortUrl: `/${existing.value}`, deduped: true };
    }

    const code = idGen.next();
    codeStore.put(code, url);
    idempotencyStore.put(contentKey, code);

    reply.code(201);
    return { code, shortUrl: `/${code}`, deduped: false };
  });

  app.get('/api/stats/:code', async (req, reply) => {
    const { code } = req.params;
    const { value } = codeStore.get(code);
    if (!value) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return { code, longUrl: value, clicks: codeStore.getClicks(code) };
  });

  // The hot path. At 10k req/s this handler is the one that matters: it does
  // exactly one cache-aside lookup and, deliberately, does NOT await the
  // click-count write -- fire-and-forget keeps the redirect latency
  // independent of analytics-write latency.
  app.get('/:code', async (req, reply) => {
    const { code } = req.params;
    const { value, cacheHit } = codeStore.get(code);
    cacheHitsTotal.inc({ result: cacheHit ? 'hit' : 'miss', worker: workerLabel });

    if (!value) {
      reply.code(404);
      return { error: 'not_found' };
    }

    setImmediate(() => codeStore.incrClicks(code));

    reply.code(302);
    reply.header('Location', value);
    return '';
  });

  return app;
}

module.exports = { buildApp };

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const app = buildApp({ workerId: 0, logger: true });
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`[worker 0] listening on :${port}`);
  });
}
