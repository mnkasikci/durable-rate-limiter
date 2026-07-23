import { describe, expect, it, vi } from 'vitest';

import {
  BucketDestroyedError,
  SlidingLogBucket,
  type BucketState,
} from '../src/core/bucket.js';

/**
 * Timing suites use a deliberately short window — 3 per 150ms — so a caller
 * that exhausts a window only waits that long for a grant to age out. Anything
 * that can be asserted without a timer builds its state through `consume` with
 * an explicit `now` and is fully deterministic; only the restore and real-timer
 * suites anchor to `Date.now()`, because the constructor and the queue timer
 * read the wall clock themselves.
 */
const FAST = { limitPerWindow: 3, windowInMs: 150 } as const;

/** A log holding one grant that fills the whole window, dated at `at`. */
function exhausted(at: number = Date.now()): BucketState {
  return { grants: [{ at, amount: FAST.limitPerWindow }], forcedUntil: 0 };
}

describe('option validation', () => {
  // Every comparison against NaN is false, so a range check alone accepts it,
  // and a NaN window turns the queue timer into a CPU-burning hot loop.
  it.each([
    ['limitPerWindow', { limitPerWindow: NaN, windowInMs: 1000 }],
    ['windowInMs', { limitPerWindow: 1, windowInMs: NaN }],
    [
      'penaltyRefillFraction',
      { limitPerWindow: 1, windowInMs: 1000, penaltyRefillFraction: NaN },
    ],
  ])(
    'throws when %s is NaN rather than silently accepting it',
    (_label, options) => {
      expect(() => new SlidingLogBucket(options)).toThrow(TypeError);
    }
  );

  it('throws on Infinity, which range checks also let through unhelpfully', () => {
    expect(
      () => new SlidingLogBucket({ limitPerWindow: Infinity, windowInMs: 1 })
    ).toThrow(TypeError);
  });

  it.each([
    ['zero limitPerWindow', { limitPerWindow: 0, windowInMs: 1000 }],
    ['zero window', { limitPerWindow: 1, windowInMs: 0 }],
    [
      'penaltyRefillFraction above 1',
      { limitPerWindow: 1, windowInMs: 10, penaltyRefillFraction: 1.5 },
    ],
  ])('rejects out-of-range option: %s', (_label, options) => {
    expect(() => new SlidingLogBucket(options)).toThrow(RangeError);
  });

  it('rejects a NaN forcedUntil or grant field, which would poison every later read', () => {
    const now = Date.now();
    expect(
      () =>
        new SlidingLogBucket(FAST, {
          state: { grants: [{ at: now, amount: 1 }], forcedUntil: NaN },
        })
    ).toThrow(TypeError);
    expect(
      () =>
        new SlidingLogBucket(FAST, {
          state: { grants: [{ at: NaN, amount: 1 }], forcedUntil: 0 },
        })
    ).toThrow(TypeError);
    expect(
      () =>
        new SlidingLogBucket(FAST, {
          state: { grants: [{ at: now, amount: NaN }], forcedUntil: 0 },
        })
    ).toThrow(TypeError);
  });

  it('rejects a non-positive grant amount, which would corrupt the running sum', () => {
    const now = Date.now();
    expect(
      () =>
        new SlidingLogBucket(FAST, {
          state: { grants: [{ at: now, amount: 0 }], forcedUntil: 0 },
        })
    ).toThrow(RangeError);
    expect(
      () =>
        new SlidingLogBucket(FAST, {
          state: { grants: [{ at: now, amount: -1 }], forcedUntil: 0 },
        })
    ).toThrow(RangeError);
  });

  it('rejects a non-finite or non-positive consume amount', () => {
    const bucket = new SlidingLogBucket(FAST);
    expect(() => bucket.consume(NaN)).toThrow(TypeError);
    expect(() => bucket.consume(0)).toThrow(RangeError);
    // Larger than the whole window could never be satisfied; failing loudly
    // beats hanging forever in consumeAsync.
    expect(() => bucket.consume(4)).toThrow(RangeError);
    bucket.destroy();
  });

  it('rejects a non-finite clock reading instead of corrupting the log', () => {
    const bucket = new SlidingLogBucket(FAST);
    expect(() => bucket.consume(1, NaN)).toThrow(TypeError);
    bucket.destroy();
  });

  it('rejects a NaN or negative pause, which would otherwise set forcedUntil to NaN', () => {
    const bucket = new SlidingLogBucket(FAST);
    expect(() => {
      bucket.pause(NaN);
    }).toThrow(TypeError);
    expect(() => {
      bucket.pause(-1);
    }).toThrow(RangeError);
    bucket.destroy();
  });
});

