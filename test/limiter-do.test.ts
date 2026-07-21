/* eslint-disable @typescript-eslint/require-await --
 * `execute` takes a thunk returning a promise, so these callbacks are `async`
 * by contract rather than because their bodies happen to await something.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMITER_CONFIG,
  envelopeRetryDelay,
  type CallReport,
  type LimiterConfig,
  type LimiterDO,
  type LimiterRpc,
} from '../src/do/index.js';
import {
  BucketDestroyedError,
  DEFAULT_RETRY_OPTIONS,
  type BucketState,
  type RetryContext,
} from '../src/core/index.js';

/**
 * Every test takes its own limiter name, which is the whole point of
 * `idFromName`: independent buckets on one class and one binding. Sharing a
 * name across tests would share the bucket, and the failures would look like
 * flakes.
 */
function stubFor(name: string): DurableObjectStub<LimiterDO> {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
}

/**
 * The same widening a consumer makes when it takes the `script_name` escape
 * hatch and binds the object directly: RPC erases the generics, so `execute`
 * is `never` on the raw stub type.
 */
function limiter(name: string): LimiterRpc {
  return stubFor(name);
}

/** A limiter with room to spare, so a test measures what it means to measure. */
function roomy(patch: Partial<LimiterConfig> = {}): Partial<LimiterConfig> {
  return {
    bucket: { capacity: 50, fillPerWindow: 5000, windowInMs: 60_000 },
    concurrency: 5,
    ...patch,
  };
}

function ok<T>(value: T): CallReport<T> {
  return { value, status: 200 };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('LimiterDO.execute', () => {
  it('runs the callback and returns what it reported', async () => {
    const stub = limiter('execute-basic');
    await expect(stub.execute(async () => ok('hello'))).resolves.toBe('hello');
  });

  it("runs the callback in the CALLER's isolate, not the object's", async () => {
    // The proof that RPC passes a handle rather than serialising: the closure
    // mutates a variable that exists only in this test's heap, and allocates a
    // buffer that never crosses the boundary — only its length does.
    const stub = limiter('execute-isolate');
    let ranHere = false;

    const size = await stub.execute(async () => {
      ranHere = true;
      const payload = new Uint8Array(1024 * 1024);
      return ok(payload.byteLength);
    });

    expect(ranHere).toBe(true);
    expect(size).toBe(1024 * 1024);
  });

  it('paces callers against the shared bucket', async () => {
    // capacity 2, and refill slow enough that the third call must wait for a
    // token rather than being handed one that was already there.
    const stub = limiter('execute-paced');
    await stub.configure({
      bucket: { capacity: 2, fillPerWindow: 10, windowInMs: 1000 },
      concurrency: 5,
    });

    const started = Date.now();
    await Promise.all([
      stub.execute(async () => ok(1)),
      stub.execute(async () => ok(2)),
      stub.execute(async () => ok(3)),
    ]);

    // Two burst tokens are free; the third costs 1/10th of a 1000ms window.
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it('never exceeds the configured concurrency', async () => {
    // The condition under which an in-process cap is most often silently
    // broken: work that finishes at different times. The cap holds only
    // because the object awaits the callback.
    const stub = limiter('execute-concurrency');
    await stub.configure(roomy({ concurrency: 2 }));

    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        stub.execute(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(10 + (index % 3) * 10);
          inFlight--;
          return ok(index);
        })
      )
    );

    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });

  it('retries a rate-limited envelope and applies the delay it asks for', async () => {
    const stub = limiter('execute-429');
    await stub.configure(
      roomy({ retry: { maxRetries: 2, maxDelayInMs: 200, minDelayInMs: 10 } })
    );

    let attempts = 0;
    const started = Date.now();
    const value = await stub.execute(async () => {
      attempts++;
      // `Retry-After: 60` is clamped to maxDelayInMs, so the test asserts real
      // backpressure without waiting a real minute for it.
      return attempts === 1
        ? { value: 'late', status: 429, retryAfter: '60' }
        : ok('late');
    });

    expect(value).toBe('late');
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
  });

  it('retries a thrown error without pausing every other caller', async () => {
    const stub = limiter('execute-throw');
    await stub.configure(
      roomy({ retry: { maxRetries: 2, minDelayInMs: 5, maxDelayInMs: 20 } })
    );

    let attempts = 0;
    await expect(
      stub.execute(async () => {
        attempts++;
        if (attempts === 1)
          throw Object.assign(new Error('blip'), { status: 500 });
        return ok('recovered');
      })
    ).resolves.toBe('recovered');
    expect(attempts).toBe(2);

    // The blip must not have penalised the bucket: a plain error retries only
    // the call that failed.
    await expect(stub.stats()).resolves.toMatchObject({ penalised: false });
  });

  it('returns a non-rate-limited envelope as-is, without retrying', async () => {
    // The envelope, not a throw, is how a caller reports a final HTTP failure.
    // A thrown error loses its `status` crossing RPC (see the test below), so
    // 404 has to arrive as data for the object to treat it as data.
    const stub = limiter('execute-4xx');
    await stub.configure(roomy());

    let attempts = 0;
    const value = await stub.execute(async () => {
      attempts++;
      return { value: 'not found', status: 404 };
    });

    expect(value).toBe('not found');
    expect(attempts).toBe(1);
  });

  it('retries a persistent throw to the policy limit, then rethrows', async () => {
    // Documents the boundary behaviour deliberately: Workers RPC reconstructs
    // a thrown error from name/message/stack only, so properties a caller
    // attaches — `status` included — do NOT arrive. Every throw therefore
    // looks transient to the object and is retried. Callers that want a
    // failure treated as final must report it in the envelope.
    const stub = limiter('execute-throws-always');
    await stub.configure(
      roomy({ retry: { maxRetries: 1, minDelayInMs: 5, maxDelayInMs: 20 } })
    );

    let attempts = 0;
    await expect(
      stub.execute(async () => {
        attempts++;
        throw Object.assign(new Error('nope'), { status: 404 });
      })
    ).rejects.toThrow('nope');
    expect(attempts).toBe(2);
  });
});

