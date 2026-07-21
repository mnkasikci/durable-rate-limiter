/* eslint-disable @typescript-eslint/require-await --
 * `execute` takes a thunk returning a promise, so these callbacks are `async`
 * by contract rather than because their bodies happen to await something.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { LimiterConfig } from '../src/do/index.js';

/**
 * These go through the self-referencing service binding declared in
 * wrangler.jsonc, so every call is a real RPC hop into a NAMED entrypoint —
 * the arrangement that fails at startup with "has no such named entrypoint"
 * if the class is ever demoted to a default export.
 */
const limits: Partial<LimiterConfig> = {
  bucket: { capacity: 20, fillPerWindow: 5000, windowInMs: 60_000 },
  concurrency: 3,
};

describe('LimiterEntrypoint', () => {
  it('forwards the callback two hops and still runs it here', async () => {
    // consumer → service binding → limiter Worker → Durable Object. The handle
    // is forwarded a second time and the callback still resolves back into
    // this isolate, which is the whole topology in one assertion.
    let ranHere = false;

    const value = await env.LIMITER.execute('two-hop', async () => {
      ranHere = true;
      return { value: 42, status: 200 };
    });

    expect(ranHere).toBe(true);
    expect(value).toBe(42);
  });

  it('routes each name to its own limiter', async () => {
    // One class, one binding, independent buckets — the reason the
    // instance-name convention lives here and nowhere else.
    await env.LIMITER.configure('tenant-a', limits);
    await env.LIMITER.configure('tenant-b', {
      ...limits,
      concurrency: 7,
    });

    const [a, b] = await Promise.all([
      env.LIMITER.stats('tenant-a'),
      env.LIMITER.stats('tenant-b'),
    ]);

    expect(a.config.concurrency).toBe(3);
    expect(b.config.concurrency).toBe(7);
  });

  it('reports the stats of the limiter it was asked about', async () => {
    await env.LIMITER.configure('stats-route', limits);
    await env.LIMITER.execute('stats-route', async () => ({
      value: null,
      status: 200,
    }));

    const stats = await env.LIMITER.stats('stats-route');
    expect(stats.tokens).toBeGreaterThan(18);
    expect(stats.penalised).toBe(false);
    expect(stats.active).toBe(0);
    expect(stats.state.forcedUntil).toBe(0);
  });

  it('answers liveness with the envelope version it was built against', async () => {
    await expect(env.LIMITER.ping()).resolves.toEqual({
      ok: true,
      envelopeVersion: 1,
    });
  });
});
