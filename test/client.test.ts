import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  CallDroppedError,
  DEFAULT_DROP_RETRIES,
  defineBinder,
  defineLimiter,
  defineTestBinder,
  type CallReport,
  type LimiterStub,
} from '../src/client/index.js';

/**
 * A stub that runs the callback once and keeps the envelope, so the tests can
 * assert on what would have crossed the boundary.
 *
 * The real object is exercised separately, over a real binding. Everything
 * about hook resolution is about the *shape* of the envelope, and asserting
 * that through a live Durable Object would mean asserting it indirectly through
 * scheduling behaviour.
 */
function capturingBinder(): {
  binder: ReturnType<typeof defineTestBinder>;
  reports: CallReport<unknown>[];
  instanceNames: string[];
} {
  const reports: CallReport<unknown>[] = [];
  const instanceNames: string[] = [];
  const stub: LimiterStub = {
    async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
      const report = await fn();
      reports.push(report);
      return report.value;
    },
  };
  const binder = defineTestBinder({
    idFromName: (name: string) => name,
    get: (id: string) => {
      instanceNames.push(id);
      return stub;
    },
  });
  return { binder, reports, instanceNames };
}

function respond(
  status: number,
  headers: Record<string, string> = {}
): Response {
  return new Response('{}', { status, headers });
}

/** A unique bucket per test — the isolation `idFromName` already provides. */
let counter = 0;
function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

describe('defineBinder', () => {
  it('reaches the real binding and runs the callback in this isolate', async () => {
    const name = uniqueName('real');
    // A limiter refuses to run until its limits exist, so the setup call the
    // CLI would make has to happen here too.
    await env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)).configure(
      name,
      {
        bucket: { limitPerWindow: 5000, windowInMs: 60_000 },
        concurrency: 5,
      }
    );

    const limiter = defineLimiter({
      binder: defineBinder('RATE_LIMITER'),
      name,
    });

    let ranHere = false;
    const value = await limiter.for(env).call(
      () => {
        ranHere = true;
        return respond(200);
      },
      { read: () => 'extracted' }
    );

    expect(value).toBe('extracted');
    expect(ranHere).toBe(true);
  });

  it('names the bindings it did find when the name is absent', () => {
    const limiter = defineLimiter({
      binder: defineBinder.unchecked('RATE_LIMITR'),
      name: 'typo',
    });

    expect(() =>
      limiter.for({
        RATE_LIMITER: env.RATE_LIMITER,
        COLLECTOR: env.RATE_LIMITER,
        SETTINGS: { get: () => null },
      })
    ).toThrow(
      'Binding "RATE_LIMITR" not found on env.\n' +
        'Available Durable Object bindings: RATE_LIMITER, COLLECTOR.'
    );
  });

  it('rejects a binding that is present but is not a namespace', () => {
    const limiter = defineLimiter({
      binder: defineBinder.unchecked('SETTINGS'),
      name: 'wrong-kind',
    });

    // Every shape `isNamespaceLike` must reject, in one env: a primitive, null,
    // and two half-namespaces missing one method each.
    expect(() =>
      limiter.for({
        SETTINGS: { get: () => null, put: () => undefined },
        ACCOUNT_ID: 'not-an-object',
        UNSET: null,
        HALF_A: { idFromName: () => 'x' },
        HALF_B: { get: () => 'x' },
        RATE_LIMITER: env.RATE_LIMITER,
      })
    ).toThrow(
      'Binding "SETTINGS" on env is not a Durable Object namespace.\n' +
        'Available Durable Object bindings: RATE_LIMITER.'
    );
  });

  it('says so plainly when there are no Durable Object bindings at all', () => {
    const limiter = defineLimiter({
      binder: defineBinder.unchecked('RATE_LIMITER'),
      name: 'empty',
    });

    expect(() => limiter.for({})).toThrow(
      'Binding "RATE_LIMITER" not found on env.\n' +
        'Available Durable Object bindings: (none).'
    );
  });

  it('records the binding name; a test binder has none', () => {
    expect(defineBinder('RATE_LIMITER').bindingName).toBe('RATE_LIMITER');
    expect(defineBinder.unchecked('ANYTHING').bindingName).toBe('ANYTHING');
    expect(capturingBinder().binder.bindingName).toBeNull();
  });

  it('rejects a typo and a non-Durable-Object binding at compile time', () => {
    // @ts-expect-error 'RATE_LIMITR' is not a key of the generated Env.
    expect(() => defineBinder('RATE_LIMITR')).not.toThrow();
    // @ts-expect-error SETTINGS is a KV binding, not a Durable Object one.
    expect(() => defineBinder('SETTINGS')).not.toThrow();
  });
});

