'use strict';

// ----------------------------------------------------------------------------
// Distributed ID generator, modeled on Twitter's Snowflake algorithm.
//
// At FAANG scale, a single auto-increment counter is a hotspot and a single
// point of failure. Snowflake-style IDs let any worker process (or, in a real
// deployment, any host) mint globally-unique, roughly time-sortable IDs with
// zero coordination and zero shared state -- which is what lets this service
// scale horizontally by just adding more processes/machines.
//
// Layout (63 bits, fits in a JS-safe integer < 2^53 for our timescales):
//   41 bits: milliseconds since a custom epoch   (~69 years of headroom)
//   10 bits: worker id                            (1024 workers)
//   12 bits: per-worker sequence number            (4096 ids/ms/worker)
//
// The resulting integer is base62-encoded into a short, URL-safe code.
// ----------------------------------------------------------------------------

const EPOCH = 1735689600000; // 2025-01-01T00:00:00Z -- arbitrary custom epoch
const WORKER_ID_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER_ID = (1n << WORKER_ID_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function toBase62(n) {
  if (n === 0n) return '0';
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

class ClockMovedBackwardsError extends Error {
  constructor(lastTimestamp, currentTimestamp) {
    super(
      `Clock moved backwards: last timestamp was ${lastTimestamp}, current is ${currentTimestamp}. ` +
      'Refusing to mint an ID that could collide with or precede an already-issued one.'
    );
    this.name = 'ClockMovedBackwardsError';
    this.lastTimestamp = lastTimestamp;
    this.currentTimestamp = currentTimestamp;
  }
}

class SnowflakeGenerator {
  constructor(workerId) {
    const id = BigInt(workerId) & MAX_WORKER_ID;
    if (BigInt(workerId) > MAX_WORKER_ID) {
      throw new Error(`workerId must be <= ${MAX_WORKER_ID}`);
    }
    this.workerId = id;
    this.sequence = 0n;
    this.lastTimestamp = -1n;
  }

  _now() {
    return BigInt(Date.now() - EPOCH);
  }

  next() {
    let timestamp = this._now();

    // Guard against the system clock moving backwards (NTP correction, leap
    // second adjustment, manual clock change, VM migration, etc). Without
    // this check, a backwards jump lets `timestamp < this.lastTimestamp`
    // fall through to the "else" branch below, which resets the sequence to
    // 0 and can mint an ID whose (timestamp, sequence) pair collides with,
    // or sorts before, one already handed out -- silently breaking both the
    // uniqueness and monotonicity guarantees this generator exists to
    // provide. Fail loudly instead of returning a potentially-colliding ID.
    if (timestamp < this.lastTimestamp) {
      throw new ClockMovedBackwardsError(this.lastTimestamp, timestamp);
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // Sequence exhausted for this millisecond -- spin until the clock ticks.
        while (timestamp <= this.lastTimestamp) {
          timestamp = this._now();
        }
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      (timestamp << (WORKER_ID_BITS + SEQUENCE_BITS)) |
      (this.workerId << SEQUENCE_BITS) |
      this.sequence;

    return toBase62(id);
  }
}

module.exports = { SnowflakeGenerator, toBase62, EPOCH, ClockMovedBackwardsError };
