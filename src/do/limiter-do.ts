import { DurableObject } from 'cloudflare:workers';

import type { LimiterRpc } from './entrypoint.js';
import {
  DEFAULT_CONCURRENCY,
  Scheduler,
  TokenBucket,
  createStatusClassifier,
  defaultRetryDelay,
  readRetryAfterMs,
  type BucketOptions,
  type BucketState,
  type CallReport,
  type ResultClassifier,
  type RetryContext,
  type RetryOptions,
} from '../core/index.js';

/**
 * A global pacer for one upstream API, shared across every caller and every
 * isolate. Addressed by `idFromName(name)`, so `example-api`, `billing-api` and
 * `search-api` are independent buckets on one class and one binding.
 *
 * ## The mechanism
 *
 * `execute(fn)` takes a **function**, not a request. Workers RPC does not
 * serialise functions — it passes a handle, and invoking that handle calls
 * back into the isolate the function came from. So this object decides *when*
 * the work runs while the work itself runs *in the caller*.
 *
 * Everything the design claims follows from that inversion:
 *
 *  - **Payloads never transit this object.** A multi-megabyte download happens
 *    caller-side and never touches a single-threaded object.
 *  - **No credentials cross.** The caller builds its own request; this object
 *    is upstream-agnostic and parses nothing but `{ status, retryAfter }`.
 *  - **Timing is enforced, not requested.** A caller cannot fire early.
 *  - **Concurrency is real**, because the object awaits the callback and so
 *    knows when work *finishes*, not merely when it started.
 *  - **Backpressure is automatic.** A rate-limit response passes back through
 *    here, so it throttles every other caller with no reporting protocol for
 *    anyone to forget to implement.
 *
 * ## What is durable and what is not
 *
 * Bucket state and config are persisted, so eviction cannot reset the limiter
 * to a full burst against someone else's quota. The **wait queue is
 * memory-only and cannot be otherwise**: an RPC function handle cannot be
 * stored for later use. A queued caller is itself awaiting this object, which
 * keeps it pinned in memory — but it is not rare enough to ignore: measured at
 * 2.4% of calls under load against a real deployment, 7 of 290 across four
 * runs (see `verify/`).
 *
 * `execute` is therefore throwable, and the client half retries it rather than
 * leaving it to every consumer. It can do that safely because the callback
 * runs in the caller's isolate, so the caller knows whether it ever fired: if
 * it did not, nothing reached the upstream. Nothing on this side needs to
 * change for that, and nothing on this side should try to — see
 * `src/client/dropped.ts`.
 */

/** Storage keys. Stable: renaming one silently resets every deployed limiter. */
const STATE_KEY = 'bucket-state';
const CONFIG_KEY = 'config';

/** The limits of one named limiter. Persisted verbatim, so keep it cloneable. */
export interface LimiterConfig {
  bucket: BucketOptions;
  /** Calls actually in flight, measured by awaiting each callback. */
  concurrency: number;
  /** Merged with the scheduler defaults, never swapped in wholesale. */
  retry?: Partial<RetryOptions>;
}

/**
 * Sized by the rule that bites everyone once: worst-case throughput is
 * `capacity + fillPerWindow`, not `fillPerWindow`. This delivers at most 60 in
 * a rolling minute, which is the shape of a documented 60/min upstream cap.
 */
export const DEFAULT_LIMITER_CONFIG: LimiterConfig = {
  bucket: { capacity: 10, fillPerWindow: 50, windowInMs: 60_000 },
  concurrency: DEFAULT_CONCURRENCY,
};

/**
 * What `stats()` reports. A concrete interface, not an inferred return type:
 * RPC erases generics and is happier with a declared shape it can round-trip.
 */
export interface LimiterStats {
  /** Live token count, refilled to now. Fractional. */
  tokens: number;
  /** Whether a penalty window is currently in force. */
  penalised: boolean;
  /** Epoch ms the penalty expires; `0` when there is none. */
  forcedUntil: number;
  /** Calls in flight right now. */
  active: number;
  /** The raw persisted triple. */
  state: BucketState;
  /** The limits actually in effect, after any `configure`. */
  config: LimiterConfig;
}

/** The runtime a limiter lazily builds around its restored state. */
interface Runtime {
  config: LimiterConfig;
  bucket: TokenBucket;
  scheduler: Scheduler<CallReport<unknown>>;
}

/**
 * Reads the envelope's explicit delay: `retryAfterMs` first, then the raw
 * `Retry-After` value.
 *
 * `readRetryAfterMs` already prefers a number over a header and handles both
 * seconds and HTTP-date, and is already tested; handing it a carrier shaped
 * the way it expects reuses that precedence rather than restating it here and
 * growing a second date parser that will drift from the first.
 */
function envelopeRetryAfterMs(
  report: CallReport<unknown> | undefined,
  now: number
): number | undefined {
  if (report === undefined) return undefined;
  return readRetryAfterMs(
    {
      retryAfterMs: report.retryAfterMs,
      headers: { 'Retry-After': report.retryAfter },
    },
    now
  );
}

/**
 * The envelope's own delay when it carries one, the standard policy
 * otherwise.
 *
 * Pure, and it must stay pure: the scheduler also calls this on the plain
 * error path, so pausing the bucket here would throttle every other caller
 * because one unrelated call hit a network blip. Backpressure belongs on the
 * rate-limited branch, where the scheduler already applies it.
 */
export function envelopeRetryDelay(
  context: RetryContext<CallReport<unknown>>
): number {
  if (context.retry.respectRetryAfter) {
    const explicit = envelopeRetryAfterMs(context.result, context.now);
    if (explicit !== undefined) {
      return Math.min(explicit, context.retry.maxDelayInMs);
    }
  }
  return defaultRetryDelay(context);
}

