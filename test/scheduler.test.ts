import { describe, expect, it, vi } from 'vitest';

import { TokenBucket } from '../src/core/bucket.js';
import {
  CallFailedError,
  DEFAULT_CONCURRENCY,
  Scheduler,
  createStatusClassifier,
  defaultRetryDelay,
  exponentialBackoff,
  readRetryAfterMs,
  type Bucket,
  type ResultClassifier,
  type ResultVerdict,
  type RetryOptions,
} from '../src/core/scheduler.js';

/** A bucket that never throttles and records every pause. */
function openBucket(): Bucket & { pauses: number[] } {
  const pauses: number[] = [];
  return {
    pauses,
    consumeAsync: () => Promise.resolve(true as const),
    pause: (ms) => pauses.push(ms),
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Nothing waits long enough to matter, so tests stay fast. */
const FAST_RETRY: Partial<RetryOptions> = {
  minDelayInMs: 1,
  maxDelayInMs: 4,
  factor: 2,
};

describe('concurrency', () => {
  // The single easiest thing to get silently wrong: releasing the slot in a
  // `finally` around a non-awaited call frees it a microtask after the task
  // *starts*, so the cap bounds nothing. Only peak overlap can see it.
  it('never lets peak observed overlap exceed the configured concurrency', async () => {
    const scheduler = new Scheduler({ bucket: openBucket(), concurrency: 2 });

    let inFlight = 0;
    let peak = 0;
    const task = async (): Promise<number> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Variable latency: a rate-based cap only diverges from a concurrency
      // cap when the upstream is slow and uneven.
      await sleep(10 + Math.floor(Math.random() * 20));
      inFlight--;
      return inFlight;
    };

    await Promise.all(
      Array.from({ length: 6 }, () => scheduler.call<number>(task))
    );

    expect(peak).toBe(2);
    expect(scheduler.active).toBe(0);
  });

  it('releases the slot when the call ultimately fails', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      concurrency: 1,
      retry: { maxRetries: 0 },
    });

    await expect(
      scheduler.call(() => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
    expect(scheduler.active).toBe(0);

    await expect(scheduler.call(() => Promise.resolve('ok'))).resolves.toBe(
      'ok'
    );
    expect(scheduler.active).toBe(0);
  });

  it('defaults the cap to 5 and admits that many at once', async () => {
    const scheduler = new Scheduler({ bucket: openBucket() });
    let peak = 0;
    let inFlight = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        scheduler.call(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await sleep(5);
          inFlight--;
          return 1;
        })
      )
    );

    expect(peak).toBe(DEFAULT_CONCURRENCY);
  });
});

describe('option merging', () => {
  it('backs off from the default floor when only maxRetries is supplied', async () => {
    const delays: number[] = [];
    const scheduler = new Scheduler({
      bucket: openBucket(),
      // Partial options merged, not swapped in: leaving minDelayInMs undefined
      // would make every delay NaN, which setTimeout treats as 0.
      retry: { maxRetries: 2 },
      retryDelay: (context) => {
        const delay = exponentialBackoff(context.attempt, context.retry);
        delays.push(delay);
        return 0; // do not actually wait
      },
    });

    await expect(
      scheduler.call(() => Promise.reject(new Error('flaky')))
    ).rejects.toThrow('flaky');

    expect(delays).toEqual([500, 1000]);
    expect(delays.every(Number.isFinite)).toBe(true);
  });

  it.each([
    ['concurrency', { concurrency: 0 }],
    ['concurrency', { concurrency: NaN }],
    ['retry.maxRetries', { retry: { maxRetries: -1 } }],
    ['retry.minDelayInMs', { retry: { minDelayInMs: NaN } }],
    ['retry.maxDelayInMs', { retry: { maxDelayInMs: Infinity } }],
    ['retry.factor', { retry: { factor: 0.5 } }],
  ])('rejects an invalid %s', (_label, overrides) => {
    expect(() => new Scheduler({ bucket: openBucket(), ...overrides })).toThrow(
      RangeError
    );
  });
});

