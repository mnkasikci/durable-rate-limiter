/* eslint-disable @typescript-eslint/require-await --
 * `call` takes a thunk that may return a `Response` synchronously; these are
 * `async` by contract rather than because their bodies await something.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  CallDroppedError,
  NoSuchLimiterError,
  defineBinder,
  defineLimiter,
  defineTestBinder,
} from '../src/client/index.js';
import type { BoundLimiter, DropEvent } from '../src/client/index.js';
import type {
  CallReport,
  LimiterConfig,
  LimiterDO,
  LimiterRpc,
} from '../src/do/index.js';
import type { BucketState } from '../src/core/index.js';

/**
 * The two halves, wired the way a consuming application wires them: the client
 * resolves the real Durable Object binding declared in wrangler.jsonc, and the
 * callback it hands over crosses a real RPC boundary into a real object.
 *
 * These suites exist because neither half can be trusted alone. The unit
 * suites assert the client builds the right envelope and the object schedules
 * on the right fields — but "the closure runs in the caller's isolate", "the
 * payload never transits the object" and "one caller's 429 slows another" are
 * properties of the *pair*, and none of them can be observed with either side
 * replaced by a double.
 */
const binder = defineBinder('RATE_LIMITER');

/** A distinct bucket per test; the isolation `idFromName` already provides. */
let counter = 0;
function uniqueName(prefix: string): string {
  counter += 1;
  return `it-${prefix}-${String(counter)}`;
}

/** Raw stub for the same instance, for `configure`/`stats` — setup, not calls. */
/**
 * A stub with its own name bound into `configure`, the way
 * `LimiterEntrypoint` binds it: a Durable Object cannot recover the name it
 * was addressed by, so the caller carries it.
 */
type Control = Omit<LimiterRpc, 'configure'> & {
  configure(config: LimiterConfig): Promise<void>;
};

function control(name: string): Control {
  const stub: LimiterRpc = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(name)
  );
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

function rawStub(name: string): DurableObjectStub<LimiterDO> {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
}

/**
 * Room to spare, so a test measures the thing it means to measure.
 *
 * `maxDelayInMs` is the trap: it clamps a `Retry-After` as well as the
 * backoff, so a ceiling set low enough to keep the suite quick would make
 * every penalty expire before an assertion could see it. It stays generous
 * here, and the tests that only want a *fast* retry lower `minDelayInMs`.
 */
function roomy(patch: Partial<LimiterConfig> = {}): LimiterConfig {
  return {
    bucket: { capacity: 50, fillPerWindow: 5000, windowInMs: 60_000 },
    concurrency: 5,
    retry: { minDelayInMs: 10, maxDelayInMs: 5_000 },
    ...patch,
  };
}

/**
 * Configure a fresh limiter and hand back both halves pointed at it: the bound
 * client a consumer would call through, and the control stub the assertions
 * inspect.
 */
