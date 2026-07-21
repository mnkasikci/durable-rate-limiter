import { describe, expect, it, vi } from 'vitest';

import {
  BucketDestroyedError,
  TokenBucket,
  type BucketState,
} from '../src/core/bucket.js';

/**
 * Timing suites use a deliberately fast bucket — 3 tokens per 300ms window, so
 * one token per 100ms — to keep real-timer tests short. Everything that can be
 * asserted without a timer passes `now` in explicitly and is fully
 * deterministic.
 */
const FAST = { capacity: 3, fillPerWindow: 3, windowInMs: 300 } as const;

describe('option validation', () => {
  // Every comparison against NaN is false, so a range check alone accepts it,
  // and a NaN window turns the queue timer into a CPU-burning hot loop.
  it.each([
    ['capacity', { capacity: NaN, fillPerWindow: 1, windowInMs: 1000 }],
    ['fillPerWindow', { capacity: 1, fillPerWindow: NaN, windowInMs: 1000 }],
    ['windowInMs', { capacity: 1, fillPerWindow: 1, windowInMs: NaN }],
    [
      'initialTokens',
      { capacity: 1, fillPerWindow: 1, windowInMs: 1000, initialTokens: NaN },
    ],
    [
      'penaltyRefillFraction',
      {
        capacity: 1,
        fillPerWindow: 1,
        windowInMs: 1000,
        penaltyRefillFraction: NaN,
      },
    ],
  ])(
    'throws when %s is NaN rather than silently accepting it',
    (_label, options) => {
      expect(() => new TokenBucket(options)).toThrow(TypeError);
    }
  );

  it('throws on Infinity, which range checks also let through unhelpfully', () => {
    expect(
      () =>
        new TokenBucket({ capacity: Infinity, fillPerWindow: 1, windowInMs: 1 })
    ).toThrow(TypeError);
  });

  it.each([
    ['zero capacity', { capacity: 0, fillPerWindow: 1, windowInMs: 1000 }],
    [
      'negative fillPerWindow',
      { capacity: 1, fillPerWindow: -1, windowInMs: 1000 },
    ],
    ['zero window', { capacity: 1, fillPerWindow: 1, windowInMs: 0 }],
    [
      'initialTokens above capacity',
      { capacity: 1, fillPerWindow: 1, windowInMs: 10, initialTokens: 2 },
    ],
    [
      'penaltyRefillFraction above 1',
      {
        capacity: 1,
        fillPerWindow: 1,
        windowInMs: 10,
        penaltyRefillFraction: 1.5,
      },
    ],
  ])('rejects out-of-range option: %s', (_label, options) => {
    expect(() => new TokenBucket(options)).toThrow(RangeError);
  });

  it('rejects a NaN or out-of-range snapshot, which would poison every later read', () => {
    const base = { tokens: 1, lastRefillAt: Date.now(), forcedUntil: 0 };
    expect(
      () => new TokenBucket(FAST, { state: { ...base, tokens: NaN } })
    ).toThrow(TypeError);
    expect(
      () => new TokenBucket(FAST, { state: { ...base, lastRefillAt: NaN } })
    ).toThrow(TypeError);
    expect(
      () => new TokenBucket(FAST, { state: { ...base, forcedUntil: NaN } })
    ).toThrow(TypeError);
    expect(
      () => new TokenBucket(FAST, { state: { ...base, tokens: 99 } })
    ).toThrow(RangeError);
  });

  it('rejects a non-finite or non-positive consume amount', () => {
    const bucket = new TokenBucket(FAST);
    expect(() => bucket.consume(NaN)).toThrow(TypeError);
    expect(() => bucket.consume(0)).toThrow(RangeError);
    // Larger than capacity could never be satisfied; failing loudly beats
    // hanging forever in consumeAsync.
    expect(() => bucket.consume(4)).toThrow(RangeError);
    bucket.destroy();
  });

  it('rejects a non-finite clock reading instead of corrupting the token count', () => {
    const bucket = new TokenBucket(FAST);
    expect(() => bucket.consume(1, NaN)).toThrow(TypeError);
    bucket.destroy();
  });

  it('rejects a NaN or negative pause, which would otherwise set forcedUntil to NaN', () => {
    const bucket = new TokenBucket(FAST);
    expect(() => {
      bucket.pause(NaN);
    }).toThrow(TypeError);
    expect(() => {
      bucket.pause(-1);
    }).toThrow(RangeError);
    bucket.destroy();
  });

  it('accepts independent capacity and rate: 50/min bursting no more than 10', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(
      { capacity: 10, fillPerWindow: 50, windowInMs: 60_000 },
      { state: { tokens: 0, lastRefillAt: t0, forcedUntil: 0 } }
    );
    // 50/min is 1 token per 1.2s, and the burst never exceeds capacity.
    expect(bucket.available(t0 + 1200)).toBeCloseTo(1, 6);
    expect(bucket.available(t0 + 600_000)).toBe(10);
    bucket.destroy();
  });
});

