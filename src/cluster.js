'use strict';

const cluster = require('node:cluster');
const os = require('node:os');
const { buildApp } = require('./server');

// ----------------------------------------------------------------------------
// Multi-process horizontal scaling on a single machine.
//
// Node.js is single-threaded per process, so one process tops out around
// what a single CPU core can do. The `cluster` module forks one worker per
// core; the OS kernel load-balances incoming connections across them (SO_
// REUSEPORT-style). This is the same "shared-nothing horizontal scaling"
// pattern used to scale across *machines* behind a load balancer -- doing it
// across cores first is what lets a single box saturate all its CPUs before
// you ever need a second box.
//
// Production equivalent: this process model maps directly onto "N pods
// behind a Kubernetes Service" or "N instances behind an ALB/NLB" -- the
// code doesn't change, only the load balancer moves from the OS to a real
// LB, and shared state (if any) moves from process-local to Redis.
//
// Graceful shutdown: on SIGTERM (what orchestrators send before killing a
// pod/instance), stop accepting new connections but let in-flight requests
// finish -- this is what prevents dropped requests during deploys/scale-
// downs.
// ----------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const WORKER_COUNT = Number(process.env.WORKER_COUNT || os.cpus().length);

if (cluster.isPrimary) {
  console.log(`[primary ${process.pid}] starting ${WORKER_COUNT} workers on :${PORT}`);

  const workers = [];
  for (let i = 0; i < WORKER_COUNT; i++) {
    const worker = cluster.fork({ WORKER_ID: String(i) });
    workers.push(worker);
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[primary] worker ${worker.process.pid} exited (code=${code} signal=${signal}), restarting`);
    if (!worker.exitedAfterDisconnect) {
      cluster.fork({ WORKER_ID: String(worker.id) });
    }
  });

  const shutdown = () => {
    console.log('[primary] SIGTERM received, shutting down workers gracefully');
    for (const w of workers) w.send && w.send('shutdown');
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  const workerId = Number(process.env.WORKER_ID || cluster.worker.id);
  const app = buildApp({ workerId, logger: false });

  app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
    console.log(`[worker ${workerId} pid=${process.pid}] listening on :${PORT}`);
  }).catch((err) => {
    console.error(`[worker ${workerId}] failed to start`, err);
    process.exit(1);
  });

  process.on('message', async (msg) => {
    if (msg === 'shutdown') {
      await app.close();
      process.exit(0);
    }
  });
}
