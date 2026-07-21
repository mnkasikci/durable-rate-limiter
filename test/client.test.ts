import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
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
    const limiter = defineLimiter({
      binder: defineBinder('RATE_LIMITER'),
      name: uniqueName('real'),
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
    const limiter = defineLimiter({ binder, name: 'google-docs' });

    await limiter.for({}).call(() => respond(200), { read: () => 'ok' });

    expect(limiter.name).toBe('google-docs');
    expect(instanceNames).toEqual(['google-docs']);
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