describe('refill', () => {
  it('is fractional over time, not lumpy at window boundaries', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: t0, forcedUntil: 0 },
    });

    // A lumpy implementation would report 0 for the whole window and then 3.
    expect(bucket.available(t0 + 50)).toBeCloseTo(0.5, 6);
    expect(bucket.available(t0 + 100)).toBeCloseTo(1, 6);
    expect(bucket.available(t0 + 250)).toBeCloseTo(2.5, 6);
    bucket.destroy();
  });

  it('never exceeds capacity however long the bucket sat idle', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: t0, forcedUntil: 0 },
    });
    expect(bucket.available(t0 + 10 * 60 * 1000)).toBe(FAST.capacity);
    bucket.destroy();
  });

  it('does not run backwards when a reading is older than the last refill', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 1, lastRefillAt: t0, forcedUntil: 0 },
    });
    expect(bucket.available(t0 - 5000)).toBe(1);
    expect(bucket.getState(t0).lastRefillAt).toBe(t0);
    bucket.destroy();
  });

  it('restores the right count from a snapshot, not a full bucket', () => {
    const t0 = 1_000_000;
    // Evicted with 0 tokens 150ms ago: a cold start must hand out 1.5, not 3.
    const snapshot: BucketState = {
      tokens: 0,
      lastRefillAt: t0 - 150,
      forcedUntil: 0,
    };
    const bucket = new TokenBucket(FAST, { state: snapshot });

    expect(bucket.available(t0)).toBeCloseTo(1.5, 6);
    expect(bucket.consume(2, t0)).toBe(false);
    expect(bucket.consume(1, t0)).toBe(true);
    bucket.destroy();
  });

  it('defaults a fresh bucket to full capacity and starts the clock now', () => {
    const before = Date.now();
    const bucket = new TokenBucket(FAST);
    const state = bucket.getState();
    expect(state.tokens).toBe(FAST.capacity);
    expect(state.forcedUntil).toBe(0);
    expect(state.lastRefillAt).toBeGreaterThanOrEqual(before);
    bucket.destroy();
  });

  it('honours initialTokens for a bucket that must not start full', () => {
    const bucket = new TokenBucket({ ...FAST, initialTokens: 1 });
    expect(bucket.available()).toBe(1);
    bucket.destroy();
  });
});

