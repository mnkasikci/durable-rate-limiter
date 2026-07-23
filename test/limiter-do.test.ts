/* eslint-disable @typescript-eslint/require-await --
 * `execute` takes a thunk returning a promise, so these callbacks are `async`
 * by contract rather than because their bodies happen to await something.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  REGISTRY_NAME,
  envelopeRetryDelay,
  type CallReport,
  type LimiterConfig,
  type LimiterDO,
  type LimiterRpc,
} from '../src/do/index.js';
import {
  BucketDestroyedError,
  DEFAULT_RETRY_OPTIONS,
  isNoSuchLimiter,
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
 * A stub with its own name bound into `configure`, exactly as
 * `LimiterEntrypoint` binds it — the object cannot recover the name it was
 * addressed by, so somebody has to carry it, and here that is this helper
 * rather than thirty call sites repeating themselves.
 */
type NamedLimiter = Omit<LimiterRpc, 'configure'> & {
  configure(config: LimiterConfig): Promise<void>;
};

/**
 * The same widening a consumer makes when it takes the `script_name` escape
 * hatch and binds the object directly: RPC erases the generics, so `execute`
 * is `never` on the raw stub type.
 */
function limiter(name: string): NamedLimiter {
  const stub: LimiterRpc = stubFor(name);
  return {
    execute: <T>(fn: () => Promise<CallReport<T>>) => stub.execute(fn),
    stats: () => stub.stats(),
    listNames: () => stub.listNames(),
    registerName: (recorded: string) => stub.registerName(recorded),
    unregisterName: (recorded: string) => stub.unregisterName(recorded),
    reconfigure: (patch: Partial<LimiterConfig>) => stub.reconfigure(patch),
    configure: (config: LimiterConfig) => stub.configure(name, config),
  };
}

/**
 * A limiter with room to spare, so a test measures what it means to measure.
 *
 * Complete rather than partial: `configure` takes a whole config, because there
 * is no default to merge a fragment onto.
 */
function roomy(patch: Partial<LimiterConfig> = {}): LimiterConfig {
  return {
    bucket: { limitPerWindow: 5000, windowInMs: 60_000 },
    concurrency: 5,
    ...patch,
  };
}

