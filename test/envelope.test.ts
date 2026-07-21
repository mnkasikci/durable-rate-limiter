import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_VERSION as clientVersion } from '../src/client/index.js';
import { ENVELOPE_VERSION as doVersion } from '../src/do/index.js';

describe('envelope', () => {
  it('is one definition shared by both halves', () => {
    expect(clientVersion).toBe(doVersion);
  });

  it('matches the version the deployed limiter reports', async () => {
    // What a consumer does at startup: compare its own bundled version
    // against the one the deployed Worker answers with, so skew fails loudly
    // instead of silently mis-limiting.
    await expect(env.LIMITER.ping()).resolves.toEqual({
      ok: true,
      envelopeVersion: clientVersion,
    });
  });
});