describe('penalties', () => {
  it('resumes at the configured fraction of capacity, not at capacity', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket({
      capacity: 10,
      fillPerWindow: 10,
      windowInMs: 1000,
    });

    bucket.pause(500, t0);
    // Nothing may be taken while the penalty stands...
    expect(bucket.consume(1, t0 + 100)).toBe(false);
    // ...and when it lifts we are at half capacity, not full. A full burst
    // aimed at an API that just asked for backoff re-trips it immediately.
    expect(bucket.available(t0 + 500)).toBe(5);
    bucket.destroy();
  });

  it('honours penaltyRefillFraction: 0 for callers wanting the strict behaviour', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket({ ...FAST, penaltyRefillFraction: 0 });
    bucket.pause(100, t0);
    expect(bucket.available(t0 + 100)).toBe(0);
    bucket.destroy();
  });

  it('accrues no tokens during a penalty window', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: t0, forcedUntil: 0 },
    });

    bucket.pause(1000, t0);
    // 1000ms is more than three refill windows. If elapsed time were counted
    // through the penalty the bucket would bank tokens while it is supposed to
    // be stopped and burst the instant the penalty lifts.
    expect(bucket.available(t0 + 999)).toBe(1.5);
    expect(bucket.available(t0 + 1000)).toBe(1.5);
    // Accrual restarts from the penalty's end, not from before it began.
    expect(bucket.available(t0 + 1100)).toBeCloseTo(2.5, 6);
    bucket.destroy();
  });

  it('measures elapsed time from the penalty end when a penalty expired between reads', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: t0, forcedUntil: 0 },
    });
    bucket.pause(500, t0);
    // First read after expiry: 100ms past forcedUntil, so exactly one token on
    // top of the 1.5 the penalty left. Measuring from t0 would give 6.
    expect(bucket.available(t0 + 600)).toBeCloseTo(2.5, 6);
    bucket.destroy();
  });

  it('waits for the longest of three concurrent penalties, not the first', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST);

    bucket.pause(5000, t0);
    bucket.pause(60_000, t0);
    bucket.pause(5000, t0);

    // An early-return-if-already-paused implementation would report 5s.
    expect(bucket.getState(t0).forcedUntil).toBe(t0 + 60_000);
    expect(bucket.msUntilAvailable(1, t0)).toBe(60_000);
    expect(bucket.consume(1, t0 + 5001)).toBe(false);
    bucket.destroy();
  });

  it('does not shorten a standing penalty with a nearer deadline', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST);
    bucket.pause(60_000, t0);
    bucket.pause(1000, t0 + 10);
    expect(bucket.getState(t0).forcedUntil).toBe(t0 + 60_000);
    bucket.destroy();
  });
});

describe('msUntilAvailable', () => {
  it('reports 0 when the amount is already available', () => {
    const bucket = new TokenBucket(FAST);
    expect(bucket.msUntilAvailable(3)).toBe(0);
    bucket.destroy();
  });

  it('sizes the wait to the exact deficit', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0.5, lastRefillAt: t0, forcedUntil: 0 },
    });
    // 2 - 0.5 = 1.5 tokens at 100ms each.
    expect(bucket.msUntilAvailable(2, t0)).toBe(150);
    bucket.destroy();
  });

  it('adds the penalty remainder to the deficit', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket({ ...FAST, penaltyRefillFraction: 0 });
    bucket.pause(1000, t0);
    // Nothing until the penalty lifts, then a full token to accrue.
    expect(bucket.msUntilAvailable(1, t0 + 400)).toBe(600 + 100);
    bucket.destroy();
  });

  it('returns just the penalty remainder when tokens already cover the amount', () => {
    const t0 = 1_000_000;
    const bucket = new TokenBucket(FAST);
    bucket.pause(1000, t0);
    // 1.5 tokens are banked behind the penalty; only the deadline is in the way.
    expect(bucket.msUntilAvailable(1, t0 + 250)).toBe(750);
    bucket.destroy();
  });
});

describe('consumeAsync', () => {
  it('resolves true on a drained bucket rather than ever resolving false', async () => {
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });

    // A falsy resolution would force every call site into a `while (!await)` spin.
    await expect(bucket.consumeAsync(3)).resolves.toBe(true);
    expect(bucket.available()).toBeLessThan(1);
    bucket.destroy();
  });

  it('resolves synchronously without a timer when tokens are already there', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const bucket = new TokenBucket(FAST);
    await expect(bucket.consumeAsync(1)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    bucket.destroy();
  });

  it('does not let cheap waiters overtake an expensive head of queue', async () => {
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });

    const order: string[] = [];
    const expensive = bucket
      .consumeAsync(3)
      .then(() => order.push('expensive'));
    const cheapA = bucket.consumeAsync(1).then(() => order.push('cheapA'));
    const cheapB = bucket.consumeAsync(1).then(() => order.push('cheapB'));

    await Promise.all([expensive, cheapA, cheapB]);

    // Scanning for any satisfiable waiter would serve the two cheap callers
    // first — and under sustained load would starve the expensive one forever.
    expect(order).toEqual(['expensive', 'cheapA', 'cheapB']);
    bucket.destroy();
  });

  it('holds waiters through a penalty and releases them after it lifts', async () => {
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });
    bucket.pause(150);

    const started = Date.now();
    await expect(bucket.consumeAsync(1)).resolves.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    bucket.destroy();
  });

  it('rejects immediately once the bucket is destroyed', async () => {
    const bucket = new TokenBucket(FAST);
    bucket.destroy();
    await expect(bucket.consumeAsync(1)).rejects.toBeInstanceOf(
      BucketDestroyedError
    );
    expect(() => {
      bucket.pause(10);
    }).toThrow(BucketDestroyedError);
  });
});

