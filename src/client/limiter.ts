/**
 * The three-object model consuming applications actually use.
 *
 * ```ts
 * const binder  = defineBinder('RATE_LIMITER');                  // WHICH binding
 * const limiter = defineLimiter({ binder, name: 'google-docs' }); // WHICH bucket + defaults
 * const bound   = limiter.for(env);                               // per request
 * await bound.call(fn, { read });                                 // per call
 * ```
 *
 * The first two lines belong at module scope and the last two inside a request
 * handler. That split is a hard platform constraint, not a style: `env` does
 * not exist at module scope, and Workers rejects timers there with a failure
 * that appears **only at deploy time**, never locally. `defineBinder` and
 * `defineLimiter` therefore capture configuration and do nothing else — no I/O,
 * no timers, no `env`.
 *
 * Putting `name` in the limiter definition means `idFromName` is written
 * exactly once per limiter. Not cosmetic: a mistyped instance name does not
 * error, it silently creates a *second* bucket, and each paces at the full
 * configured rate against one upstream quota. The failure surfaces later as
 * unexplained 429s from an upstream nobody was over-calling.
 */

import type { CallReport } from '../core/index.js';

import type { Binder, LimiterStub } from './binder.js';
import {
  resolveHook,
  type ErrorHook,
  type HookSlot,
  type RateLimitHook,
} from './hooks.js';

/**
 * What one limiter is: a binding, a bucket name, and the defaults that travel
 * with them.
 *
 * The hooks live here rather than at each call site because an API's
 * rate-limit convention is a property of the API, not of the endpoint. One
 * limiter is typically used from many call sites; written once, exported,
 * reused.
 */
export interface LimiterDefinition {
  binder: Binder;
  /** The instance name — `idFromName`'s argument. Selects the bucket. */
  name: string;
  /** Default rate-limit detection for this API. */
  rateLimit?: RateLimitHook | null;
  /** Default error detection for this API. */
  error?: ErrorHook | null;
}

/** Per-call configuration. `read` is required; the hooks refine the defaults. */
export interface CallOptions<T> {
  /**
   * Extract the small thing the caller actually needs, while the body stays
   * local.
   *
   * This is what keeps `value` small, and the envelope small is the whole
   * reason the design works. For a large download, do the entire job in here
   * and return an identifier:
   *
   * ```ts
   * { read: async (res) => (await uploadToDrive(res.body!, folderId)).id }
   * ```
   */
  read: (res: Response) => T | Promise<T>;
  /** Overrides the limiter default for this endpoint; `null` opts out. */
  rateLimit?: HookSlot<RateLimitHook<T>>;
  /** Overrides the limiter default for this endpoint; `null` opts out. */
  error?: HookSlot<ErrorHook<T>>;
}

/** A limiter with an `env`. The per-request object. */
export interface BoundLimiter {
  /**
   * Run `fn` under the shared limiter and return what `read` extracted.
   *
   * ⚠️ `fn` is re-invoked **from scratch** on every retry, so it must construct
   * its own request each time:
   *
   * ```ts
   * // ✅ fresh request per attempt
   * call(() => fetch(url, { method: 'POST', body: JSON.stringify(payload) }), { read });
   *
   * // ❌ body already consumed on attempt two
   * const req = new Request(url, { method: 'POST', body });
   * call(() => fetch(req), { read });
   * ```
   *
   * The second form fails on retry with a "body already used" error that looks
   * nothing like a retry problem.
   */
  call<T>(
    fn: () => Response | Promise<Response>,
    options: CallOptions<T>
  ): Promise<T>;
}

/** Inert captured configuration. Safe to hold in a module-scope `const`. */
export interface Limiter {
  /** The instance name this limiter paces against. */
  readonly name: string;
  /**
   * Bind to a request's `env`. The first moment `env` exists, and therefore the
   * moment the binding's presence is checked.
   */
  for(env: object): BoundLimiter;
}

/**
 * Turn a `Response` into the envelope, applying the three layers.
 *
 * `read` runs first because both hooks are handed the parsed body — and it runs
 * on error responses too. A `read` that cannot cope with an error body will
 * throw from here, which propagates and is retried as an unknown error; a
 * limiter whose upstream returns a different shape on failure should read
 * defensively.
 *
 * Nothing in here throws on a non-2xx. That is rule one of the design: throwing
 * loses the status, and the status is what the object classifies on.
 */
async function buildReport<T>(
  res: Response,
  options: CallOptions<T>,
  defaults: LimiterDefinition
): Promise<CallReport<T>> {
  const value = await options.read(res);

  // Layer 3, unconditional and first: a real HTTP 429 with a real `Retry-After`
  // is a rate limit whatever the hooks say. Applying it before the hooks run
  // means a hook can only add to this, never quietly erase it.
  const report: CallReport<T> = {
    value,
    status: res.status,
    retryAfter: res.headers.get('Retry-After'),
  };

  const limit = resolveHook(res, value, options.rateLimit, defaults.rateLimit);
  if (limit !== null) {
    // "Treat exactly as an HTTP 429" — said in the one vocabulary the object
    // already understands, so it needs no knowledge of this upstream.
    report.status = 429;
    if (limit.retryAfterMs !== undefined) {
      report.retryAfterMs = limit.retryAfterMs;
    }
  }

  const failure = resolveHook(res, value, options.error, defaults.error);
  if (failure !== null) {
    // Reported, not thrown: `retryable` is a custom property, and custom
    // properties do not survive the RPC boundary on an Error.
    report.failure = failure;
  }

  return report;
}

/**
 * Capture one limiter's configuration. Module scope; performs nothing.
 *
 * ```ts
 * export const driveLimiter = defineLimiter({
 *   binder,
 *   name: 'google-docs',
 *   rateLimit: (res, body) =>
 *     (body as DriveError)?.error?.status === 'RESOURCE_EXHAUSTED'
 *       ? { retryAfterMs: 60_000 }
 *       : null,
 *   error: (res, body) =>
 *     (body as DriveError)?.error
 *       ? { message: (body as DriveError).error.message, retryable: res.status >= 500 }
 *       : null,
 * });
 * ```
 */
export function defineLimiter(definition: LimiterDefinition): Limiter {
  return {
    name: definition.name,
    for(env: object): BoundLimiter {
      // Resolved once per request rather than per call: the presence check is
      // the point of this step, and a caller making ten calls should hear about
      // a mistyped binding once, before any of them run.
      const stub: LimiterStub = definition.binder.stubFor(env, definition.name);
      return {
        call<T>(
          fn: () => Response | Promise<Response>,
          options: CallOptions<T>
        ): Promise<T> {
          // The handle crosses to the object; the call itself runs back here.
          // An unexpected throw from inside `fn` — a genuine bug, a network
          // failure — is deliberately not caught: it propagates and is retried
          // as an unknown error, which is the correct default for something
          // carrying no retryability information at all.
          return stub.execute<T>(async () =>
            buildReport(await fn(), options, definition)
          );
        },
      };
    },
  };
}
