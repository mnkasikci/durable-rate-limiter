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
const limits: LimiterConfig = {
  bucket: { limitPerWindow: 5000, windowInMs: 60_000 },
  concurrency: 3,
};

describe('LimiterEntrypoint', () => {
  it('forwards the callback two hops and still runs it here', async () => {
    // consumer → service binding → limiter Worker → Durable Object. The handle
    // is forwarded a second time and the callback still resolves back into
    // this isolate, which is the whole topology in one assertion.
    await env.LIMITER.configure('two-hop', limits);
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

  it('lists every limiter it has been asked to configure', async () => {
    // The one call that is not about a single named bucket. It goes to the
    // reserved registry instance, because a namespace cannot be enumerated and
    // `idFromName` cannot be run backwards.
    await env.LIMITER.configure('tenant-a', limits);

    const names = await env.LIMITER.listNames();
    expect(names).toContain('tenant-a');
  });

  it('patches one limiter without restating the rest of it', async () => {
    // `reconfigure` carries no name to the object: an existing bucket is
    // already in the registry, so a modification has nothing to record.
    await env.LIMITER.configure('patch-route', limits);
    await env.LIMITER.reconfigure('patch-route', { concurrency: 11 });

    const stats = await env.LIMITER.stats('patch-route');
    expect(stats.config.concurrency).toBe(11);
    expect(stats.config.bucket).toEqual(limits.bucket);
    expect(await env.LIMITER.listNames()).toContain('patch-route');
  });

  it('reports the stats of the limiter it was asked about', async () => {
    await env.LIMITER.configure('stats-route', limits);
    await env.LIMITER.execute('stats-route', async () => ({
      value: null,
      status: 200,
    }));

    const stats = await env.LIMITER.stats('stats-route');
    expect(stats.remaining).toBe(4999);
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