describe('the rolling window', () => {
  it('lets a caller rested a full window spend the whole limit at once', () => {
    const t0 = 1_000_000;
    // The motivating case: 100 per minute must let a rested caller send all 100
    // immediately — not a fifth of them.
    const bucket = new SlidingLogBucket({
      limitPerWindow: 100,
      windowInMs: 60_000,
    });

    expect(bucket.consume(100, t0)).toBe(true);
    // Still inside the window a millisecond before the grants age out.
    expect(bucket.consume(1, t0 + 59_999)).toBe(false);
    // One full window on, the log is empty again and the whole limit is free.
    expect(bucket.available(t0 + 60_000)).toBe(100);
    expect(bucket.consume(100, t0 + 60_000)).toBe(true);
    bucket.destroy();
  });

  it('never exceeds the limit in any rolling window', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket({ limitPerWindow: 3, windowInMs: 300 });

    // Three single takes spread across the window fill it.
    expect(bucket.consume(1, t0)).toBe(true);
    expect(bucket.consume(1, t0 + 100)).toBe(true);
    expect(bucket.consume(1, t0 + 200)).toBe(true);

    // Room reopens grant by grant as each ages out: at t0+300 exactly one grant
    // — the oldest, dated t0 — has aged out, freeing exactly one take, so no
    // 300ms span ever holds four.
    expect(bucket.consume(1, t0 + 299)).toBe(false);
    expect(bucket.consume(1, t0 + 300)).toBe(true);
    expect(bucket.consume(1, t0 + 300)).toBe(false);
    bucket.destroy();
  });

  it('frees allowance exactly when the oldest grant ages out', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);

    bucket.consume(2, t0);
    bucket.consume(1, t0 + 50);
    expect(bucket.available(t0 + 100)).toBe(0);

    // The amount-2 grant ages out at t0+150; a millisecond before, still nothing.
    expect(bucket.available(t0 + 149)).toBe(0);
    expect(bucket.available(t0 + 150)).toBe(2);
    // The amount-1 grant ages out at t0+200, restoring the whole limit.
    expect(bucket.available(t0 + 200)).toBe(3);
    bucket.destroy();
  });

  it('keeps a grant that is still inside its window', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.consume(1, t0);
    // A reading inside the window leaves the grant, and so the usage, in place.
    expect(bucket.available(t0 + 50)).toBe(2);
    expect(bucket.getState(t0 + 50).grants).toEqual([{ at: t0, amount: 1 }]);
    bucket.destroy();
  });

  it('resumes the log a snapshot was evicted with, not a fresh window', () => {
    const now = Date.now();
    // Evicted 50ms into a 150ms window with 2 of 3 spent: a cold start must
    // resume that log with the grant intact, not open a full window.
    const snapshot: BucketState = {
      grants: [{ at: now - 50, amount: 2 }],
      forcedUntil: 0,
    };
    const bucket = new SlidingLogBucket(FAST, { state: snapshot });

    expect(bucket.available(now)).toBe(1);
    expect(bucket.consume(2, now)).toBe(false);
    expect(bucket.consume(1, now)).toBe(true);
    bucket.destroy();
  });

  it('drops the oldest grants when a snapshot outsizes a shrunken limit', () => {
    const now = Date.now();
    // Written under a larger limit: three grants summing 10, restored into a
    // bucket whose limit is now 3. Keeping them would refuse every take until
    // enough aged out — a hang. The newest that fit survive; the rest go.
    const snapshot: BucketState = {
      grants: [
        { at: now - 40, amount: 5 },
        { at: now - 20, amount: 3 },
        { at: now - 10, amount: 2 },
      ],
      forcedUntil: 0,
    };
    const bucket = new SlidingLogBucket(FAST, { state: snapshot });

    // 5 + 3 would already overflow, so only the newest amount-2 grant is kept.
    expect(bucket.getState(now).grants).toEqual([{ at: now - 10, amount: 2 }]);
    expect(bucket.available(now)).toBe(1);
    // And it never wedges: the surviving log leaves exactly room for the rest.
    expect(bucket.consume(1, now)).toBe(true);
    bucket.destroy();
  });

  it('defaults a fresh bucket to an empty log and the whole limit', () => {
    const bucket = new SlidingLogBucket(FAST);
    const state = bucket.getState();
    expect(state.grants).toEqual([]);
    expect(state.forcedUntil).toBe(0);
    expect(bucket.available()).toBe(FAST.limitPerWindow);
    bucket.destroy();
  });
});