function ok<T>(value: T): CallReport<T> {
  return { value, status: 200 };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Let the first `calls` writes through, then fail every one after.
 *
 * The only way to reach `configure`'s failure paths: a Durable Object's own
 * storage does not fail on demand, and the half-written state those paths exist
 * to clean up cannot be produced any other way.
 */
function breakWritesAfter(state: DurableObjectState, calls: number): void {
  const original = state.storage.put.bind(state.storage);
  let seen = 0;
  (state.storage as unknown as { put: unknown }).put = async (
    ...args: unknown[]
  ): Promise<void> => {
    seen += 1;
    if (seen > calls) throw new Error('storage boom');
    return (original as (...rest: unknown[]) => Promise<void>)(...args);
  };
}

describe('LimiterDO.execute', () => {
  it('runs the callback and returns what it reported', async () => {
    const stub = limiter('execute-basic');
    await stub.configure(roomy());
    await expect(stub.execute(async () => ok('hello'))).resolves.toBe('hello');
  });

  it("runs the callback in the CALLER's isolate, not the object's", async () => {
    // The proof that RPC passes a handle rather than serialising: the closure
    // mutates a variable that exists only in this test's heap, and allocates a
    // buffer that never crosses the boundary — only its length does.
    const stub = limiter('execute-isolate');
    await stub.configure(roomy());
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
    // A window of 2, so the third call in the same window must wait for it to
    // roll rather than being handed an allowance that was already spent.
    const stub = limiter('execute-paced');
    await stub.configure({
      bucket: { limitPerWindow: 2, windowInMs: 100 },
      concurrency: 5,
    });

    const started = Date.now();
    await Promise.all([
      stub.execute(async () => ok(1)),
      stub.execute(async () => ok(2)),
      stub.execute(async () => ok(3)),
    ]);

    // Two spend the window; the third waits for the 100ms window to roll.
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
    const config = roomy({ concurrency: 3 });
    await stub.configure(config);

    const stored = await runInDurableObject(
      stubFor('configure-persist'),
      async (_instance, state) => state.storage.get<LimiterConfig>('config')
    );
    expect(stored).toEqual(config);

    // And it is the config a rebuilt runtime restores from.
    await expect(stub.stats()).resolves.toMatchObject({ config });
  });

  it('merges a reconfigure patch over what is already in force', async () => {
    const stub = limiter('configure-merge');
    const bucket = { limitPerWindow: 11, windowInMs: 60_000 };
    await stub.configure({ bucket, concurrency: 9 });

    await stub.reconfigure({ concurrency: 1 });

    // The untouched half survives, and it comes from the bucket's own previous
    // config — there is no default for it to have come from.
    await expect(stub.stats()).resolves.toMatchObject({
      config: { bucket, concurrency: 1 },
    });
  });

  it('refuses to patch a bucket that does not exist', async () => {
    // The half-specified bucket `configure` will not create cannot be smuggled
    // in through the back door either.
    await expect(
      limiter('configure-patch-nothing').reconfigure({ concurrency: 1 })
    ).rejects.toThrow(/never been configured|No such limiter/);
  });

  it('rejects anyone queued on the limits being replaced', async () => {
    // Honest failure: their wait can never be satisfied under the limits they
    // queued against. The queue is memory-only, so this is the signal callers
    // must be ready to retry on.
    const stub = limiter('configure-queued');
    await stub.configure({
      bucket: { limitPerWindow: 1, windowInMs: 600_000 },
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
      stub.configure(roomy({ bucket: { limitPerWindow: -1, windowInMs: 1 } }))
    ).rejects.toThrow(/limitPerWindow/);

    // Still usable on the last good config, rather than wedged on a written one.
    await expect(stub.stats()).resolves.toMatchObject({
      config: { concurrency: 4 },
    });
  });
});

describe('LimiterDO.stats', () => {
  it('reports the remaining allowance, the raw log and the live config', async () => {
    const stub = limiter('stats-shape');
    await stub.configure(roomy());
    await stub.execute(async () => ok('one'));

    const stats = await stub.stats();
    // One call taken out of a 5000 window.
    expect(stats.remaining).toBe(4999);
    const grant = stats.state.grants[0];
    expect(grant?.amount).toBe(1);
    expect(grant?.at).toBeGreaterThan(0);
    // resetAt is the newest grant's expiry: the moment the full limit returns.
    expect(stats.resetAt).toBe((grant?.at ?? 0) + 60_000);
    expect(stats.penalised).toBe(false);
    expect(stats.forcedUntil).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.state).toEqual({
      grants: [{ at: grant?.at, amount: 1 }],
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
      bucket: { limitPerWindow: 4, windowInMs: 600_000 },
      concurrency: 5,
    });
    await stub.execute(async () => ok(1));

    const stored = await runInDurableObject(
      stubFor('persist-writes'),
      async (_instance, state) => state.storage.get<BucketState>('bucket-state')
    );
    expect(stored?.grants).toHaveLength(1);
    expect(stored?.grants[0]?.amount).toBe(1);
  });

  it('restores a snapshot instead of handing out a fresh burst', async () => {
    // What eviction looks like: state on disk, no runtime in memory. A limiter
    // that rebuilt with a fresh full window here would burst against someone
    // else's quota after every idle period.
    const stub = limiter('persist-restore');
    await stub.configure({
      bucket: { limitPerWindow: 10, windowInMs: 600_000 },
      concurrency: 5,
    });
    await runInDurableObject(stubFor('persist-restore'), async (_i, state) => {
      await state.storage.put<BucketState>('bucket-state', {
        grants: [{ at: Date.now(), amount: 8 }],
        forcedUntil: 0,
      });
    });

    // reconfigure() drops the cached runtime, forcing a restore from storage.
    await stub.reconfigure({ concurrency: 5 });
    const stats = await stub.stats();
    // 8 of 10 already spent in a window that will not roll for ten minutes.
    expect(stats.remaining).toBe(2);
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
      bucket: { limitPerWindow: 0, windowInMs: 1 },
      concurrency: 1,
    });
    await expect(
      runInDurableObject(raw, async (instance: LimiterDO) => instance.stats())
    ).rejects.toThrow(/limitPerWindow/);

    await putConfig(roomy());
    await expect(
      runInDurableObject(raw, async (instance: LimiterDO) => instance.stats())
    ).resolves.toMatchObject({ config: { concurrency: 5 } });
  });
});

