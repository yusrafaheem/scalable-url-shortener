'use strict';

/**
 * Load-test driver for the read path (GET /:code -> 302 redirect), which is
 * the realistic 10k-req/s scenario for a URL shortener: writes (shortening a
 * URL) happen orders of magnitude less often than reads (people clicking the
 * short link). Seeds one code via the API, then hammers the redirect
 * endpoint with autocannon across multiple concurrent connections.
 *
 * Usage: node benchmark/load-test.js [durationSec] [connections]
 */

const autocannon = require('autocannon');

const HOST = process.env.BENCH_HOST || 'http://localhost:3000';
const DURATION = Number(process.argv[2] || 20);
const CONNECTIONS = Number(process.argv[3] || 200);

async function seedCode() {
  const res = await fetch(`${HOST}/api/shorten`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/some/long/path?with=query&params=for-realism' }),
  });
  const body = await res.json();
  if (!body.code) {
    throw new Error(`seeding failed: ${JSON.stringify(body)}`);
  }
  return body.code;
}

async function run() {
  console.log(`Seeding a short code against ${HOST} ...`);
  const code = await seedCode();
  console.log(`Seeded code: ${code}`);
  console.log(`Running autocannon for ${DURATION}s with ${CONNECTIONS} connections against GET /${code}`);

  const result = await autocannon({
    url: `${HOST}/${code}`,
    connections: CONNECTIONS,
    duration: DURATION,
    pipelining: 1,
  });

  const summary = {
    url: `${HOST}/${code}`,
    durationSec: DURATION,
    connections: CONNECTIONS,
    requestsPerSec: {
      average: result.requests.average,
      min: result.requests.min,
      max: result.requests.max,
      stddev: result.requests.stddev,
    },
    latencyMs: {
      average: result.latency.average,
      p50: result.latency.p50,
      p97_5: result.latency.p97_5,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    throughputMBps: (result.throughput.average / (1024 * 1024)).toFixed(2),
    totalRequests: result.requests.total,
    totalErrors: result.errors,
    non2xx: result.non2xx,
    timeouts: result.timeouts,
  };

  console.log('\n=== Benchmark summary ===');
  console.log(JSON.stringify(summary, null, 2));

  return summary;
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