async function setup(
  prefix: string,
  config: LimiterConfig = roomy(),
  definition: Partial<Parameters<typeof defineLimiter>[0]> = {}
): Promise<{ name: string; bound: BoundLimiter; ctl: Control }> {
  const name = uniqueName(prefix);
  const ctl = control(name);
  await ctl.configure(config);
  const bound = defineLimiter({ binder, name, ...definition }).for(env);
  return { name, bound, ctl };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const readJson = (res: Response): Promise<unknown> => res.json();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('client + object — where the work actually runs', () => {
  it("runs the closure in the CALLER's isolate, not the object's", async () => {
    const { bound } = await setup('isolate');

    // This array exists only in the test isolate's heap. A serialised function
    // executed object-side could not possibly touch it; a function handle
    // called back into this isolate can, and does.
    const touchedLocally: string[] = [];

    const value = await bound.call(
      async () => {
        touchedLocally.push('fn ran here');
        return json({ ok: true });
      },
      {
        read: async (res) => {
          touchedLocally.push('read ran here');
          return (await res.json<{ ok: boolean }>()).ok;
        },
      }
    );

    expect(value).toBe(true);
    expect(touchedLocally).toEqual(['fn ran here', 'read ran here']);
  });

  it('keeps a large payload out of the object — only an id crosses', async () => {
    const { bound } = await setup('payload');
    let localBytes = 0;

    // Stands in for a multi-megabyte export: produced and consumed caller-side,
    // with only an identifier put in the envelope. The buffer is unreachable
    // from the object, and the object is single-threaded — this is the whole
    // reason `read` exists.
    const id = await bound.call(
      async () => {
        const big = new Uint8Array(1_000_000).fill(7);
        localBytes = big.byteLength;
        return json({ id: 'file-123', size: big.byteLength });
      },
      { read: async (res) => (await res.json<{ id: string }>()).id }
    );

    expect(id).toBe('file-123');
    expect(localBytes).toBe(1_000_000);
    // Nothing but the id was reported, so nothing but the id was ever in the
    // object's heap.
    expect(typeof id).toBe('string');
  });
});

describe('client + object — enforcement across callers', () => {
  it('holds the concurrency cap, measured as peak overlap', async () => {
    const { bound } = await setup('concurrency', roomy({ concurrency: 2 }));

    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        bound.call(
          async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await sleep(60);
            inFlight -= 1;
            return json({ ok: true });
          },
          { read: readJson }
        )
      )
    );

    // Overlap of the CALLER-side work, which is the thing that actually
    // consumes upstream capacity. The object knows this only because it awaits
    // the callback: a released-on-start slot would show 6 here.
    expect(peak).toBe(2);
  });

  it('delays a second caller with a 429 it never saw and never reported', async () => {
    // The capability an in-process limiter structurally cannot have. B does no
    // reporting, runs no hook, and is not even started when A is limited.
    const { bound, ctl } = await setup('backpressure');

    let attempts = 0;
    const callerA = bound.call(
      async () => {
        attempts += 1;
        return attempts === 1
          ? json({ error: 'slow down' }, 429, { 'Retry-After': '1' })
          : json({ ok: true });
      },
      { read: readJson }
    );

    await sleep(120); // let A's 429 land and pause the shared bucket
    expect(await ctl.stats()).toMatchObject({ penalised: true });

    const startedB = Date.now();
    const callerB = bound.call(async () => json({ who: 'b' }), {
      read: async (res) => (await res.json<{ who: string }>()).who,
    });

    await callerA;
    await expect(callerB).resolves.toBe('b');

    // B had ~50 tokens available. It waited only because A's `Retry-After`
    // paused the bucket for everyone.
    expect(Date.now() - startedB).toBeGreaterThan(600);
    expect(attempts).toBe(2);
  });
});