describe('backpressure', () => {
  // A rate limit throttles every caller; an error retries only the call that
  // failed. Putting pause() in the delay calculator conflates the two.
  it('does not pause the shared bucket when a non-429 error is thrown', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });

    await expect(
      scheduler.call(() => Promise.reject(new Error('network blip')))
    ).rejects.toThrow('network blip');

    expect(bucket.pauses).toEqual([]);
  });

  it('pauses the shared bucket when a result is classified rate-limited', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler<{ status: number }>({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 1 },
    });

    const result = await scheduler.call(() => Promise.resolve({ status: 429 }));

    expect(result).toEqual({ status: 429 });
    expect(bucket.pauses).toEqual([1]);
  });

  it('pauses the shared bucket when an error is classified rate-limited', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 1 },
    });
    const calls: number[] = [];

    await expect(
      scheduler.call(() => {
        calls.push(1);
        return Promise.reject(
          Object.assign(new Error('slow down'), {
            status: 429,
          })
        );
      })
    ).rejects.toThrow('slow down');

    expect(calls).toHaveLength(2);
    expect(bucket.pauses).toEqual([1]);
  });

  it('waits out a rate limit through the real bucket, not a private timer', async () => {
    const bucket = new TokenBucket({
      capacity: 5,
      fillPerWindow: 5,
      windowInMs: 50,
    });
    const scheduler = new Scheduler({
      bucket,
      retry: { maxRetries: 1, minDelayInMs: 30, maxDelayInMs: 30 },
    });

    let attempts = 0;
    const started = Date.now();
    await scheduler.call(() => {
      attempts++;
      return Promise.resolve({ status: attempts === 1 ? 429 : 200 });
    });

    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    bucket.destroy();
  });
});