describe('defineTestBinder', () => {
  it('ignores env entirely and passes the limiter name to idFromName', async () => {
    const { binder, instanceNames } = capturingBinder();
    const limiter = defineLimiter({ binder, name: 'example-api' });

    await limiter.for({}).call(() => respond(200), { read: () => 'ok' });

    expect(limiter.name).toBe('example-api');
    expect(instanceNames).toEqual(['example-api']);
  });
});

describe('call — the envelope', () => {
  it('copies status and Retry-After onto every envelope', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'http' }).for({});

    await bound.call(() => respond(429, { 'Retry-After': '120' }), {
      read: () => 'body',
    });

    expect(reports[0]).toEqual({
      value: 'body',
      status: 429,
      retryAfter: '120',
    });
  });

  it('never throws on a non-2xx; the status travels as data', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'not-found' }).for({});

    const value = await bound.call(() => respond(404), { read: () => 'gone' });

    expect(value).toBe('gone');
    expect(reports[0]?.status).toBe(404);
    expect(reports[0]?.failure).toBeUndefined();
  });

  it('lets an unexpected throw from the callback propagate', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'boom' }).for({});

    await expect(
      bound.call(
        () => {
          throw new Error('socket hang up');
        },
        { read: () => 'unreachable' }
      )
    ).rejects.toThrow('socket hang up');
    expect(reports).toHaveLength(0);
  });

  it('keeps the envelope small by reporting only what read returned', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'download' }).for({});

    await bound.call(() => new Response('a'.repeat(10_000), { status: 200 }), {
      read: async (res) => (await res.text()).length,
    });

    expect(reports[0]?.value).toBe(10_000);
  });
});

describe('call — rateLimit resolution', () => {
  const throttled = { throttled: true, waitMs: 5_000 };

  it('applies the limiter default when the call site says nothing', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({
      binder,
      name: 'default-rl',
      rateLimit: () => ({ retryAfterMs: 60_000 }),
    }).for({});

    await bound.call(() => respond(200), { read: () => throttled });

    expect(reports[0]?.status).toBe(429);
    expect(reports[0]?.retryAfterMs).toBe(60_000);
  });

  it('prefers the call-site hook and falls through to the default on null', async () => {
    const { binder, reports } = capturingBinder();
    const limiter = defineLimiter({
      binder,
      name: 'chain-rl',
      rateLimit: () => ({ retryAfterMs: 60_000 }),
    });

    await limiter.for({}).call(() => respond(200), {
      read: () => throttled,
      rateLimit: (_res, body) => ({ retryAfterMs: body.waitMs }),
    });
    expect(reports[0]?.retryAfterMs).toBe(5_000);

    await limiter.for({}).call(() => respond(200), {
      read: () => throttled,
      rateLimit: () => null,
    });
    expect(reports[1]?.retryAfterMs).toBe(60_000);
  });

  it('marks a rate limit with no stated delay as a plain 429', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'no-delay' }).for({});

    await bound.call(() => respond(200), {
      read: () => throttled,
      rateLimit: () => ({}),
    });

    expect(reports[0]?.status).toBe(429);
    expect(reports[0]?.retryAfterMs).toBeUndefined();
  });

  it('leaves the envelope alone when no layer recognises a rate limit', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({
      binder,
      name: 'quiet-rl',
      rateLimit: () => null,
    }).for({});

    await bound.call(() => respond(200), {
      read: () => throttled,
      rateLimit: () => null,
    });

    expect(reports[0]?.status).toBe(200);
  });

  it('opts out of both hook layers on an explicit null', async () => {
    const { binder, reports } = capturingBinder();
    let defaultRan = false;
    const bound = defineLimiter({
      binder,
      name: 'opt-out',
      rateLimit: () => {
        defaultRan = true;
        return { retryAfterMs: 60_000 };
      },
    }).for({});

    await bound.call(() => respond(200), {
      read: () => throttled,
      rateLimit: null,
    });

    expect(defaultRan).toBe(false);
    expect(reports[0]?.status).toBe(200);
  });

  it('keeps genuine HTTP 429 handling that a call-site override cannot disable', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'unconditional' }).for({});

    // The most careful possible call site: an override for an odd endpoint,
    // plus an explicit opt-out. Layer 3 still classifies the response.
    await bound.call(() => respond(429, { 'Retry-After': '30' }), {
      read: () => throttled,
      rateLimit: null,
      error: null,
    });

    expect(reports[0]?.status).toBe(429);
    expect(reports[0]?.retryAfter).toBe('30');
  });
});