describe('LimiterDO registry', () => {
  const registry = (): NamedLimiter => limiter(REGISTRY_NAME);

  it('records a bucket when it is configured', async () => {
    await limiter('registry-configured').configure(roomy());
    expect(await registry().listNames()).toContain('registry-configured');
  });

  it('reports the name it was configured under', async () => {
    // A stats blob that identifies itself. The object reads this from storage;
    // it cannot get it from its own ID, which carries no name.
    await limiter('registry-self-naming').configure(roomy());
    await expect(
      limiter('registry-self-naming').stats()
    ).resolves.toMatchObject({ name: 'registry-self-naming' });
  });

  it('records a bucket once, however often it is restated', async () => {
    const stub = limiter('registry-once');
    await stub.configure(roomy());
    await stub.configure(roomy({ concurrency: 2 }));
    await stub.reconfigure({ concurrency: 3 });

    const names = await registry().listNames();
    expect(names.filter((name) => name === 'registry-once')).toHaveLength(1);
  });

  it('refuses to run a bucket nobody configured, and holds no storage', async () => {
    // The whole reason the registry can be complete: a bucket that was never
    // configured cannot run, so there is no such thing as a live bucket the
    // registry has not heard of. A mistyped instance name lands here rather
    // than silently becoming a second bucket at some plausible default rate.
    await expect(
      limiter('registry-never-configured').execute(async () => ok(1))
    ).rejects.toThrow(/No such limiter/);
    await expect(limiter('registry-never-configured').stats()).rejects.toThrow(
      /No such limiter/
    );
    expect(await registry().listNames()).not.toContain(
      'registry-never-configured'
    );

    // Unconfigured is not a state a bucket sits in — nothing was written, so
    // the object is indistinguishable from one that was never addressed.
    const written = await runInDurableObject(
      stubFor('registry-never-configured'),
      async (_i, state) => [...(await state.storage.list()).keys()]
    );
    expect(written).toEqual([]);
  });

  it('records nothing at all when the config is rejected', async () => {
    // Creation is all-or-nothing. Validation runs before the registration, so
    // a bad shape never reaches the registry — and even if it had, the object
    // would have compensated and erased itself.
    await expect(
      limiter('registry-invalid').configure(
        roomy({ bucket: { limitPerWindow: 0, windowInMs: 1 } })
      )
    ).rejects.toThrow(/limitPerWindow/);

    expect(await registry().listNames()).not.toContain('registry-invalid');
    await expect(limiter('registry-invalid').stats()).rejects.toThrow(
      /No such limiter/
    );
  });

  it('re-registers itself from its own stored name when the list is damaged', async () => {
    // The repair that makes the registry converge rather than stay wrong. The
    // bucket knows its own name because `configure` persisted it, so it can
    // reassert membership without anyone telling it who it is.
    const stub = limiter('registry-repair');
    await stub.configure(roomy());
    await registry().unregisterName('registry-repair');
    expect(await registry().listNames()).not.toContain('registry-repair');

    // Force a fresh object lifetime, which is where the reassertion fires.
    await stub.reconfigure({ concurrency: 4 });
    await stub.execute(async () => ok(1));

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await registry().listNames()).includes('registry-repair')) break;
      await sleep(10);
    }
    expect(await registry().listNames()).toContain('registry-repair');
  });

  it('forgets a name on request, and shrugs at one it never held', async () => {
    await limiter('registry-forget').configure(roomy());
    expect(await registry().listNames()).toContain('registry-forget');

    await registry().unregisterName('registry-forget');
    expect(await registry().listNames()).not.toContain('registry-forget');

    // Pruning is a read-path repair, so it runs against lists that may already
    // be correct. Doing nothing has to be cheap and silent.
    await registry().unregisterName('never-existed');
    expect(await registry().listNames()).not.toContain('never-existed');
  });

  it('erases itself and un-registers when creation fails half-way', async () => {
    // The saga's compensating half. Registration lands first so that the
    // survivable failure is a name with no bucket, never a bucket with no name
    // — and when the config write then fails on a bucket that did not exist a
    // moment ago, neither half is allowed to survive.
    const name = 'registry-torn-create';
    await runInDurableObject(
      stubFor(name),
      async (instance: LimiterDO, state) => {
        // The name lands, the config does not.
        breakWritesAfter(state, 1);
        await expect(instance.configure(name, roomy())).rejects.toThrow(
          /storage boom/
        );
      }
    );

    expect(await registry().listNames()).not.toContain(name);
    const written = await runInDurableObject(
      stubFor(name),
      async (_i, state) => [...(await state.storage.list()).keys()]
    );
    expect(written).toEqual([]);
  });

  it('leaves a live bucket untouched when a restatement fails', async () => {
    // The erasure is for creation only. Wiping a bucket that is already pacing
    // real traffic would hand out a full burst against someone else's quota on
    // the next call, which is the failure this package exists to prevent.
    const name = 'registry-torn-restate';
    const stub = limiter(name);
    await stub.configure(roomy({ concurrency: 3 }));

    await runInDurableObject(
      stubFor(name),
      async (instance: LimiterDO, state) => {
        breakWritesAfter(state, 1);
        await expect(
          instance.configure(name, roomy({ concurrency: 9 }))
        ).rejects.toThrow(/storage boom/);
      }
    );

    expect(await registry().listNames()).toContain(name);
    // Still on the last good limits, and still usable.
    await expect(stub.stats()).resolves.toMatchObject({
      name,
      config: { concurrency: 3 },
    });
  });

  it('holds no name list on an instance that is not the registry', async () => {
    // Both list operations have to cope with storage that has never held one.
    const stranger = limiter('registry-stranger');
    expect(await stranger.listNames()).toEqual([]);
    await stranger.unregisterName('anything');
    expect(await stranger.listNames()).toEqual([]);
  });

  it('never fails a caller because the registry was unreachable', async () => {
    // Re-registration is bookkeeping. It happens on the restore path, which is
    // the same path a real call takes, so if it were allowed to throw it would
    // turn a damaged registry into failed requests against the upstream.
    const name = 'registry-unreachable';
    const stub = limiter(name);
    await stub.configure(roomy());

    const saved = await registry().listNames();
    // A number, not a string: `'...'.includes` would work fine, and the point
    // is to make the registry's own write throw.
    await runInDurableObject(stubFor(REGISTRY_NAME), async (_i, state) => {
      await state.storage.put('names', 42);
    });

    // A fresh lifetime, so the re-registration fires — into a broken registry.
    await stub.reconfigure({ concurrency: 2 });
    await expect(stub.execute(async () => ok('served'))).resolves.toBe(
      'served'
    );

    await sleep(100);
    await runInDurableObject(stubFor(REGISTRY_NAME), async (_i, state) => {
      await state.storage.put('names', saved);
    });
  });

  it('carries the no-such-limiter marker across a real RPC hop', async () => {
    // The mechanism the client's whole classification rests on, pinned against
    // the real boundary rather than a double. What arrives is a plain `Error`:
    // the class is gone, `name` is 'Error', and every custom property has been
    // stripped — so the marker has to be in the message, and this asserts it
    // still is after a trip through workerd.
    const arrived: unknown = await limiter('registry-marker')
      .execute(async () => ok(1))
      .catch((error: unknown) => error);

    expect(arrived).toBeInstanceOf(Error);
    expect((arrived as Error).name).toBe('Error');
    expect(isNoSuchLimiter(arrived)).toBe(true);
  });

  it('keeps the list sorted and free of duplicates', async () => {
    const names = await registry().listNames();
    expect([...names].sort()).toEqual(names);
    expect(new Set(names).size).toBe(names.length);
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