describe('retry and classification', () => {
  it('takes a token before every attempt, not just the first', async () => {
    const taken: number[] = [];
    const bucket: Bucket = {
      consumeAsync: (amount) => {
        taken.push(amount);
        return Promise.resolve(true as const);
      },
      pause: () => undefined,
    };
    const scheduler = new Scheduler({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });

    await expect(
      scheduler.call(() => Promise.reject(new Error('nope')))
    ).rejects.toThrow('nope');

    expect(taken).toEqual([1, 1, 1]);
  });

  it('retries a 429 error and eventually succeeds', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 3 },
    });

    let attempts = 0;
    const value = await scheduler.call(() => {
      attempts++;
      if (attempts < 3) {
        return Promise.reject(Object.assign(new Error('429'), { status: 429 }));
      }
      return Promise.resolve('done');
    });

    expect(value).toBe('done');
    expect(attempts).toBe(3);
  });

  it('does not retry a 403', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 3 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.reject(
          Object.assign(new Error('forbidden'), { status: 403 })
        );
      })
    ).rejects.toThrow('forbidden');

    expect(attempts).toBe(1);
  });

  it('reads a nested response.status', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 3 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.reject(
          Object.assign(new Error('gone'), { response: { status: 404 } })
        );
      })
    ).rejects.toThrow('gone');

    expect(attempts).toBe(1);
  });

  it('retries a numeric code: 404 by default — it may not be an HTTP status', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.reject(Object.assign(new Error('grpc'), { code: 404 }));
      })
    ).rejects.toThrow('grpc');

    expect(attempts).toBe(2);
  });

  it('honours code: 404 once the opt-in is set', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: createStatusClassifier({ trustNumericErrorCode: true }),
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.reject(Object.assign(new Error('http'), { code: 404 }));
      })
    ).rejects.toThrow('http');

    expect(attempts).toBe(1);
  });

  it.each([
    ['a non-object error', 'just a string'],
    ['a 500', Object.assign(new Error('server'), { status: 500 })],
    ['a non-numeric status', Object.assign(new Error('odd'), { status: 'x' })],
    [
      'a non-numeric nested status',
      Object.assign(new Error('odd'), { response: { status: 'x' } }),
    ],
    ['a non-object response', Object.assign(new Error('odd'), { response: 7 })],
  ])('retries %s', async (_label, thrown) => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- real code throws non-Errors and the classifier must cope
        return Promise.reject(thrown);
      })
    ).rejects.toBeDefined();

    expect(attempts).toBe(2);
  });

  it('ignores a numeric code on a *result*, which is never a status', async () => {
    const scheduler = new Scheduler<{ code: number }>({
      bucket: openBucket(),
      classify: createStatusClassifier({ trustNumericErrorCode: true }),
    });

    await expect(
      scheduler.call(() => Promise.resolve({ code: 429 }))
    ).resolves.toEqual({ code: 429 });
  });

  it('surfaces the final attempt’s failure, not an earlier one', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.reject(new Error(`failure ${String(attempts)}`));
      })
    ).rejects.toThrow('failure 3');
  });

  it('surfaces the last result when the final attempt did not throw', async () => {
    const scheduler = new Scheduler<{ status: number; n: number }>({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.resolve({ status: 429, n: attempts });
      })
    ).resolves.toEqual({ status: 429, n: 3 });
  });

  it('surfaces the error when a later attempt throws after a rate-limited result', async () => {
    const scheduler = new Scheduler<unknown>({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        if (attempts === 1) return Promise.resolve({ status: 429 });
        return Promise.reject(new Error('then it broke'));
      })
    ).rejects.toThrow('then it broke');
  });

  it('treats an omitted isRateLimited on a result as not rate-limited', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler<string>({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: {
        classifyResult: () => ({}),
        classifyError: () => ({}),
      },
    });

    await expect(scheduler.call(() => Promise.resolve('fine'))).resolves.toBe(
      'fine'
    );
    expect(bucket.pauses).toEqual([]);
  });

  it('uses a custom classifier for both results and errors', async () => {
    const scheduler = new Scheduler<string>({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: {
        classifyResult: (result) => ({ isRateLimited: result === 'slow' }),
        classifyError: () => ({}),
      },
    });

    await expect(scheduler.call(() => Promise.resolve('slow'))).resolves.toBe(
      'slow'
    );
  });

  it('clamps a nonsensical calculator delay instead of passing NaN to setTimeout', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { maxRetries: 1 },
      retryDelay: () => NaN,
    });

    const started = Date.now();
    await expect(
      scheduler.call(() => Promise.reject(new Error('x')))
    ).rejects.toThrow('x');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('failed verdicts', () => {
  /**
   * A plain classifier stub, not an envelope: the core knows nothing about
   * `CallReport` and these tests are the guarantee that it stays that way.
   */
  function verdictClassifier(
    verdict: ResultVerdict
  ): ResultClassifier<unknown> {
    return {
      classifyResult: () => verdict,
      classifyError: () => ({}),
    };
  }

  it('rejects immediately on a non-retryable failure, after exactly one attempt', async () => {
    // The regression this whole contract exists for: without `failed`, this
    // resolves with the result as though it had succeeded.
    const bucket = openBucket();
    const scheduler = new Scheduler<unknown>({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 3 },
      classify: verdictClassifier({
        failed: true,
        retryable: false,
        message: 'not found',
      }),
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.resolve({ status: 404 });
      })
    ).rejects.toThrow(CallFailedError);

    expect(attempts).toBe(1);
    expect(bucket.pauses).toEqual([]);
  });

  it('puts the status in the message, because RPC strips the property', async () => {
    const scheduler = new Scheduler<unknown>({
      bucket: openBucket(),
      retry: { maxRetries: 0 },
      classify: verdictClassifier({
        failed: true,
        retryable: false,
        message: 'not found',
      }),
    });

    const error = await scheduler
      .call(() => Promise.resolve({ status: 404 }))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CallFailedError);
    expect((error as CallFailedError).status).toBe(404);
    expect((error as CallFailedError).message).toBe('not found (status 404)');
    expect((error as CallFailedError).name).toBe('CallFailedError');
  });

  it('retries a retryable failure to the limit, then rejects', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler<unknown>({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 2 },
      classify: verdictClassifier({
        failed: true,
        retryable: true,
        message: 'upstream is unwell',
      }),
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.resolve({ status: 503 });
      })
    ).rejects.toThrow('upstream is unwell (status 503)');

    expect(attempts).toBe(3);
    // A failure that is not a rate limit is this call's problem alone.
    expect(bucket.pauses).toEqual([]);
  });

  it('treats a failure that is also rate-limited as a rate limit first', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler<unknown>({
      bucket,
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: verdictClassifier({
        isRateLimited: true,
        failed: true,
        // Non-retryable, and retried anyway: a 429 is a rate limit before it
        // is anything else, so it pauses and tries again.
        retryable: false,
        message: 'slow down',
      }),
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        return Promise.resolve({ status: 429 });
      })
    ).rejects.toThrow('slow down');

    expect(attempts).toBe(2);
    expect(bucket.pauses).toEqual([1]);
  });

  it('returns the result unchanged when the verdict does not say failed', async () => {
    const scheduler = new Scheduler<unknown>({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: verdictClassifier({ failed: false, message: 'ignored' }),
    });

    await expect(
      scheduler.call(() => Promise.resolve({ status: 200 }))
    ).resolves.toEqual({ status: 200 });
  });

  it('still rejects usefully when the verdict carries no message', async () => {
    const scheduler = new Scheduler<unknown>({
      bucket: openBucket(),
      retry: { maxRetries: 0 },
      classify: verdictClassifier({ failed: true }),
    });

    // No message, and no status to append either.
    await expect(scheduler.call(() => Promise.resolve('bare'))).rejects.toThrow(
      'the call failed'
    );
  });

  it('surfaces a later throw rather than an earlier failed verdict', async () => {
    // `failure` must not outlive the attempt that produced it: the throw is
    // the more recent, and therefore the more honest, outcome.
    const scheduler = new Scheduler<unknown>({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 1 },
      classify: {
        classifyResult: () => ({
          failed: true,
          retryable: true,
          message: 'first',
        }),
        classifyError: () => ({}),
      },
    });

    let attempts = 0;
    await expect(
      scheduler.call(() => {
        attempts++;
        if (attempts === 1) return Promise.resolve({ status: 500 });
        return Promise.reject(new Error('then it broke'));
      })
    ).rejects.toThrow('then it broke');
  });
});

