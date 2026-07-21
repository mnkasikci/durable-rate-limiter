// Stands in for a consumer's `wrangler types` output.
//
// `defineBinder` is typed against the global `Env` interface, which consumers
// get from `wrangler types` and which this package declares empty so the two
// merge. The suite needs a populated one to prove both halves of the check: a
// real Durable Object binding compiles, and a typo or a KV binding does not.
import type { LimiterDO } from '../src/do/index.js';

declare global {
  interface Env {
    RATE_LIMITER: DurableObjectNamespace<LimiterDO>;
    /** Not a Durable Object namespace — `defineBinder` must reject this key. */
    SETTINGS: KVNamespace;
  }
}

export {};
