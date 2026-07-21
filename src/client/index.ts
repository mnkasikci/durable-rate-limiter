// Public entrypoint for `@bakidev/durable-rate-limiter/client`.
//
// This is what consuming applications import. Everything here must be safe to
// evaluate at module scope — `defineBinder` and `defineLimiter` perform no I/O
// and start no timers, so a configured limiter can be a module-scope singleton.
// `CallReport` is re-exported here and from `./do` deliberately: both halves
// take it from src/core/envelope.ts, so the two entrypoints can never be built
// against different definitions of the wire shape.
export { ENVELOPE_VERSION, type CallReport } from '../core/index.js';

export {
  defineBinder,
  defineTestBinder,
  type Binder,
  type DoBindings,
  // The generics RPC erases, declared back by hand. Exported so a consumer
  // taking the `script_name` escape hatch has the same one-line assertion
  // available instead of letting a `never`-typed stub reach a call site.
  type LimiterStub,
  type NamespaceLike,
} from './binder.js';

export {
  CallDroppedError,
  DEFAULT_DROP_RETRIES,
  type DropEvent,
  type DropHook,
} from './dropped.js';

export {
  type ErrorHook,
  type FailureDescription,
  type HookSlot,
  type RateLimitHook,
  type RateLimitSignal,
} from './hooks.js';

export {
  defineLimiter,
  type BoundLimiter,
  type CallOptions,
  type Limiter,
  type LimiterDefinition,
} from './limiter.js';
