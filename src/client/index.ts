// Public entrypoint for `@bakidev/durable-rate-limiter/client`.
//
// This is what consuming applications import. Everything here must be safe to
// evaluate at module scope — `defineBinder` and `defineLimiter` perform no I/O
// and start no timers, so a configured limiter can be a module-scope singleton.
// `CallReport` is re-exported here and from `./do` deliberately: both halves
// take it from src/core/envelope.ts, so the two entrypoints can never be built
// against different definitions of the wire shape.
export { ENVELOPE_VERSION, type CallReport } from '../core/index.js';

// defineBinder / defineTestBinder / defineLimiter land here.
