import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_VERSION as clientVersion } from '../src/client/index.js';
import { ENVELOPE_VERSION as doVersion } from '../src/do/index.js';
import { NO_SUCH_LIMITER, isNoSuchLimiter } from '../src/core/index.js';

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

describe('isNoSuchLimiter', () => {
  it('recognises the marker wherever it sits in the message', () => {
    // The runtime prefixes the original class name onto the message on its way
    // across, so the token cannot be assumed to be at position 0.
    expect(isNoSuchLimiter(new Error(`${NO_SUCH_LIMITER} gone`))).toBe(true);
    expect(
      isNoSuchLimiter(
        new Error(`LimiterNotConfiguredError: ${NO_SUCH_LIMITER} gone`)
      )
    ).toBe(true);
    expect(isNoSuchLimiter(`${NO_SUCH_LIMITER} as a bare string`)).toBe(true);
  });

  it('answers false for anything it does not recognise', () => {
    // False is the safe answer: it costs a retry, where a false positive would
    // turn a transient drop into a permanent failure.
    expect(isNoSuchLimiter(new Error('Network connection lost.'))).toBe(false);
    expect(isNoSuchLimiter(undefined)).toBe(false);
    expect(isNoSuchLimiter(null)).toBe(false);
    expect(isNoSuchLimiter({ message: NO_SUCH_LIMITER })).toBe(false);
  });
});
