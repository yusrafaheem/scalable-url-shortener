'use strict';

// ----------------------------------------------------------------------------
// Per-client token-bucket rate limiter.
//
// At high throughput, a small number of misbehaving or compromised clients
// can starve everyone else. A token bucket per client key (here: IP address;
// in production you'd key on API key / auth subject instead) lets each
// client burst up to `capacity` requests and then refills at `refillPerSec`
// tokens/sec -- smoothing load without hard-cutting legitimate traffic.
//
// This is process-local (each worker enforces its own bucket), which is the
// right tradeoff for this project: it protects each process from being
// individually overwhelmed without adding a cross-process coordination
// round-trip (e.g. to Redis) on the hot path. A global limit across all
// instances would need a shared counter (Redis INCR + TTL, or a sliding-
// window log in Redis) -- noted in the README as the production extension.
// ----------------------------------------------------------------------------

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.lastRefill = Date.now();
  }

  tryConsume() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = now;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

class RateLimiter {
  constructor({ capacity, refillPerSec, maxBuckets = 100_000 }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    this.maxBuckets = maxBuckets;
  }

  allow(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Bound memory: evict the oldest bucket if we're at capacity. In
      // production this map would have a TTL/reaper sweep; kept simple here.
      if (this.buckets.size >= this.maxBuckets) {
        const oldestKey = this.buckets.keys().next().value;
        this.buckets.delete(oldestKey);
      }
      bucket = new TokenBucket(this.capacity, this.refillPerSec);
      this.buckets.set(key, bucket);
    }
    return bucket.tryConsume();
  }
}

module.exports = { RateLimiter, TokenBucket };
