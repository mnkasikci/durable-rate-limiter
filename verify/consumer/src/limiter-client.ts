/**
 * The two topologies, behind one shape — so every route and the workflow can
 * be run either way with `&via=`.
 *
 *   via=service   consumer → service binding → limiter Worker → DO   (two hops)
 *   via=direct    consumer → DO bound cross-script (`script_name`)   (one hop)
 *
 * The package supports both deliberately: the entrypoint is the default
 * because it gives a declared interface and one home for the instance-name
 * convention, and the direct binding is a documented escape hatch. A harness
 * whose findings only held for one of them would not be evidence about the
 * package.
 *
 * `defineBinder` — the shipped client — only speaks Durable Object namespaces,
 * which is correct: a service binding is not one. To run the *client stack*
 * over the service topology as well, {@link binderFor} builds a binder over the
 * entrypoint using `defineTestBinder`, the package's named injection point. It
 * is doing exactly what it says: supplying something namespace-shaped.
 */

import {
  defineBinder,
  defineTestBinder,
  type Binder,
} from '../../../dist/client.js';
import type {
  CallReport,
  LimiterConfig,
  LimiterRpc,
  LimiterStats,
} from '../../../dist/do.js';

import type { Via } from './collector.js';

export type { Via };

export function parseVia(raw: string | null): Via {
  return raw === 'direct' ? 'direct' : 'service';
}

/**
 * The admin/raw surface: `configure` and `stats` have no client-side wrapper
 * (they are setup and observability, not per-call), and `execute` is here so
 * the mechanism probes can hand the object a hand-built envelope without the
 * client layer in between.
 */
export interface LimiterAdmin {
  execute<T>(fn: () => Promise<CallReport<T>>): Promise<T>;
  configure(config: Partial<LimiterConfig>): Promise<void>;
  stats(): Promise<LimiterStats>;
}

export function limiterFor(env: Env, via: Via, name: string): LimiterAdmin {
  if (via === 'direct') {
    // The one line where the generic erasure is absorbed on this side. No
    // `as` is needed and that is the point: the stub's `execute` is `never`,
    // `never` is assignable to anything, and the loss is therefore completely
    // silent unless the surface is declared by hand — which `LimiterRpc` is.
    const stub: LimiterRpc = env.RATE_LIMITER.get(
      env.RATE_LIMITER.idFromName(name)
    );
    return stub;
  }

  const service = env.LIMITER;
  return {
    execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
      return service.execute(name, fn);
    },
    configure(config: Partial<LimiterConfig>): Promise<void> {
      return service.configure(name, config);
    },
    stats(): Promise<LimiterStats> {
      return service.stats(name);
    },
  };
}

/**
 * A `Binder` for either topology, so the load generator exercises the real
 * client stack — `read`, the hooks, envelope construction — rather than
 * hand-rolling envelopes.
 *
 * For `direct` this is the shipped, type-checked `defineBinder`. For `service`
 * it is `defineTestBinder` over a namespace-shaped adapter whose "stub"
 * forwards to the entrypoint. Note the shape being satisfied is two methods,
 * `idFromName` and `get`; the id is just the instance name.
 *
 * Called per request rather than at module scope because the service adapter
 * needs `env`. The module-scope idiom in the README is the right one for an
 * application with a fixed topology; this harness has two.
 */
export function binderFor(env: Env, via: Via): Binder {
  if (via === 'direct') return defineBinder('RATE_LIMITER');
  return defineTestBinder<string>({
    idFromName: (name) => name,
    get: (name) => ({
      execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
        return env.LIMITER.execute(name, fn);
      },
    }),
  });
}

export function describeVia(via: Via): string {
  return via === 'direct'
    ? 'consumer → DO (cross-script, one hop)'
    : 'consumer → service binding → limiter Worker → DO (two hops)';
}
