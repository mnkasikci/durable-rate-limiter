// Public entrypoint for `@bakidev/durable-rate-limiter/client`.
//
// This is what consuming applications import. Everything here must be safe to
// evaluate at module scope — `defineBinder` and `defineLimiter` perform no I/O
// and start no timers, so a configured limiter can be a module-scope singleton.
export { ENVELOPE_VERSION } from '../core/index.js';

// defineBinder / defineTestBinder / defineLimiter land here.
