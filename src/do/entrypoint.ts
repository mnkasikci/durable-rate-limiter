import { WorkerEntrypoint } from 'cloudflare:workers';

import { ENVELOPE_VERSION, type CallReport } from '../core/index.js';

import { REGISTRY_NAME } from './limiter-do.js';
import type { LimiterConfig, LimiterDO, LimiterStats } from './limiter-do.js';

/**
 * The bindings a limiter Worker must declare. One namespace; every named
 * limiter is an instance on it.
 */
export interface LimiterEnv {
  RATE_LIMITER: DurableObjectNamespace<LimiterDO>;
}

/** What `ping()` answers with. Concrete, so it survives the RPC boundary. */
export interface LimiterPing {
  ok: true;
  envelopeVersion: number;
}

/**
 * The Durable Object's surface as seen through a stub, with the generics RPC
 * erases put back.
 *
 * Measured, not assumed: `DurableObjectStub<LimiterDO>['execute']` resolves to
 * **`never`** — and `never` is assignable to everything, so the loss does not
 * even produce an error at the call site, it just silently stops checking. It
 * happens for `execute<T>(fn: () => Promise<CallReport<T>>)` too, so the
 * received wisdom that a type parameter inferred from an argument survives the
 * boundary does not hold here.
 *
 * The runtime call is fine; only the type is gone. Widening a stub to this
 * interface confines the erasure to one line instead of letting `never` leak
 * into every consumer.
 */
export interface LimiterRpc {
  execute<T>(fn: () => Promise<CallReport<T>>): Promise<T>;
  /**
   * Create or restate a bucket, with a COMPLETE config — there is no default to
   * merge onto. `name` is the one the caller addressed this stub by: the object
   * cannot recover it, since `ctx.id.name` is `undefined` inside a Durable
   * Object, and it needs one to enter the registry.
   */
  configure(name: string, config: LimiterConfig): Promise<void>;
  /** Patch an existing bucket. Throws if there is nothing to patch. */
  reconfigure(patch: Partial<LimiterConfig>): Promise<void>;
  stats(): Promise<LimiterStats>;
  /** Registry-only. Called by a bucket about itself, never by a consumer. */
  registerName(name: string): Promise<void>;
  /** Registry-only. The repair for a listed name with no bucket behind it. */
  unregisterName(name: string): Promise<void>;
  /** Registry-only. Every bucket name this namespace has served. */
  listNames(): Promise<string[]>;
}

/** The same, for the service binding. What a consumer's binding should be typed as. */
export interface LimiterService {
  execute<T>(name: string, fn: () => Promise<CallReport<T>>): Promise<T>;
  configure(name: string, config: LimiterConfig): Promise<void>;
  reconfigure(name: string, patch: Partial<LimiterConfig>): Promise<void>;
  stats(name: string): Promise<LimiterStats>;
  listNames(): Promise<string[]>;
  ping(): Promise<LimiterPing>;
}

/**
 * The RPC surface consuming applications bind to.
 *
 * Its whole job is turning `(name, fn)` into `stub(name).execute(fn)`. That
 * indirection buys three things: a declared interface that can evolve
 * independently of the object's class name, one place where the
 * instance-name convention lives, and somewhere for metrics, auth and
 * per-consumer policy to go later.
 *
 * The extra hop costs nothing measurable — a service binding and a direct
 * cross-script binding differ by ~2 ms warm, all of it noise against
 * cold-start. Consumers may bypass this and bind `LimiterDO` directly with
 * `script_name`; that is a supported escape hatch, but it couples every
 * consumer to the object's class name, so it is not the default.
 *
 * `fn` runs in the ORIGINAL caller's isolate — two hops away from here, not in
 * this Worker and not in the Durable Object. The handle arrives here over the
 * service binding and is forwarded again to the object; the callback still
 * resolves back to the consumer.
 *
 * NOTE: this must stay a **named** export. A service binding with
 * `"entrypoint": "LimiterEntrypoint"` resolves against named exports only —
 * `export default class LimiterEntrypoint` typechecks and then fails at
 * startup with "has no such named entrypoint". The Worker's own default
 * export lives separately, in `./index.ts`.
 */
export class LimiterEntrypoint
  extends WorkerEntrypoint<LimiterEnv>
  implements LimiterService
{
  /**
   * The one place the instance-name convention lives — and the one place the
   * generic erasure described on `LimiterRpc` is absorbed.
   */
  #stub(name: string): LimiterRpc {
    // The return annotation is doing real work: the generated stub type has
    // `execute` as `never`, and widening it here is what stops that `never`
    // reaching consumers. No cast is needed, precisely because `never` is
    // assignable to anything — which is also why the erasure is so quiet.
    //
    // `get(idFromName(...))` rather than `getByName(...)`: identical behaviour,
    // but it keeps the wrangler/workerd floor as low as the client binder and
    // the tests, which all use this form.
    return this.env.RATE_LIMITER.get(this.env.RATE_LIMITER.idFromName(name));
  }

  /** Schedule `fn` against the limiter called `name`. */
  execute<T>(name: string, fn: () => Promise<CallReport<T>>): Promise<T> {
    return this.#stub(name).execute(fn);
  }

  /**
   * Create one named limiter, or restate it, with a COMPLETE set of limits — a
   * bucket that has never been configured does not exist and refuses to
   * `execute`, rather than inventing a rate. A setup call, not a per-request
   * one.
   */
  configure(name: string, config: LimiterConfig): Promise<void> {
    return this.#stub(name).configure(name, config);
  }

  /**
   * Adjust one that already exists. No name reaches the object: an existing
   * bucket is already registered, so a modification has nothing to record.
   */
  reconfigure(name: string, patch: Partial<LimiterConfig>): Promise<void> {
    return this.#stub(name).reconfigure(patch);
  }

  /** Remaining window allowance, penalty state and the raw persisted pair. */
  stats(name: string): Promise<LimiterStats> {
    return this.#stub(name).stats();
  }

  /**
   * Every bucket name in use — the one question that cannot be answered by
   * addressing a bucket, since a namespace has no `list()` and `idFromName` is
   * one-way. It is answered by the reserved registry instance, which each
   * bucket enters when it is configured.
   */
  listNames(): Promise<string[]> {
    return this.#stub(REGISTRY_NAME).listNames();
  }

  /**
   * Liveness, and the cheapest possible skew check: the two halves deploy on
   * independent schedules, so a consumer can compare this against its own
   * `ENVELOPE_VERSION` at startup instead of discovering the mismatch as
   * silent mis-limiting.
   */
  ping(): Promise<LimiterPing> {
    return Promise.resolve({ ok: true, envelopeVersion: ENVELOPE_VERSION });
  }
}
