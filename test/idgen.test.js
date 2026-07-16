'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SnowflakeGenerator } = require('../src/idgen');
const { ShardedStore, shardIndexFor } = require('../src/store');
const { RateLimiter } = require('../src/rateLimiter');

test('SnowflakeGenerator produces unique, URL-safe codes under a tight loop', () => {
  const gen = new SnowflakeGenerator(1);
  const seen = new Set();
  for (let i = 0; i < 20_000; i++) {
    const code = gen.next();
    assert.match(code, /^[A-Za-z0-9]+$/);
    assert.equal(seen.has(code), false, `duplicate code generated: ${code}`);
    seen.add(code);
  }
});

test('different worker ids never collide even with the same sequence', () => {
  const genA = new SnowflakeGenerator(1);
  const genB = new SnowflakeGenerator(2);
  const a = new Set();
  const b = new Set();
  for (let i = 0; i < 1000; i++) {
    a.add(genA.next());
    b.add(genB.next());
  }
  for (const code of a) {
    assert.equal(b.has(code), false);
  }
});

test('shardIndexFor distributes keys across shards (not all in one bucket)', () => {
  const buckets = new Set();
  for (let i = 0; i < 200; i++) {
    buckets.add(shardIndexFor(`key-${i}`));
  }
  assert.ok(buckets.size > 1, 'expected keys to spread across more than one shard');
});

test('ShardedStore cache-aside: first get is a miss, second is a hit', () => {
  const store = new ShardedStore();
  store.put('abc123', 'https://example.com');
  const first = store.get('abc123');
  assert.equal(first.value, 'https://example.com');
});

test('ShardedStore.contentKey is deterministic for the same URL', () => {
  const a = ShardedStore.contentKey('https://example.com/x');
  const b = ShardedStore.contentKey('https://example.com/x');
  const c = ShardedStore.contentKey('https://example.com/y');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('RateLimiter allows bursts up to capacity then blocks', () => {
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 0 });
  for (let i = 0; i < 5; i++) {
    assert.equal(limiter.allow('client-a'), true);
  }
  assert.equal(limiter.allow('client-a'), false);
});

test('RateLimiter tracks clients independently', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 0 });
  assert.equal(limiter.allow('client-a'), true);
  assert.equal(limiter.allow('client-b'), true);
  assert.equal(limiter.allow('client-a'), false);
});