describe('timers', () => {
  it('leaves no timer running when nothing is waiting', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });
    await bucket.consumeAsync(1);

    // Exactly one timer for the whole queue, and it is gone once the queue
    // drains — a pending timer keeps an idle host from hibernating and bills
    // duration around the clock.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(0);

    bucket.destroy();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('never schedules a repeating tick', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });
    void bucket.consumeAsync(1).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
    bucket.destroy();
    spy.mockRestore();
  });

  it('reschedules the single timer when a penalty moves the deadline', async () => {
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const pending = bucket.consumeAsync(1);
    bucket.pause(50);
    expect(clearSpy).toHaveBeenCalled();

    await expect(pending).resolves.toBe(true);
    clearSpy.mockRestore();
    bucket.destroy();
  });
});

describe('destroy', () => {
  it('rejects pending waiters with a distinct error type', async () => {
    const bucket = new TokenBucket(FAST, {
      state: { tokens: 0, lastRefillAt: Date.now(), forcedUntil: 0 },
    });

    const pending = bucket.consumeAsync(3);
    bucket.destroy();

    // Rejecting is the honest signal that the wait will never be satisfied;
    // resolving false or hanging would both lie to the caller.
    await expect(pending).rejects.toBeInstanceOf(BucketDestroyedError);
    await expect(pending).rejects.toThrow(/destroyed/i);
  });

  it('is a no-op the second time, because consumers call it from a finally', () => {
    const bucket = new TokenBucket(FAST);
    bucket.destroy();
    expect(() => {
      bucket.destroy();
    }).not.toThrow();
  });

  it('refuses further consumption instead of silently handing out tokens', () => {
    const bucket = new TokenBucket(FAST);
    bucket.destroy();
    expect(() => bucket.consume(1)).toThrow(BucketDestroyedError);
  });
});

describe('state reporting', () => {
  it('notifies the owner on every mutation of the persistable triple', () => {
    const t0 = 1_000_000;
    const seen: BucketState[] = [];
    const bucket = new TokenBucket(FAST, {
      onStateChange: (state) => seen.push(state),
    });

    bucket.consume(1, t0);
    bucket.pause(100, t0);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.tokens).toBe(2);
    expect(seen[1]?.forcedUntil).toBe(t0 + 100);
    bucket.destroy();
  });

  it('does not notify when a consume is refused', () => {
    const onStateChange = vi.fn();
    const bucket = new TokenBucket(
      { ...FAST, initialTokens: 0 },
      { onStateChange }
    );
    expect(bucket.consume(3, Date.now())).toBe(false);
    expect(onStateChange).not.toHaveBeenCalled();
    bucket.destroy();
  });

  it('works without a callback at all, so the bucket is usable standalone', () => {
    const bucket = new TokenBucket(FAST);
    expect(bucket.consume(1)).toBe(true);
    bucket.destroy();
  });

  it('hands out a copy, so an owner cannot mutate the bucket through it', () => {
    const bucket = new TokenBucket(FAST);
    const state = bucket.getState();
    state.tokens = 999;
    expect(bucket.getState().tokens).toBe(FAST.capacity);
    bucket.destroy();
  });
});

describe('sizing', () => {
  it('delivers capacity + fillPerWindow in the first rolling window, not fillPerWindow', () => {
    const t0 = 1_000_000;
    // 4 burst + 4 per 256ms window. Powers of two so the per-token interval is
    // exact in binary floating point and the count is not an artefact of
    // rounding.
    const options = { capacity: 4, fillPerWindow: 4, windowInMs: 256 };
    const bucket = new TokenBucket(options, {
      state: { tokens: options.capacity, lastRefillAt: t0, forcedUntil: 0 },
    });

    let delivered = 0;
    for (let ms = 0; ms <= options.windowInMs; ms += 8) {
      while (bucket.consume(1, t0 + ms)) delivered++;
    }

    // The burst is spent immediately and the sustained rate refills on top of
    // it. Any doc or default implying the rate alone bounds throughput is a bug.
    expect(delivered).toBe(options.capacity + options.fillPerWindow);
    bucket.destroy();
  });
});
