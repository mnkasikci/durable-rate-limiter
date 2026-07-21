import { DurableObject } from 'cloudflare:workers';

import { ENVELOPE_VERSION } from '../core/index.js';

/**
 * Scaffold only — no limiter logic yet.
 *
 * It exists so the toolchain is wired end to end (wrangler can resolve the
 * class, `vitest-pool-workers` can back the real binding with a local Durable
 * Object). The bucket, the queue and the RPC surface are still to be written.
 *
 * Constructor stays inert: no timers, no eager storage reads. State is read
 * lazily and refilled from wall-clock elapsed time, so eviction reconstructs
 * the correct token count rather than a full bucket.
 */
export class RateLimiterDurableObject extends DurableObject {
  envelopeVersion(): number {
    return ENVELOPE_VERSION;
  }
}