describe('client + object — hooks decided here, enforced there', () => {
  it('pauses the shared bucket for a rate limit encoded in the body', async () => {
    // A 200 whose body says "quota exhausted". Only the caller can see that —
    // the body never leaves this isolate — so the hook translates it into the
    // one vocabulary the object understands.
    const { bound, ctl } = await setup('body-429', roomy(), {
      rateLimit: (_res, body) =>
        (body as { status?: string }).status === 'RESOURCE_EXHAUSTED'
          ? { retryAfterMs: 500 }
          : null,
    });

    let attempts = 0;
    const limited = bound.call(
      async () => {
        attempts += 1;
        return attempts === 1
          ? json({ status: 'RESOURCE_EXHAUSTED' })
          : json({ status: 'OK' });
      },
      { read: readJson }
    );

    await sleep(120);
    const paused = await ctl.stats();
    expect(paused.penalised).toBe(true);
    expect(paused.forcedUntil).toBeGreaterThan(Date.now());

    await limited;
    expect(attempts).toBe(2);
  });

  it('retries a body-encoded error WITHOUT pausing the shared bucket', async () => {
    // The distinction the two hooks exist for: one endpoint's 500 must not
    // stall every other caller of the same upstream. This can only be observed
    // with both halves live — the object reads `failure` off the envelope, and
    // nothing but the client can put it there.
    // A bucket that refills once per ten minutes, so the token count after the
    // test is exactly the number of attempts that were paced.
    const { bound, ctl } = await setup(
      'body-error',
      roomy({ bucket: { capacity: 50, fillPerWindow: 1, windowInMs: 600_000 } })
    );

    let attempts = 0;
    const value = await bound.call(
      async () => {
        attempts += 1;
        return attempts < 3
          ? json({ error: 'upstream hiccup' }, 500)
          : json({ ok: true });
      },
      {
        read: readJson,
        error: (_res, body) => {
          const failed = (body as { error?: string }).error;
          return failed === undefined
            ? null
            : { message: failed, retryable: true };
        },
      }
    );

    expect(value).toEqual({ ok: true });
    expect(attempts).toBe(3);

    // Retried locally, and only locally.
    const stats = await ctl.stats();
    expect(stats.penalised).toBe(false);
    expect(stats.forcedUntil).toBe(0);
    // One token per attempt: the pacing still applies, the penalty does not.
    expect(stats.tokens).toBeCloseTo(47, 3);
  });

  it('ends the call on a non-retryable body-encoded failure', async () => {
    const { bound, ctl } = await setup('body-final');

    let attempts = 0;
    await expect(
      bound.call(
        async () => {
          attempts += 1;
          return json({ error: 'no such document' }, 404);
        },
        {
          read: readJson,
          error: (res, body) => ({
            message: (body as { error: string }).error,
            retryable: res.status >= 500,
          }),
        }
      )
      // The rejection crosses RPC stripped to name/message/stack, which is why
      // everything worth keeping is in the message.
    ).rejects.toThrow(/no such document/);

    expect(attempts).toBe(1);
    await expect(ctl.stats()).resolves.toMatchObject({ penalised: false });
  });

  it('still catches a genuine header 429 when the call site opts out of hooks', async () => {
    // `rateLimit: null` disables both hook layers. Layer 3 — status and
    // `Retry-After` copied onto every envelope — is unconditional, so an
    // override for one oddly-shaped endpoint cannot silently disable real 429
    // handling.
    const { bound, ctl } = await setup('override-429', roomy(), {
      rateLimit: () => ({ retryAfterMs: 5 }),
    });

    let attempts = 0;
    const call = bound.call(
      async () => {
        attempts += 1;
        return attempts === 1
          ? json({}, 429, { 'Retry-After': '1' })
          : json({ ok: true });
      },
      { read: readJson, rateLimit: null, error: null }
    );

    await sleep(120);
    expect(await ctl.stats()).toMatchObject({ penalised: true });

    await call;
    expect(attempts).toBe(2);
  });
});