describe('Retry-After', () => {
  const now = Date.parse('Wed, 21 Oct 2026 07:26:00 GMT');

  it('prefers a numeric retryAfterMs over headers', () => {
    expect(readRetryAfterMs({ retryAfterMs: 1234 }, now)).toBe(1234);
    expect(readRetryAfterMs({ response: { retryAfterMs: 99 } }, now)).toBe(99);
    expect(readRetryAfterMs({ retryAfterMs: -5 }, now)).toBe(0);
    expect(readRetryAfterMs({ retryAfterMs: NaN, headers: {} }, now)).toBe(
      undefined
    );
  });

  it.each([
    [
      'integer seconds in a Headers object',
      { headers: new Headers({ 'retry-after': '120' }) },
      120_000,
    ],
    [
      'integer seconds in a plain object',
      { headers: { 'Retry-After': '120' } },
      120_000,
    ],
    [
      'an HTTP-date in a Headers object',
      {
        headers: new Headers({
          'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT',
        }),
      },
      120_000,
    ],
    [
      'an HTTP-date in a plain object',
      { headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
      120_000,
    ],
    [
      'headers hanging off a nested response',
      { response: { headers: { 'Retry-After': '5' } } },
      5000,
    ],
  ])('parses %s', (_label, source, expected) => {
    expect(readRetryAfterMs(source, now)).toBe(expected);
  });

  it('clamps a date already in the past to zero', () => {
    expect(
      readRetryAfterMs(
        { headers: { 'Retry-After': 'Wed, 21 Oct 2020 07:28:00 GMT' } },
        now
      )
    ).toBe(0);
  });

  it.each([
    ['a non-object source', 'nope'],
    ['no retry information at all', { status: 429 }],
    ['an unparseable value', { headers: { 'Retry-After': 'soon' } }],
    ['a non-string header value', { headers: { 'Retry-After': 5 } }],
    ['an absent Headers entry', { headers: new Headers() }],
    [
      'a Headers-like get returning a non-string',
      { headers: { get: () => 5 } },
    ],
    ['an unrelated header', { headers: { 'X-Other': '1' } }],
  ])('returns undefined for %s', (_label, source) => {
    expect(readRetryAfterMs(source, now)).toBe(undefined);
  });

  it('falls back to exponential backoff when nothing parses', () => {
    const retry = {
      maxRetries: 3,
      minDelayInMs: 100,
      maxDelayInMs: 1000,
      factor: 2,
      respectRetryAfter: true,
    };

    expect(
      defaultRetryDelay({
        attempt: 3,
        error: new Error('x'),
        result: undefined,
        isRateLimited: false,
        retry,
        now,
      })
    ).toBe(400);

    // Ceiling applies to the exponential...
    expect(exponentialBackoff(9, retry)).toBe(1000);

    // ...and to an over-long Retry-After.
    expect(
      defaultRetryDelay({
        attempt: 1,
        error: undefined,
        result: { headers: { 'Retry-After': '600' } },
        isRateLimited: true,
        retry,
        now,
      })
    ).toBe(1000);

    // Opting out ignores Retry-After entirely.
    expect(
      defaultRetryDelay({
        attempt: 1,
        error: { retryAfterMs: 50 },
        result: undefined,
        isRateLimited: true,
        retry: { ...retry, respectRetryAfter: false },
        now,
      })
    ).toBe(100);
  });

  it('drives the retry wait from a Retry-After header end to end', async () => {
    const bucket = openBucket();
    const scheduler = new Scheduler({
      bucket,
      retry: { maxRetries: 1, maxDelayInMs: 30_000 },
    });

    await expect(
      scheduler.call(() =>
        Promise.reject(
          Object.assign(new Error('limited'), {
            status: 429,
            headers: new Headers({ 'retry-after': '7' }),
          })
        )
      )
    ).rejects.toThrow('limited');

    expect(bucket.pauses).toEqual([7000]);
  });
});

describe('the fn contract', () => {
  it('re-invokes fn from scratch, so a fresh request is built each attempt', async () => {
    const scheduler = new Scheduler({
      bucket: openBucket(),
      retry: { ...FAST_RETRY, maxRetries: 2 },
    });
    const fn = vi.fn(() => Promise.reject(new Error('retry me')));

    await expect(scheduler.call(fn)).rejects.toThrow('retry me');

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
