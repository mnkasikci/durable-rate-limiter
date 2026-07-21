// Types the `env` that `cloudflare:test` hands the suites, from the bindings
// declared in wrangler.jsonc.
//
// Note both are the *declared* interfaces rather than `DurableObjectNamespace<
// LimiterDO>` / `Service<LimiterEntrypoint>`: RPC erases generics, so the
// generated stub types resolve `execute` to `never`, which then assigns to
// anything and quietly stops checking. See `LimiterRpc` for the measurement.
import type { LimiterDO, LimiterService } from '../src/do/index.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    RATE_LIMITER: DurableObjectNamespace<LimiterDO>;
    /** The self-referencing service binding, so the RPC hop is real. */
    LIMITER: LimiterService;
  }
}
