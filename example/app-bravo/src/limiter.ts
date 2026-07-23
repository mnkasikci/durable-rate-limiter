// The service-binding topology, adapted from `durable-rate-limiter init` to
// import from the built package rather than the published name.
//
// Define at module scope, bind and call where you have `env`: `defineLimiter`
// and `defineTestBinder` do no I/O and start no timers, so this module is safe
// to evaluate at startup. `env` does not exist here anyway, which is why the
// binder is built inside a per-request function below.
import {
  defineLimiter,
  defineTestBinder,
  type Binder,
  type BoundLimiter,
  type DropHook,
} from '../../../dist/client.js';
import type { CallReport, LimiterService } from '../../../dist/do.js';

import { BUCKET_NAME } from '../../shared/protocol.js';

// Type the binding as `LimiterService`: RPC erases generics silently, so a raw
// stub type at a call site would typecheck a completely wrong call. `env.d.ts`
// adds this app's other bindings; both declarations merge.
declare global {
  interface Env {
    LIMITER: LimiterService;
  }
}

// `defineBinder` — the shipped client — only speaks Durable Object namespaces,
// which is correct: a service binding is not one. To reach the limiter over the
// service topology, the binder is built over the entrypoint with
// `defineTestBinder`, the package's named injection point. It is doing exactly
// what it says: supplying something namespace-shaped. Built per request because
// the adapter needs `env`; everything here is still inert.
function binderFor(env: Env): Binder {
  return defineTestBinder<string>({
    idFromName: (name) => name,
    get: (name) => ({
      execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
        return env.LIMITER.execute(name, fn);
      },
    }),
  });
}

/**
 * The shared bucket, bound for one request.
 *
 * `name: BUCKET_NAME` is imported from `example/shared/protocol.ts` and written
 * nowhere else. A typo here would not error — it would silently pace against a
 * SECOND bucket at the full rate, against the same upstream quota — which is the
 * failure the shared constant exists to prevent, and the whole subject of the
 * demo: app-alpha and app-bravo coordinate by importing one string.
 *
 * `onDrop` is per request so it can name which request was dropped: a re-queue
 * the client absorbed is streamed into the burst's event log, because a drop
 * the retry recovered from should still be visible on the dashboard rather than
 * hidden. A silent retry cannot be sized.
 */
export function upstreamLimiterFor(env: Env, onDrop: DropHook): BoundLimiter {
  return defineLimiter({
    binder: binderFor(env),
    name: BUCKET_NAME,
    onDrop,
  }).for(env);
}