describe('call — error resolution', () => {
  const failed = { error: { message: 'quota exhausted' } };

  it('folds a failure description into the envelope rather than throwing', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({
      binder,
      name: 'default-err',
      error: (res, body) => ({
        message: (body as typeof failed).error.message,
        retryable: res.status >= 500,
      }),
    }).for({});

    const value = await bound.call(() => respond(503), { read: () => failed });

    expect(value).toBe(failed);
    expect(reports[0]?.failure).toEqual({
      message: 'quota exhausted',
      retryable: true,
    });
  });

  it('prefers the call-site hook and falls through to the default on null', async () => {
    const { binder, reports } = capturingBinder();
    const limiter = defineLimiter({
      binder,
      name: 'chain-err',
      error: () => ({ message: 'from limiter', retryable: false }),
    });

    await limiter.for({}).call(() => respond(500), {
      read: () => failed,
      error: () => ({ message: 'from call site', retryable: true }),
    });
    expect(reports[0]?.failure?.message).toBe('from call site');

    await limiter.for({}).call(() => respond(500), {
      read: () => failed,
      error: () => null,
    });
    expect(reports[1]?.failure?.message).toBe('from limiter');
  });

  it('reports no failure when no layer recognises one', async () => {
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({
      binder,
      name: 'quiet-err',
      error: () => null,
    }).for({});

    await bound.call(() => respond(200), { read: () => failed });

    expect(reports[0]?.failure).toBeUndefined();
  });

  it('opts out of both hook layers on an explicit null', async () => {
    const { binder, reports } = capturingBinder();
    let defaultRan = false;
    const bound = defineLimiter({
      binder,
      name: 'err-opt-out',
      error: () => {
        defaultRan = true;
        return { message: 'never', retryable: true };
      },
    }).for({});

    await bound.call(() => respond(500), { read: () => failed, error: null });

    expect(defaultRan).toBe(false);
    expect(reports[0]?.failure).toBeUndefined();
  });

  it('carries a non-retryable failure alongside a rate limit independently', async () => {
    // The two hooks are separate for a reason: one is global, one is local.
    // Nothing stops both firing, and neither may overwrite the other.
    const { binder, reports } = capturingBinder();
    const bound = defineLimiter({ binder, name: 'both' }).for({});

    await bound.call(() => respond(200), {
      read: () => failed,
      rateLimit: () => ({ retryAfterMs: 1_000 }),
      error: () => ({ message: 'bad request', retryable: false }),
    });

    expect(reports[0]).toEqual({
      value: failed,
      status: 429,
      retryAfter: null,
      retryAfterMs: 1_000,
      failure: { message: 'bad request', retryable: false },
    });
  });
});

/**
 * A binder whose stub drops the caller — rejecting *without* ever invoking the
 * callback — for the first `dropFirst` attempts, then behaves.
 *
 * That distinction is the entire subject of these tests, so the double models
 * it directly: a drop is a rejection with the callback untouched, which is what
 * the platform does when the object is evicted while a caller is parked in its
 * memory-only queue.
 */
function droppingBinder(
  dropFirst: number,
  message = 'Network connection lost.'
): {
  binder: ReturnType<typeof defineTestBinder>;
  attempts: () => number;
  stubsHandedOut: () => number;
} {
  let attempts = 0;
  let stubs = 0;
  const binder = defineTestBinder({
    idFromName: (name: string) => name,
    get: (): LimiterStub => {
      stubs += 1;
      return {
        async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
          attempts += 1;
          if (attempts <= dropFirst) throw new Error(message);
          return (await fn()).value;
        },
      };
    },
  });
  return { binder, attempts: () => attempts, stubsHandedOut: () => stubs };
}

