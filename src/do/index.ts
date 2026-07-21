// Public entrypoint for `@bakidev/durable-rate-limiter/do`.
//
// A consumer's limiter Worker re-exports these and deploys them as a Worker of
// its own — the object never lives inside a consuming application. Two
// platform constraints force that: a Worker implementing a Durable Object gets
// no preview URLs, and a new DO migration cannot be uploaded as a version. It
// is required anyway for multi-application use, since a limiter several
// independent apps share cannot live inside one of them.
//
// Module scope must stay inert: no I/O, no timers, no side effects.
export { ENVELOPE_VERSION, type CallReport } from '../core/index.js';
export {
  LimiterDO,
  DEFAULT_LIMITER_CONFIG,
  envelopeRetryDelay,
  type LimiterConfig,
  type LimiterStats,
} from './limiter-do.js';
export {
  LimiterEntrypoint,
  type LimiterEnv,
  type LimiterPing,
  // The generics RPC erases, declared back. A consumer types its service
  // binding as `LimiterService`; anyone taking the `script_name` escape hatch
  // and binding the object directly asserts the stub to `LimiterRpc`.
  type LimiterRpc,
  type LimiterService,
} from './entrypoint.js';

// A Worker that exports a WorkerEntrypoint still needs its own default export
// for HTTP. Consumers use the named RPC entrypoint above; this is liveness
// only, and it is also all a preview-less Worker can usefully answer with.
export default {
  fetch(): Response {
    return new Response('durable-rate-limiter', { status: 200 });
  },
};
