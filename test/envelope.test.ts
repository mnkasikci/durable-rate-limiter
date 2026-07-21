import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_VERSION as clientVersion } from '../src/client/index.js';
import { ENVELOPE_VERSION as doVersion } from '../src/do/index.js';
import { type RateLimiterDurableObject } from '../src/do/rate-limiter.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    RATE_LIMITER: DurableObjectNamespace<RateLimiterDurableObject>;
  }
}

describe('envelope', () => {
  it('is one definition shared by both halves', () => {
    expect(clientVersion).toBe(doVersion);
  });

  it('matches the version the deployed object reports', async () => {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName('test'));
    await expect(stub.envelopeVersion()).resolves.toBe(clientVersion);
  });
});