describe('call — dropped while parked', () => {
  it('retries a caller that was dropped before its callback ever ran', async () => {
    const { binder, attempts } = droppingBinder(2);
    let ran = 0;

    const value = await defineLimiter({ binder, name: 'dropped' })
      .for({})
      .call(
        () => {
          ran += 1;
          return respond(200);
        },
        { read: () => 'ok' }
      );

    expect(value).toBe('ok');
    expect(attempts()).toBe(3);
    // The callback ran only on the attempt that actually got scheduled. The
    // two drops never reached the upstream at all, which is why retrying them
    // cannot duplicate anything.
    expect(ran).toBe(1);
  });

  it('replaces the stub after a drop, but not on the happy path', async () => {
    // Reusing the handle whose connection just broke would make every retry an
    // instant repeat of the same failure — but resolving a new one per attempt
    // would tax every call that never drops, which is almost all of them.
    const { binder, stubsHandedOut } = droppingBinder(1);
    const bound = defineLimiter({ binder, name: 'fresh-stub' }).for({});

    // One handle for the request, from the presence check.
    expect(stubsHandedOut()).toBe(1);

    await bound.call(() => respond(200), { read: () => 'ok' });

    // Exactly one more, taken because the first attempt was dropped.
    expect(stubsHandedOut()).toBe(2);

    await bound.call(() => respond(200), { read: () => 'ok' });

    // The second call drops nothing and takes no new handle.
    expect(stubsHandedOut()).toBe(2);
  });

  it('gives up with a CallDroppedError once the attempts are spent', async () => {
    const { binder, attempts } = droppingBinder(Infinity);

    const rejection = defineLimiter({ binder, name: 'spent' })
      .for({})
      .call(() => respond(200), { read: () => 'ok' });

    await expect(rejection).rejects.toThrow(CallDroppedError);
    await expect(rejection).rejects.toThrow(
      /dropped while queued and never ran/
    );
    // The message is the only thing an operator gets from a transport error,
    // so the original one must survive into it.
    await expect(rejection).rejects.toThrow(/Network connection lost/);
    expect(attempts()).toBe(DEFAULT_DROP_RETRIES + 1);
  });

  it('carries the attempt count and the limiter name on the error', async () => {
    const { binder } = droppingBinder(Infinity);
    // Unlike the object side, this error never crosses an RPC boundary, so its
    // custom properties actually survive to be read.
    let error: CallDroppedError | undefined;
    try {
      await defineLimiter({ binder, name: 'named' })
        .for({})
        .call(() => respond(200), { read: () => 'ok' });
    } catch (caught) {
      error = caught as CallDroppedError;
    }
    if (error === undefined) throw new Error('expected a rejection');

    expect(error.name).toBe('CallDroppedError');
    expect(error.limiter).toBe('named');
    expect(error.attempts).toBe(DEFAULT_DROP_RETRIES + 1);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('reports every drop to onDrop, retried or not', async () => {
    // A silent retry is a retry nobody can size — the drop rate is a property
    // of the deployment, not of this package.
    const { binder } = droppingBinder(Infinity);
    const seen: { attempt: number; willRetry: boolean; limiter: string }[] = [];

    await defineLimiter({
      binder,
      name: 'observed',
      dropRetries: 2,
      onDrop: ({ attempt, willRetry, limiter }) => {
        seen.push({ attempt, willRetry, limiter });
      },
    })
      .for({})
      .call(() => respond(200), { read: () => 'ok' })
      .catch(() => undefined);

    expect(seen).toEqual([
      { attempt: 1, willRetry: true, limiter: 'observed' },
      { attempt: 2, willRetry: true, limiter: 'observed' },
      { attempt: 3, willRetry: false, limiter: 'observed' },
    ]);
  });

  it('opts out entirely at dropRetries: 0', async () => {
    const { binder, attempts } = droppingBinder(Infinity);

    await expect(
      defineLimiter({ binder, name: 'no-retry', dropRetries: 0 })
        .for({})
        .call(() => respond(200), { read: () => 'ok' })
    ).rejects.toThrow(CallDroppedError);

    expect(attempts()).toBe(1);
  });

  it('wraps a non-Error rejection so the hook always receives an Error', async () => {
    // RPC reconstructs a thrown value as an Error, but a test double or a
    // future runtime may not, and `DropEvent.error` promises one.
    const binder = defineTestBinder({
      idFromName: (name: string) => name,
      get: (): LimiterStub => ({
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error rejection IS the case under test
        execute: () => Promise.reject('bare string'),
      }),
    });
    let received: unknown;

    await expect(
      defineLimiter({
        binder,
        name: 'non-error',
        dropRetries: 0,
        onDrop: ({ error }) => {
          received = error;
        },
      })
        .for({})
        .call(() => respond(200), { read: () => 'ok' })
    ).rejects.toThrow(/bare string/);

    expect(received).toBeInstanceOf(Error);
  });

  it('does NOT retry once the callback has run', async () => {
    // The ambiguous case, deliberately left alone: the request may already
    // have reached the upstream, and a retry the caller did not ask for could
    // send a payment twice.
    let ran = 0;
    const binder = defineTestBinder({
      idFromName: (name: string) => name,
      get: (): LimiterStub => ({
        async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
          await fn();
          throw new Error('Network connection lost.');
        },
      }),
    });

    await expect(
      defineLimiter({ binder, name: 'in-flight' })
        .for({})
        .call(
          () => {
            ran += 1;
            return respond(200);
          },
          { read: () => 'ok' }
        )
    ).rejects.toThrow('Network connection lost.');

    expect(ran).toBe(1);
  });
});

describe('call — the drop test is per call, not per binding', () => {
  it('does not let one call site observe another call site as "ran"', async () => {
    // The retry hinges on a flag that must be scoped to ONE attempt of ONE
    // call. `.for(env)` is shared — a request typically makes many calls
    // through one bound limiter, often concurrently via Promise.all — so if
    // that flag were ever hoisted out of `call`, a second call site firing its
    // callback would make a first, still-parked call look as though it had
    // run. The parked call would then be treated as unsafe to retry and
    // silently lost.
    //
    // This test forces exactly that interleaving: A is dropped WITHOUT its
    // callback ever running, but only after B's callback has already fired.
    let releaseB: () => void = () => undefined;
    const bHasRun = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    let execCount = 0;
    const binder = defineTestBinder({
      idFromName: (name: string) => name,
      get: (): LimiterStub => ({
        async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
          execCount += 1;
          if (execCount === 1) {
            // A: park until B's callback has fired, then drop without ever
            // invoking our own callback.
            await bHasRun;
            throw new Error('Network connection lost.');
          }
          return (await fn()).value;
        },
      }),
    });

    const bound = defineLimiter({ binder, name: 'interleaved' }).for({});

    let aRan = 0;
    let bRan = 0;

    const [a, b] = await Promise.all([
      bound.call(
        () => {
          aRan += 1;
          return respond(200);
        },
        { read: () => 'a' }
      ),
      bound.call(
        () => {
          bRan += 1;
          releaseB();
          return respond(200);
        },
        { read: () => 'b' }
      ),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    // A was retried despite B having fired in the meantime, and ran exactly
    // once — on the retry. A shared flag would leave this at 0 and reject.
    expect(aRan).toBe(1);
    expect(bRan).toBe(1);
    expect(execCount).toBe(3);
  });

  it('keeps the flag per attempt, so a later attempt cannot inherit an earlier one', async () => {
    // Same hazard one level down: two attempts of the SAME call. If the flag
    // outlived an attempt, a first attempt that ran and failed would make a
    // subsequent drop look unretryable — or worse, the reverse.
    let execCount = 0;
    const binder = defineTestBinder({
      idFromName: (name: string) => name,
      get: (): LimiterStub => ({
        async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
          execCount += 1;
          // Drop, drop, then serve — with the callback untouched both times.
          if (execCount <= 2) throw new Error('Network connection lost.');
          return (await fn()).value;
        },
      }),
    });

    let ran = 0;
    const value = await defineLimiter({ binder, name: 'per-attempt' })
      .for({})
      .call(
        () => {
          ran += 1;
          return respond(200);
        },
        { read: () => 'ok' }
      );

    expect(value).toBe('ok');
    expect(ran).toBe(1);
    expect(execCount).toBe(3);
  });
});