describe('client + object — durability and its limits', () => {
  it('persists bucket state so eviction cannot restore a full burst', async () => {
    const name = uniqueName('evict');
    const ctl = control(name);
    await ctl.configure({
      bucket: { capacity: 10, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });
    const bound = defineLimiter({ binder, name }).for(env);

    await bound.call(async () => json({ ok: true }), { read: readJson });
    await bound.call(async () => json({ ok: true }), { read: readJson });

    // The in-memory field is not the thing that has to survive eviction; the
    // persisted triple is. Read the object's own storage rather than trusting
    // `stats()`, which would answer from the live bucket either way.
    const stored = await runInDurableObject(
      rawStub(name),
      async (_instance, state) => state.storage.get<BucketState>('bucket-state')
    );
    expect(stored).toBeDefined();
    expect(stored?.tokens).toBeCloseTo(8, 3);

    // What eviction looks like: state on disk, no runtime in memory.
    // `reconfigure` drops the cached runtime and forces a restore.
    await ctl.reconfigure({});
    const restored = await ctl.stats();
    expect(restored.tokens).toBeGreaterThanOrEqual(8);
    expect(restored.tokens).toBeLessThan(9);
  });

  it('rejects a call cleanly when the wait queue is lost and retries are off', async () => {
    // An RPC function handle cannot be persisted, so the queue is memory-only
    // and a queued caller can be dropped. Documented, not hidden: `call()` is
    // throwable and the rejection has to arrive as one, not as a hang.
    const name = uniqueName('queue-lost');
    const ctl = control(name);
    await ctl.configure({
      bucket: { capacity: 1, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });
    const bound = defineLimiter({ binder, name, dropRetries: 0 }).for(env);

    await bound.call(async () => json({ ok: true }), { read: readJson });

    // No tokens left for ten minutes: this one parks in the object's queue.
    const parked = bound.call(async () => json({ ok: true }), {
      read: readJson,
    });
    await sleep(50);

    // Rebuilding the bucket destroys it, and every waiter on it.
    await ctl.reconfigure({ concurrency: 4 });

    await expect(parked).rejects.toThrow(CallDroppedError);
  });

  it('re-queues a dropped caller under the limits that replaced the old ones', async () => {
    // The default, and the reason the retry lives in the package: the caller
    // never ran, so nothing upstream happened, and the operator has just said
    // what the limits should be. Failing here would make every consumer write
    // the same wrapper — and the ones who forgot would lose calls.
    const name = uniqueName('queue-lost-retry');
    const ctl = control(name);
    await ctl.configure({
      bucket: { capacity: 1, fillPerWindow: 1, windowInMs: 600_000 },
      concurrency: 5,
    });
    const drops: DropEvent[] = [];
    const bound = defineLimiter({
      binder,
      name,
      onDrop: (event) => drops.push(event),
    }).for(env);

    await bound.call(async () => json({ ok: true }), { read: readJson });

    let ran = 0;
    const parked = bound.call(
      async () => {
        ran += 1;
        return json({ ok: true });
      },
      { read: readJson }
    );
    await sleep(50);

    // Same destruction as above — but now the limits it re-queues under have
    // tokens, so the caller is served instead of being told to go away.
    await ctl.reconfigure({
      bucket: { capacity: 5, fillPerWindow: 5, windowInMs: 1_000 },
    });

    await expect(parked).resolves.toEqual({ ok: true });
    // Once, on the attempt that was actually scheduled. The dropped attempt
    // never reached the callback, which is what makes the retry safe.
    expect(ran).toBe(1);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.willRetry).toBe(true);
    expect(drops[0]?.attempt).toBe(1);
  });
});

describe('client + object — a limiter that does not exist', () => {
  it('fails at once, and does not report a drop that never happened', async () => {
    // Both failures reach the client the same way: a rejection from the object
    // before the callback ever fired. Telling them apart is the point. A drop
    // is transport and worth retrying; this is permanent, and retrying it would
    // spend six round trips and put six phantom events into the one metric an
    // operator has for sizing real drops.
    const drops: DropEvent[] = [];
    let callbackRuns = 0;

    const limiter = defineLimiter({
      binder,
      name: uniqueName('never-configured'),
      onDrop: (event) => drops.push(event),
    });

    const failure = await limiter
      .for(env)
      .call(
        () => {
          callbackRuns += 1;
          return json({ ok: true });
        },
        { read: readJson }
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(NoSuchLimiterError);
    expect(failure).not.toBeInstanceOf(CallDroppedError);
    expect(drops).toEqual([]);
    expect(callbackRuns).toBe(0);

    const error = failure as NoSuchLimiterError;
    expect(error.limiter).toBe(limiter.name);
    // The remedy the object wrote is still reachable, one level down.
    expect((error.cause as Error).message).toContain('mistyped instance name');
  });

  it('still retries a caller dropped in transit', async () => {
    // The other half of the fork, so the fix cannot have turned every
    // pre-callback failure into a permanent one.
    const drops: DropEvent[] = [];
    let attempts = 0;

    const limiter = defineLimiter({
      binder: defineTestBinder<string>({
        idFromName: (name) => name,
        get: () => ({
          execute<T>(): Promise<T> {
            attempts += 1;
            return Promise.reject(new Error('Network connection lost.'));
          },
        }),
      }),
      name: 'dropped-not-missing',
      onDrop: (event) => drops.push(event),
    });

    await expect(
      limiter.for(env).call(() => json({ ok: true }), { read: readJson })
    ).rejects.toBeInstanceOf(CallDroppedError);
    expect(attempts).toBe(6);
    expect(drops).toHaveLength(6);
  });
});
