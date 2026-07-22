/**
 * The three-object model consuming applications actually use.
 *
 * ```ts
 * const binder  = defineBinder('RATE_LIMITER');                  // WHICH binding
 * const limiter = defineLimiter({ binder, name: 'example-api' }); // WHICH bucket + defaults
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

import { isNoSuchLimiter, type CallReport } from '../core/index.js';

import type { Binder, LimiterStub } from './binder.js';
import {
  CallDroppedError,
  NoSuchLimiterError,
  DEFAULT_DROP_RETRIES,
  type DropHook,
} from './dropped.js';
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
  /**
   * Re-queue attempts after being dropped **while parked**. Defaults to
   * {@link DEFAULT_DROP_RETRIES}; `0` opts out.
   *
   * Safe to leave on for non-idempotent work. The retry fires only when the
   * callback never ran, so there is nothing upstream to duplicate — see
   * {@link BoundLimiter.call}.
   */
  dropRetries?: number;
  /** Observe every drop, retried or not. See {@link DropHook}. */
  onDrop?: DropHook;
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
   * { read: async (res) => (await uploadToStorage(res.body!, folderId)).id }
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
   *
   * ## Being dropped while parked
   *
   * The object's queue is memory-only, so a caller waiting its turn can be
   * dropped if the object is evicted or reset — measured at 2.4% of calls
   * under load. This retries that by default, five times, so a call must be
   * dropped six separate times before it rejects with a
   * {@link CallDroppedError}.
   *
   * The discriminator is whether `fn` ever ran, which is knowable exactly
   * because `fn` runs in this isolate: if it never fired, no request was made
   * and a retry cannot duplicate anything. A connection lost *after* `fn`
   * started is never retried here — that one is genuinely ambiguous, and
   * guessing on the caller's behalf could send a payment twice.
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
 * export const apiLimiter = defineLimiter({
 *   binder,
 *   name: 'example-api',
 *   rateLimit: (res, body) =>
 *     (body as ApiError)?.error?.status === 'RATE_LIMIT_EXCEEDED'
 *       ? { retryAfterMs: 60_000 }
 *       : null,
 *   error: (res, body) =>
 *     (body as ApiError)?.error
 *       ? { message: (body as ApiError).error.message, retryable: res.status >= 500 }
 *       : null,
 * });
 * ```
 */
export function defineLimiter(definition: LimiterDefinition): Limiter {
  return {
    name: definition.name,
    for(env: object): BoundLimiter {
      // Resolved once per request rather than per call: the presence check is
      // the point of this step, and a caller making ten calls should hear
      // about a mistyped binding once, before any of them run.
      //
      // Mutable, because a handle whose connection has broken is worth
      // replacing exactly once for everyone rather than per call — see the
      // drop branch below.
      let stub: LimiterStub = definition.binder.stubFor(env, definition.name);

      const maxRetries = definition.dropRetries ?? DEFAULT_DROP_RETRIES;

      return {
        async call<T>(
          fn: () => Response | Promise<Response>,
          options: CallOptions<T>
        ): Promise<T> {
          for (let attempt = 1; ; attempt++) {
            /**
             * Whether the callback ever ran — the whole basis of the retry
             * decision, and knowable only because the callback runs in this
             * isolate rather than in the object.
             *
             * A holder rather than a bare `let`, because control-flow analysis
             * cannot see an assignment made inside a callback it did not
             * invoke: it would narrow the flag to `false` and report the check
             * below as always-falsy. A property read is re-widened by the
             * intervening call, which is exactly the truth here.
             */
            const ran = { fired: false };

            try {
              // The handle crosses to the object; the call itself runs back
              // here. An unexpected throw from inside `fn` — a genuine bug, a
              // network failure — is deliberately not caught: it propagates
              // and is retried by the OBJECT as an unknown error, which is the
              // correct default for something carrying no retryability
              // information at all.
              return await stub.execute<T>(async () => {
                ran.fired = true;
                return buildReport(await fn(), options, definition);
              });
            } catch (error) {
              // The callback ran, so whatever went wrong is a decision the
              // object already made — a `CallFailedError`, or retries spent.
              // Re-running the caller's work here would be a second request
              // nobody asked for.
              if (ran.fired) throw error;

              // Everything below is a failure that reached the caller before
              // its work ever started. RPC reconstructs a thrown value as an
              // Error, but a non-Error can still arrive from a test double or a
              // future runtime, and the hook's contract says `error` is an
              // Error.
              const cause =
                error instanceof Error ? error : new Error(String(error));

              // The fork. A bucket that does not exist is permanent: retrying
              // it cannot make it exist, and counting it as a drop would put
              // six phantom events into the one metric an operator has for
              // sizing real drops. It is almost always a mistyped instance
              // name, so it is reported as itself rather than buried under a
              // message about queueing.
              //
              // Matched on the message because nothing else survives: see
              // NO_SUCH_LIMITER. Anything unrecognised falls through to the
              // drop path, which costs a retry rather than a lost signal.
              if (isNoSuchLimiter(cause)) {
                throw new NoSuchLimiterError(definition.name, cause);
              }

              const willRetry = attempt <= maxRetries;

              // Reported before the retry, not after: a hook that only fires
              // on the final failure cannot measure a drop rate, which is the
              // number an operator actually needs.
              definition.onDrop?.({
                limiter: definition.name,
                attempt,
                willRetry,
                error: cause,
              });

              if (!willRetry) {
                throw new CallDroppedError(definition.name, attempt, cause);
              }

              // A fresh handle before going round again. The one we just used
              // is the thing whose connection broke, so reusing it would make
              // every retry an instant repeat of the same failure. Replacing
              // the shared one rather than a local means the next call does
              // not have to rediscover the breakage for itself.
              stub = definition.binder.stubFor(env, definition.name);
              // No backoff: the retry must re-acquire a token before it can
              // run, so the bucket's own pacing is already the wait.
            }
          }
        },
      };
    },
  };
}
