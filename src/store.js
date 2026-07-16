'use strict';

const { LRUCache } = require('lru-cache');
const crypto = require('crypto');

// ----------------------------------------------------------------------------
// Sharded, cache-aside storage layer.
//
// Why sharded: a single hash map (or a single database) becomes the
// bottleneck under high write concurrency -- every write serializes on one
// lock / one connection pool. Partitioning the keyspace across N independent
// shards (here: N in-memory maps, in production: N database
// partitions/replicas) lets writes proceed in parallel and lets you scale
// storage horizontally by adding shards.
//
// Why cache-aside: each shard is fronted by its own bounded LRU. Reads check
// the cache first (hot path, no lock contention beyond the Map itself) and
// fall back to the "durable" layer on a miss, populating the cache for next
// time. In a real multi-instance deployment this LRU would be swapped for a
// shared Redis/Memcached tier (see README "Scaling beyond one box") so that
// cache hits are shared across all app instances instead of duplicated per
// process -- the interface below (get/set/incr) is the seam where that swap
// happens without touching handler code.
// ----------------------------------------------------------------------------

const SHARD_COUNT = 16;
const CACHE_MAX_ENTRIES_PER_SHARD = 50_000;

function shardIndexFor(key) {
  // FNV-1a style cheap hash -- fast, deterministic, good-enough distribution
  // for partitioning a short alphanumeric key across shards.
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % SHARD_COUNT;
}

class Shard {
  constructor() {
    // The "durable" layer. In production this is a database partition;
    // in-memory here so the whole project runs with zero external
    // infrastructure for the benchmark.
    this.durable = new Map();
    // The "cache" layer in front of it.
    this.cache = new LRUCache({ max: CACHE_MAX_ENTRIES_PER_SHARD });
    this.clicks = new Map();
  }
}

class ShardedStore {
  constructor(shardCount = SHARD_COUNT) {
    this.shards = Array.from({ length: shardCount }, () => new Shard());
    this.shardCount = shardCount;
  }

  _shard(code) {
    return this.shards[shardIndexFor(code) % this.shardCount];
  }

  /** Idempotency: same input URL always maps to the same content hash key,
   * so re-submitting the same long URL doesn't mint a second short code. */
  static contentKey(longUrl) {
    return crypto.createHash('sha256').update(longUrl).digest('hex').slice(0, 16);
  }

  put(code, longUrl) {
    const shard = this._shard(code);
    shard.durable.set(code, longUrl);
    shard.cache.set(code, longUrl);
  }

  get(code) {
    const shard = this._shard(code);
    const cached = shard.cache.get(code);
    if (cached !== undefined) {
      return { value: cached, cacheHit: true };
    }
    const value = shard.durable.get(code);
    if (value !== undefined) {
      shard.cache.set(code, value); // populate cache on miss
    }
    return { value, cacheHit: false };
  }

  /** Fire-and-forget click counter. Deliberately NOT awaited on the read
   * path (see server.js) -- incrementing an analytics counter should never
   * add latency to, or fail, the user-facing redirect. */
  incrClicks(code) {
    const shard = this._shard(code);
    shard.clicks.set(code, (shard.clicks.get(code) || 0) + 1);
  }

  getClicks(code) {
    return this._shard(code).clicks.get(code) || 0;
  }

  size() {
    return this.shards.reduce((sum, s) => sum + s.durable.size, 0);
  }
}

module.exports = { ShardedStore, shardIndexFor, SHARD_COUNT };