describe('penalties', () => {
  it('reopens the recovering window at the configured fraction, not full', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket({
      limitPerWindow: 10,
      windowInMs: 1000,
    });

    bucket.pause(500, t0);
    // Nothing may be taken while the penalty stands...
    expect(bucket.consume(1, t0 + 100)).toBe(false);
    expect(bucket.available(t0 + 100)).toBe(0);
    // ...when it lifts the window opens at half the limit, not full...
    expect(bucket.available(t0 + 500)).toBe(5);
    // ...and the full limit only one window after the penalty's end, when the
    // synthetic grant itself ages out.
    expect(bucket.available(t0 + 1500)).toBe(10);
    bucket.destroy();
  });

  it('honours penaltyRefillFraction: 0 for callers wanting the strict behaviour', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket({ ...FAST, penaltyRefillFraction: 0 });
    bucket.pause(100, t0);
    expect(bucket.available(t0 + 100)).toBe(0);
    bucket.destroy();
  });

  it('opens no allowance during a penalty however long it stands', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST, { state: exhausted(t0) });

    bucket.pause(1000, t0);
    // 1000ms is far longer than the 150ms window. If the log aged through the
    // penalty it would open a fresh full one and burst the instant the penalty
    // lifts, defeating the backoff.
    expect(bucket.available(t0 + 999)).toBe(0);
    // The synthetic grant the penalty set opens at half the limit when it lifts.
    expect(bucket.available(t0 + 1000)).toBe(1.5);
    bucket.destroy();
  });

  it('waits for the longest of three concurrent penalties, not the first', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);

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
    const bucket = new SlidingLogBucket(FAST);
    bucket.pause(60_000, t0);
    bucket.pause(1000, t0 + 10);
    expect(bucket.getState(t0).forcedUntil).toBe(t0 + 60_000);
    bucket.destroy();
  });

  it('persists no grant when penaltyRefillFraction is 1, so a restore cannot choke', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket({ ...FAST, penaltyRefillFraction: 1 });
    bucket.pause(100, t0);
    // The whole limit returns the instant the penalty lifts, and a zero-amount
    // synthetic grant — which a restore rejects for being non-positive — is
    // never written: an empty log says the same thing.
    expect(bucket.getState(t0).grants).toEqual([]);
    expect(bucket.available(t0 + 100)).toBe(FAST.limitPerWindow);
    bucket.destroy();
  });

  it('replaces the whole log with the single synthetic grant', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.consume(1, t0);
    bucket.consume(1, t0 + 1);
    bucket.pause(1000, t0 + 2);
    // The earlier grants are gone: a penalty is a hard reset of the log, not an
    // addition to it.
    expect(bucket.getState(t0 + 2).grants).toEqual([
      { at: t0 + 1002, amount: 1.5 },
    ]);
    bucket.destroy();
  });
});

describe('msUntilAvailable', () => {
  it('reports 0 when the amount is already available', () => {
    const bucket = new SlidingLogBucket(FAST);
    expect(bucket.msUntilAvailable(3)).toBe(0);
    bucket.destroy();
  });

  it('waits for the oldest grant to age out when the window is spent', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.consume(3, t0);
    // Nothing more this window; the deficit clears when the grant ages out.
    expect(bucket.msUntilAvailable(1, t0 + 100)).toBe(50);
    bucket.destroy();
  });

  it('walks grants oldest-first when freeing one is not enough', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.consume(1, t0);
    bucket.consume(1, t0 + 30);
    bucket.consume(1, t0 + 60);
    // Freeing the oldest (t0) leaves 2 used and a request for 2 still overflows,
    // so the wait runs to the second grant's expiry: t0 + 30 + 150.
    expect(bucket.msUntilAvailable(2, t0 + 100)).toBe(80);
    bucket.destroy();
  });

  it('returns just the penalty remainder when the recovering window covers it', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.pause(1000, t0);
    // Half the limit waits behind the penalty; only the deadline is left.
    expect(bucket.msUntilAvailable(1, t0 + 250)).toBe(750);
    bucket.destroy();
  });

  it('waits the window after the penalty when the recovering window cannot cover it', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket({ ...FAST, penaltyRefillFraction: 0 });
    bucket.pause(1000, t0);
    // The recovering window opens empty of allowance, so a take waits for the
    // synthetic grant to age out: the penalty end plus a whole window.
    expect(bucket.msUntilAvailable(1, t0 + 400)).toBe(1000 + 150 - 400);
    bucket.destroy();
  });
});