describe('LimiterDO and the failure envelope', () => {
  it('rejects on a non-retryable failure instead of resolving with a value', async () => {
    // The regression this contract closes. Before the object read `failure`,
    // this call RESOLVED — the caller got a value where it expected a
    // rejection, and nothing anywhere reported a problem.
    const stub = limiter('failure-final');
    await stub.configure(roomy({ retry: { maxRetries: 3, minDelayInMs: 5 } }));

    let attempts = 0;
    await expect(
      stub.execute(async () => {
        attempts++;
        return {
          value: 'ignored',
          status: 404,
          failure: { message: 'document not found', retryable: false },
        };
      })
    ).rejects.toThrow('document not found (status 404)');
    expect(attempts).toBe(1);
  });

  it('retries a retryable failure, then rejects with the last message', async () => {
    const stub = limiter('failure-retryable');
    await stub.configure(
      roomy({ retry: { maxRetries: 2, minDelayInMs: 5, maxDelayInMs: 20 } })
    );

    let attempts = 0;
    await expect(
      stub.execute(async () => {
        attempts++;
        return {
          value: null,
          status: 503,
          failure: {
            message: `unavailable ${String(attempts)}`,
            retryable: true,
          },
        };
      })
    ).rejects.toThrow('unavailable 3 (status 503)');
    expect(attempts).toBe(3);
  });

  it('recovers when a retryable failure stops failing', async () => {
    const stub = limiter('failure-recovers');
    await stub.configure(
      roomy({ retry: { maxRetries: 2, minDelayInMs: 5, maxDelayInMs: 20 } })
    );

    let attempts = 0;
    await expect(
      stub.execute(async () => {
        attempts++;
        return attempts === 1
          ? {
              value: 'unused',
              status: 503,
              failure: { message: 'unavailable', retryable: true },
            }
          : ok('recovered');
      })
    ).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('does not pause the shared bucket for a non-retryable failure', async () => {
    // A failed call is one caller's problem. Only a rate limit is everyone's.
    const stub = limiter('failure-no-backpressure');
    await stub.configure(roomy({ retry: { maxRetries: 2, minDelayInMs: 5 } }));

    await expect(
      stub.execute(async () => ({
        value: null,
        status: 400,
        failure: { message: 'bad request', retryable: false },
      }))
    ).rejects.toThrow('bad request');

    await expect(stub.stats()).resolves.toMatchObject({ penalised: false });
  });

  it('treats a 429 that also reports a failure as a rate limit first', async () => {
    const stub = limiter('failure-429');
    await stub.configure(
      roomy({ retry: { maxRetries: 1, minDelayInMs: 10, maxDelayInMs: 50 } })
    );

    let attempts = 0;
    const value = await stub.execute(async () => {
      attempts++;
      return attempts === 1
        ? {
            value: 'unused',
            status: 429,
            // Non-retryable, and retried regardless: the rate limit wins.
            failure: { message: 'quota exceeded', retryable: false },
          }
        : ok('through');
    });

    expect(value).toBe('through');
    expect(attempts).toBe(2);
  });

  it('waits the envelope’s retryAfterMs rather than the backoff', async () => {
    const stub = limiter('failure-retry-after-ms');
    // A backoff floor far below the requested delay, so only retryAfterMs can
    // account for the time actually spent.
    await stub.configure(
      roomy({ retry: { maxRetries: 1, minDelayInMs: 1, maxDelayInMs: 5000 } })
    );

    let attempts = 0;
    const started = Date.now();
    const value = await stub.execute(async () => {
      attempts++;
      return attempts === 1
        ? { value: 'late', status: 429, retryAfterMs: 150 }
        : ok('late');
    });

    expect(value).toBe('late');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('LimiterDO.configure', () => {
  it('persists limits so they survive eviction', async () => {
    const stub = limiter('configure-persist');
    const config = roomy({ concurrency: 3 }) as LimiterConfig;
    await stub.configure(config);

    const stored = await runInDurableObject(
      stubFor('configure-persist'),
      async (_instance, state) => state.storage.get<LimiterConfig>('config')
    );
    expect(stored).toEqual(config);

    // And it is the config a rebuilt runtime restores from.
    await expect(stub.stats()).resolves.toMatchObject({ config });
  });

  it('merges a partial patch over the defaults', async () => {
    const stub = limiter('configure-merge');
    await stub.configure({ concurrency: 1 });

    await expect(stub.stats()).resolves.toMatchObject({
      config: { bucket: DEFAULT_LIMITER_CONFIG.bucket, concurrency: 1 },
    });
  });

  it('rejects anyone queued on the limits being replaced', async () => {
    // Honest failure: their wait can never be satisfied under the limits they
    // queued against. The queue is memory-only, so this is the signal callers
    // must be ready to retry on.
    const stub = limiter('configure-queued');
    await stub.configure({
      bucket: { capacity: 1, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });

    const first = stub.execute(async () => ok('first'));
    const queued = stub.execute(async () => ok('queued'));
    await expect(first).resolves.toBe('first');

    await stub.configure(roomy());
    await expect(queued).rejects.toThrow(new BucketDestroyedError().message);
  });

  it('refuses an invalid patch without persisting it', async () => {
    const stub = limiter('configure-invalid');
    await stub.configure(roomy({ concurrency: 4 }));

    await expect(
      stub.configure({
        bucket: { capacity: -1, fillPerWindow: 1, windowInMs: 1 },
      })
    ).rejects.toThrow(/capacity/);

    // Still usable on the last good config, rather than wedged on a written one.
    await expect(stub.stats()).resolves.toMatchObject({
      config: { concurrency: 4 },
    });
  });
});

describe('LimiterDO.stats', () => {
  it('reports tokens, the raw triple and the live config', async () => {
    const stub = limiter('stats-shape');
    await stub.configure(roomy());
    await stub.execute(async () => ok('one'));

    const stats = await stub.stats();
    expect(stats.tokens).toBeGreaterThan(48);
    expect(stats.tokens).toBeLessThanOrEqual(50);
    expect(stats.penalised).toBe(false);
    expect(stats.forcedUntil).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.state.lastRefillAt).toBeGreaterThan(0);
    expect(stats.state).toEqual({
      tokens: stats.tokens,
      lastRefillAt: stats.state.lastRefillAt,
      forcedUntil: 0,
    });
    expect(stats.config.concurrency).toBe(5);
  });

  it('reports the penalty while one is in force', async () => {
    const stub = limiter('stats-penalised');
    await stub.configure(
      roomy({ retry: { maxRetries: 1, maxDelayInMs: 400, minDelayInMs: 10 } })
    );

    let seen = 0;
    const pending = stub.execute(async () => {
      seen++;
      return seen === 1
        ? { value: 'x', status: 429, retryAfter: '60' }
        : ok('x');
    });
    await sleep(50);

    const during = await stub.stats();
    expect(during.penalised).toBe(true);
    expect(during.forcedUntil).toBeGreaterThan(Date.now());
    expect(during.active).toBe(1);

    await expect(pending).resolves.toBe('x');
    await expect(stub.stats()).resolves.toMatchObject({ penalised: false });
  });
});

describe('LimiterDO persistence', () => {
  it('writes bucket state through on every take', async () => {
    const stub = limiter('persist-writes');
    await stub.configure({
      bucket: { capacity: 4, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });
    await stub.execute(async () => ok(1));

    const stored = await runInDurableObject(
      stubFor('persist-writes'),
      async (_instance, state) => state.storage.get<BucketState>('bucket-state')
    );
    expect(stored?.tokens).toBeCloseTo(3, 5);
  });

  it('restores a snapshot instead of handing out a fresh burst', async () => {
    // What eviction looks like: state on disk, no runtime in memory. A limiter
    // that rebuilt at full capacity here would burst against someone else's
    // quota after every idle period.
    const stub = limiter('persist-restore');
    await stub.configure({
      bucket: { capacity: 10, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });
    await runInDurableObject(stubFor('persist-restore'), async (_i, state) => {
      await state.storage.put<BucketState>('bucket-state', {
        tokens: 2,
        lastRefillAt: Date.now(),
        forcedUntil: 0,
      });
    });

    // configure() drops the cached runtime, forcing a restore from storage.
    await stub.configure({ concurrency: 5 });
    const stats = await stub.stats();
    expect(stats.tokens).toBeGreaterThanOrEqual(2);
    expect(stats.tokens).toBeLessThan(3);
  });

  it('does not wedge permanently on a failed restore', async () => {
    // A memoised *rejected* promise would replay the same failure forever
    // without ever retrying the read. Corrupt state has to be recoverable.
    const raw = stubFor('persist-wedge');
    const putConfig = (config: unknown): Promise<void> =>
      runInDurableObject(raw, async (_i, state) => {
        await state.storage.put('config', config);
      });

    await putConfig({
      bucket: { capacity: 0, fillPerWindow: 1, windowInMs: 1 },
      concurrency: 1,
    });
    await expect(
      runInDurableObject(raw, async (instance: LimiterDO) => instance.stats())
    ).rejects.toThrow(/capacity/);

    await putConfig(roomy());
    await expect(
      runInDurableObject(raw, async (instance: LimiterDO) => instance.stats())
    ).resolves.toMatchObject({ config: { concurrency: 5 } });
  });
});

describe('envelopeRetryDelay', () => {
  function context(
    patch: Partial<RetryContext<CallReport<unknown>>> = {}
  ): RetryContext<CallReport<unknown>> {
    return {
      attempt: 1,
      error: undefined,
      result: undefined,
      isRateLimited: true,
      retry: DEFAULT_RETRY_OPTIONS,
      now: Date.parse('2026-07-21T12:00:00Z'),
      ...patch,
    };
  }

  it('takes Retry-After off the envelope in seconds', () => {
    const delay = envelopeRetryDelay(
      context({ result: { value: null, status: 429, retryAfter: '12' } })
    );
    expect(delay).toBe(12_000);
  });

  it('takes retryAfterMs off the envelope as-is', () => {
    const delay = envelopeRetryDelay(
      context({ result: { value: null, status: 429, retryAfterMs: 1234 } })
    );
    expect(delay).toBe(1234);
  });

  it('prefers retryAfterMs when both it and Retry-After are present', () => {
    // The number is what a `rateLimit` hook already had; rounding it into
    // stringified seconds and back would only lose precision.
    const delay = envelopeRetryDelay(
      context({
        result: {
          value: null,
          status: 429,
          retryAfter: '30',
          retryAfterMs: 1500,
        },
      })
    );
    expect(delay).toBe(1500);
  });

  it('takes Retry-After off the envelope as an HTTP-date', () => {
    const delay = envelopeRetryDelay(
      context({
        result: {
          value: null,
          status: 429,
          retryAfter: 'Tue, 21 Jul 2026 12:00:09 GMT',
        },
      })
    );
    expect(delay).toBe(9000);
  });

  it('clamps Retry-After to the ceiling', () => {
    const delay = envelopeRetryDelay(
      context({ result: { value: null, status: 429, retryAfter: '3600' } })
    );
    expect(delay).toBe(DEFAULT_RETRY_OPTIONS.maxDelayInMs);
  });

  it('falls back to backoff when the envelope carries no Retry-After', () => {
    expect(envelopeRetryDelay(context({ attempt: 2 }))).toBe(1000);
    expect(
      envelopeRetryDelay(context({ result: { value: null, retryAfter: null } }))
    ).toBe(DEFAULT_RETRY_OPTIONS.minDelayInMs);
  });

  it('falls back to backoff when Retry-After does not parse', () => {
    expect(
      envelopeRetryDelay(
        context({ result: { value: null, retryAfter: 'soon-ish' } })
      )
    ).toBe(DEFAULT_RETRY_OPTIONS.minDelayInMs);
  });

  it('ignores Retry-After when the policy says not to respect it', () => {
    const delay = envelopeRetryDelay(
      context({
        result: { value: null, retryAfter: '12' },
        retry: { ...DEFAULT_RETRY_OPTIONS, respectRetryAfter: false },
      })
    );
    expect(delay).toBe(DEFAULT_RETRY_OPTIONS.minDelayInMs);
  });
});