/**
 * Envelope → verdict. The one place `report.failure` is read.
 *
 * It lives here and not in the scheduler because the scheduler must not know
 * what an envelope is: the core speaks `failed`/`retryable`/`message` and this
 * maps the wire shape onto that vocabulary. Errors keep the default HTTP-ish
 * treatment — a throw arrives stripped of every custom property, so there is
 * nothing better to read on that side.
 *
 * `failure` and a 429 can arrive together; the scheduler resolves the
 * precedence (rate limit first) so both are simply reported.
 */
export function createEnvelopeClassifier(): ResultClassifier<
  CallReport<unknown>
> {
  const base = createStatusClassifier<CallReport<unknown>>();
  return {
    classifyResult: (report) => ({
      isRateLimited: report.status === 429,
      failed: report.failure !== undefined,
      retryable: report.failure?.retryable ?? false,
      // Spread rather than assigned: `exactOptionalPropertyTypes` treats an
      // explicit `undefined` as a different thing from an absent key.
      ...(report.failure === undefined
        ? {}
        : { message: report.failure.message }),
    }),
    classifyError: base.classifyError,
  };
}

export class LimiterDO extends DurableObject implements LimiterRpc {
  /**
   * Memoised as a *promise*, not a value. Two concurrent `execute` calls that
   * both await a storage read would otherwise each build a bucket, and the
   * second would discard the first along with everyone queued on it.
   */
  #runtime: Promise<Runtime> | undefined;

  /**
   * Schedule `fn` against this limiter's shared limits and return whatever it
   * reported. `fn` runs in the CALLER's isolate — see the class docs.
   *
   * An envelope carrying `failure` does not resolve: a non-retryable one
   * rejects at once, a retryable one after the retries are spent. The
   * rejection is a `CallFailedError`, which crosses back stripped to its
   * message — everything worth keeping is in there.
   *
   * `T` is inferred from the argument, which is the one form of generic that
   * survives an RPC stub: a type parameter chosen at the call site collapses
   * to `never` through the boundary, one inferred from a parameter does not.
   *
   * ⚠️ `fn` is re-invoked from scratch on every retry, so it must build a
   * fresh request each time — a closed-over `Request` fails the second attempt
   * with a spent body.
   */
  async execute<T>(fn: () => Promise<CallReport<T>>): Promise<T> {
    const { scheduler } = await this.#ready();
    const report = await scheduler.call(
      async (): Promise<CallReport<unknown>> => fn()
    );
    return report.value as T;
  }

  /**
   * Override the limits for this named instance.
   *
   * Persisted, so it survives eviction, and it invalidates the cached runtime
   * so the new limits take effect on the next call. A setup call, not a
   * per-request one: rebuilding the bucket rejects anyone currently queued,
   * which is the honest signal that their wait will never be satisfied under
   * the limits they were waiting on.
   */
  async configure(patch: Partial<LimiterConfig>): Promise<void> {
    const current = await this.#ready();
    const next: LimiterConfig = { ...current.config, ...patch };

    // Construct before persisting: an invalid bucket shape must fail the
    // caller's `configure` rather than being written and then wedging every
    // later `execute` on a restore that throws.
    new TokenBucket(next.bucket).destroy();

    await this.ctx.storage.put(CONFIG_KEY, next);
    this.#runtime = undefined;
    current.bucket.destroy();
  }

  /**
   * Observability — what an in-process limiter can never expose to an
   * operator. A shared limiter nobody can inspect is a shared limiter nobody
   * will trust.
   */
  async stats(): Promise<LimiterStats> {
    const { bucket, scheduler, config } = await this.#ready();
    // One clock reading for the whole answer: Date.now() is frozen between
    // I/O anyway, and two readings would let `tokens` and `penalised`
    // disagree about which instant they describe.
    const now = Date.now();
    const state = bucket.getState(now);
    return {
      tokens: state.tokens,
      penalised: state.forcedUntil > now,
      forcedUntil: state.forcedUntil,
      active: scheduler.active,
      state,
      config,
    };
  }

  #ready(): Promise<Runtime> {
    this.#runtime ??= this.#restore().catch((error: unknown) => {
      // A rejected promise left memoised would wedge the object permanently:
      // every later call would replay the same failure without ever retrying
      // the read.
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  async #restore(): Promise<Runtime> {
    const [storedConfig, storedState] = await Promise.all([
      this.ctx.storage.get<LimiterConfig>(CONFIG_KEY),
      this.ctx.storage.get<BucketState>(STATE_KEY),
    ]);

    const config = storedConfig ?? DEFAULT_LIMITER_CONFIG;

    const bucket = new TokenBucket(config.bucket, {
      // A restored snapshot refills from wall-clock elapsed time at read time,
      // so an evicted limiter comes back with the token count it should have
      // rather than a fresh burst aimed at someone else's quota.
      ...(storedState === undefined ? {} : { state: storedState }),
      // Write-through on every mutation. DO output gates coalesce these, but
      // it is still a write per token taken — measure before assuming it is
      // free.
      onStateChange: (state) => {
        void this.ctx.storage.put(STATE_KEY, state);
      },
    });

    const scheduler = new Scheduler<CallReport<unknown>>({
      bucket,
      concurrency: config.concurrency,
      retry: config.retry ?? {},
      // Workers RPC reconstructs a thrown error from name/message/stack
      // alone, so a `status` or a `retryable` a caller attaches to an Error
      // does not survive the hop and every throw looks transient from in
      // here. That is why the envelope is the contract: a failure a caller
      // wants treated as final must be *reported*, and this classifier is
      // where the report is read.
      classify: createEnvelopeClassifier(),
      retryDelay: envelopeRetryDelay,
    });

    return { config, bucket, scheduler };
  }
}