describe('consumeAsync', () => {
  it('resolves true on a spent window rather than ever resolving false', async () => {
    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });

    // A falsy resolution would force every call site into a `while (!await)` spin.
    await expect(bucket.consumeAsync(3)).resolves.toBe(true);
    expect(bucket.available()).toBeLessThan(1);
    bucket.destroy();
  });

  it('resolves synchronously without a timer when the window has room', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const bucket = new SlidingLogBucket(FAST);
    await expect(bucket.consumeAsync(1)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    bucket.destroy();
  });

  it('does not let cheap waiters overtake an expensive head of queue', async () => {
    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });

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
    const bucket = new SlidingLogBucket(FAST);
    bucket.pause(150);

    const started = Date.now();
    await expect(bucket.consumeAsync(1)).resolves.toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    bucket.destroy();
  });

  it('rejects immediately once the bucket is destroyed', async () => {
    const bucket = new SlidingLogBucket(FAST);
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

    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });
    const pending = bucket.consumeAsync(1);

    // Asserted across the synchronous window and then unspied, because these
    // are the *global* timer functions: the test runner schedules timers of
    // its own while we await, and a global spy cannot tell them apart.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(0);
    setSpy.mockRestore();
    clearSpy.mockRestore();

    await pending;

    // And it is gone once the queue drains — a pending timer keeps an idle
    // host from hibernating and bills duration around the clock. `destroy()`
    // clears a live timer, so a silent `destroy()` proves there was none.
    const clearAfter = vi.spyOn(globalThis, 'clearTimeout');
    bucket.destroy();
    expect(clearAfter).toHaveBeenCalledTimes(0);
    clearAfter.mockRestore();
  });

  it('never schedules a repeating tick', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });
    void bucket.consumeAsync(1).catch(() => undefined);
    expect(spy).not.toHaveBeenCalled();
    bucket.destroy();
    spy.mockRestore();
  });

  it('reschedules the single timer when a penalty moves the deadline', async () => {
    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });
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
    const bucket = new SlidingLogBucket(FAST, { state: exhausted() });

    const pending = bucket.consumeAsync(3);
    bucket.destroy();

    // Rejecting is the honest signal that the wait will never be satisfied;
    // resolving false or hanging would both lie to the caller.
    await expect(pending).rejects.toBeInstanceOf(BucketDestroyedError);
    await expect(pending).rejects.toThrow(/destroyed/i);
  });

  it('is a no-op the second time, because consumers call it from a finally', () => {
    const bucket = new SlidingLogBucket(FAST);
    bucket.destroy();
    expect(() => {
      bucket.destroy();
    }).not.toThrow();
  });

  it('refuses further consumption instead of silently handing out allowance', () => {
    const bucket = new SlidingLogBucket(FAST);
    bucket.destroy();
    expect(() => bucket.consume(1)).toThrow(BucketDestroyedError);
  });
});

describe('state reporting', () => {
  it('notifies the owner on every mutation of the persistable pair', () => {
    const t0 = 1_000_000;
    const seen: BucketState[] = [];
    const bucket = new SlidingLogBucket(FAST, {
      onStateChange: (state) => seen.push(state),
    });

    bucket.consume(1, t0);
    bucket.pause(100, t0);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.grants).toEqual([{ at: t0, amount: 1 }]);
    expect(seen[1]?.forcedUntil).toBe(t0 + 100);
    bucket.destroy();
  });

  it('does not notify when the log merely prunes at read time', () => {
    const now = Date.now();
    const seen: BucketState[] = [];
    const bucket = new SlidingLogBucket(FAST, {
      state: { grants: [{ at: now, amount: 3 }], forcedUntil: 0 },
      onStateChange: (state) => seen.push(state),
    });
    // Ageing a grant out is not a take: reclaiming aged-out room must not write
    // through, so only a take or a pause emits.
    bucket.available(now + FAST.windowInMs);
    expect(seen).toEqual([]);
    bucket.destroy();
  });

  it('does not notify when a consume is refused', () => {
    const now = Date.now();
    const onStateChange = vi.fn();
    const bucket = new SlidingLogBucket(FAST, {
      state: { grants: [{ at: now, amount: 3 }], forcedUntil: 0 },
      onStateChange,
    });
    expect(bucket.consume(3, now)).toBe(false);
    expect(onStateChange).not.toHaveBeenCalled();
    bucket.destroy();
  });

  it('works without a callback at all, so the bucket is usable standalone', () => {
    const bucket = new SlidingLogBucket(FAST);
    expect(bucket.consume(1)).toBe(true);
    bucket.destroy();
  });

  it('hands out a copy, so an owner cannot mutate the bucket through it', () => {
    const t0 = 1_000_000;
    const bucket = new SlidingLogBucket(FAST);
    bucket.consume(1, t0);

    const state = bucket.getState(t0);
    state.grants.push({ at: t0, amount: 1 });
    const grant = state.grants[0];
    if (grant !== undefined) grant.amount = 999;

    // Neither the array nor its entries alias anything inside the bucket.
    expect(bucket.getState(t0).grants).toEqual([{ at: t0, amount: 1 }]);
    bucket.destroy();
  });
});
