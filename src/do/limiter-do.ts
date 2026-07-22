import { DurableObject } from 'cloudflare:workers';

import type { LimiterEnv, LimiterRpc } from './entrypoint.js';
import {
  NO_SUCH_LIMITER,
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
/**
 * The name this bucket was configured under.
 *
 * Stored because it cannot be derived: `ctx.id.name` is `undefined` inside a
 * Durable Object — the name lives on the ID the *caller* built with
 * `idFromName`, and the object is handed one stripped of it. Persisting the one
 * `configure` supplies is what lets a bucket describe itself in `stats` and
 * re-register itself without being told who it is.
 */
const NAME_KEY = 'name';
/** The registry's name list. Only ever present on the registry instance. */
const NAMES_KEY = 'names';

/**
 * The instance that holds the list of every other instance's name.
 *
 * A namespace cannot be enumerated: there is no `list()`, and `idFromName` is
 * one-way, so even the REST API that lists objects returns IDs nobody can turn
 * back into names. Something therefore has to keep the list, and one reserved
 * instance of this same class is the cheapest thing that can — no second class,
 * no second binding, no migration.
 *
 * The leading space is what reserves it: `isValidInstanceName` in the CLI
 * rejects this string, so a real bucket can never collide with it.
 */
export const REGISTRY_NAME = ' registry';

/** The limits of one named limiter. Persisted verbatim, so keep it cloneable. */
export interface LimiterConfig {
  bucket: BucketOptions;
  /** Calls actually in flight, measured by awaiting each callback. */
  concurrency: number;
  /** Merged with the scheduler defaults, never swapped in wholesale. */
  retry?: Partial<RetryOptions>;
}

/**
 * Thrown by `execute`, `stats` and `reconfigure` on a bucket that does not
 * exist — which is the same thing as one that was never configured.
 *
 * There is deliberately no default configuration to fall back on. A limiter
 * nobody configured is almost always a mistyped instance name, and pacing it at
 * a plausible-looking default turns that typo into a *second* bucket running at
 * an invented rate against the same upstream quota: invisible, and exactly the
 * failure this package exists to prevent. A rate limit is never assumed.
 *
 * Refusing is also what makes an unconfigured bucket a non-entity rather than a
 * state. Nothing writes storage before `configure`, so such an object holds
 * zero bytes and is indistinguishable from one that was never addressed — which
 * is what lets `listNames` be trusted: every bucket that can run has been
 * configured, so every bucket that can run is in the registry.
 *
 * Only the MESSAGE survives the trip to a caller. Workers RPC delivers this as
 * a plain `Error` with `name === 'Error'` and every custom property stripped —
 * so both halves of what a caller needs have to be in the text: the remedy, for
 * a human, and {@link NO_SUCH_LIMITER}, for the client, which must not retry
 * this the way it retries a caller dropped in transit.
 */
export class LimiterNotConfiguredError extends Error {
  constructor() {
    super(
      `${NO_SUCH_LIMITER} No such limiter: it has never been configured, so it ` +
        'does not exist and does not know what rate to pace at. That is usually ' +
        'a mistyped instance name. Create it with `npx ' +
        '@bakidev/durable-rate-limiter configure`, or call ' +
        'configure(name, limits) from a deploy step.'
    );
    // Useful to anything catching this inside the object; erased on the way
    // out, which is what NO_SUCH_LIMITER is for.
    this.name = 'LimiterNotConfiguredError';
  }
}

/**
 * What `stats()` reports. A concrete interface, not an inferred return type:
 * RPC erases generics and is happier with a declared shape it can round-trip.
 */
export interface LimiterStats {
  /**
   * The name this bucket was configured under, so a stats blob identifies
   * itself. Read from storage rather than from the object's own ID, which
   * carries no name — see {@link REGISTRY_NAME} and `configure`.
   */
  name: string;
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
  name: string;
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

export class LimiterDO extends DurableObject<LimiterEnv> implements LimiterRpc {
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
   * Create this bucket, or restate it — with a **complete** set of limits.
   *
   * The config is not a patch. There is no default to merge onto, because a
   * rate limit is never assumed; see {@link LimiterNotConfiguredError}. To
   * adjust one field of a bucket that already exists, use {@link reconfigure}.
   *
   * `name` is what the caller addressed this object by. The object cannot work
   * it out for itself — `ctx.id.name` is `undefined` in here, because the name
   * lives on the ID the *caller* built with `idFromName` and the object is
   * handed one stripped of it — so it is passed in, persisted, and used to
   * enter the registry. This is the only call that carries it, and every live
   * bucket passes through here at least once, which is what makes
   * {@link listNames} trustworthy rather than best-effort.
   *
   * A setup call, not a per-request one: rebuilding the bucket rejects anyone
   * currently queued, which is the honest signal that their wait will never be
   * satisfied under the limits they were waiting on.
   *
   * ## Creation is all-or-nothing
   *
   * Registering and configuring must not come apart, and they are writes to two
   * different objects — so there is no transaction available to hold them
   * together, only a saga. Registration goes first, because the surviving
   * failure must be a name in the list with no bucket behind it (cosmetic, and
   * pruned on the next `stats`) and never a live bucket nobody can see. If the
   * config write then fails on a bucket that did not previously exist, the
   * registration is compensated and the object erases itself: nothing of value
   * existed yet, so leaving a half-built one behind serves nobody.
   *
   * That erasure is deliberately limited to creation. A failed *restatement* of
   * an existing bucket leaves it exactly as it was — wiping live token state
   * would hand out a full burst against someone else's quota on the next call,
   * which is the failure this package exists to prevent.
   */
  async configure(name: string, config: LimiterConfig): Promise<void> {
    // Construct before persisting: an invalid bucket shape must fail the
    // caller's `configure` rather than being written and then wedging every
    // later `execute` on a restore that throws.
    new TokenBucket(config.bucket).destroy();

    const existed =
      (await this.ctx.storage.get<LimiterConfig>(CONFIG_KEY)) !== undefined;

    await this.#registry().registerName(name);

    try {
      await this.ctx.storage.put(NAME_KEY, name);
      await this.ctx.storage.put(CONFIG_KEY, config);
    } catch (error: unknown) {
      if (!existed) await this.#abandon(name);
      throw error;
    }

    await this.#invalidate();
  }

  /**
   * Adjust the limits of a bucket that already exists.
   *
   * A patch, merged onto what is in force. Throws
   * {@link LimiterNotConfiguredError} when there is nothing to merge onto —
   * there is no base to invent one from, and a half-specified bucket is exactly
   * the thing `configure` refuses to create.
   *
   * It takes no name and touches no registry: an existing bucket is already
   * registered, so a modification has nothing to record. That is also why it
   * never erases anything on failure — the previous limits simply stay in
   * force.
   */
  async reconfigure(patch: Partial<LimiterConfig>): Promise<void> {
    const stored = await this.ctx.storage.get<LimiterConfig>(CONFIG_KEY);
    if (stored === undefined) throw new LimiterNotConfiguredError();

    const next: LimiterConfig = { ...stored, ...patch };
    new TokenBucket(next.bucket).destroy();

    await this.ctx.storage.put(CONFIG_KEY, next);
    await this.#invalidate();
  }

  /**
   * Observability — what an in-process limiter can never expose to an
   * operator. A shared limiter nobody can inspect is a shared limiter nobody
   * will trust.
   */
  async stats(): Promise<LimiterStats> {
    const { name, bucket, scheduler, config } = await this.#ready();
    // One clock reading for the whole answer: Date.now() is frozen between
    // I/O anyway, and two readings would let `tokens` and `penalised`
    // disagree about which instant they describe.
    const now = Date.now();
    const state = bucket.getState(now);
    return {
      name,
      tokens: state.tokens,
      penalised: state.forcedUntil > now,
      forcedUntil: state.forcedUntil,
      active: scheduler.active,
      state,
      config,
    };
  }

  /**
   * Record a bucket's name. Called on the registry instance and nowhere else.
   *
   * Idempotent, and called unconditionally rather than behind a per-bucket
   * "already registered" flag. Such a flag would be a second copy of a fact the
   * list already holds, and copies drift: a registry that lost its list could
   * never be repopulated, because every bucket would believe it had already
   * reported itself.
   *
   * Deliberately touches storage and nothing else: the registry is not a
   * limiter, and building a bucket and a scheduler for it would be state that
   * exists only to be ignored.
   */
  async registerName(name: string): Promise<void> {
    const names = (await this.ctx.storage.get<string[]>(NAMES_KEY)) ?? [];
    if (names.includes(name)) return;
    await this.ctx.storage.put(NAMES_KEY, [...names, name].sort());
  }

  /**
   * Forget a name — the compensating half of `configure`'s saga, and the repair
   * a reader performs when a listed name turns out to have no bucket behind it.
   *
   * Repair-on-read matters more than the compensation: a compensation only
   * fixes the failure that ran it, and can itself fail, whereas pruning while
   * listing corrects drift from any cause.
   */
  async unregisterName(name: string): Promise<void> {
    const names = (await this.ctx.storage.get<string[]>(NAMES_KEY)) ?? [];
    if (!names.includes(name)) return;
    await this.ctx.storage.put(
      NAMES_KEY,
      names.filter((held) => held !== name)
    );
  }

  /**
   * Every bucket in this namespace, so an operator can ask "what is running?"
   * without already knowing the answer — the one question that cannot be put to
   * a bucket, since addressing one means naming it.
   *
   * Trustworthy rather than best-effort: a name gets here on `configure`, and a
   * bucket that was never configured cannot run and holds no storage at all. So
   * no live bucket is missing from this list.
   */
  async listNames(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(NAMES_KEY)) ?? [];
  }

  /** The reserved instance holding the name list. */
  #registry(): LimiterRpc {
    return this.env.RATE_LIMITER.getByName(REGISTRY_NAME);
  }

  /**
   * Undo a creation that did not complete: leave the registry as it was and
   * erase whatever reached storage, so a failed `configure` leaves a non-entity
   * rather than a half-built bucket.
   */
  async #abandon(name: string): Promise<void> {
    try {
      await this.#registry().unregisterName(name);
    } catch {
      // The name outlives the bucket. Harmless, and the next `stats` prunes it
      // — which is why the repair is on the read path and not only here.
    }
    await this.ctx.storage.deleteAll();
    this.#runtime = undefined;
  }

  /** Drop the cached runtime so the next call restores under the new limits. */
  async #invalidate(): Promise<void> {
    // Taken from the memoised promise rather than from `#ready()`, so an object
    // that has not run anything yet is not made to restore just to be torn down.
    const cached = this.#runtime;
    this.#runtime = undefined;
    (await cached)?.bucket.destroy();
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
    const [storedConfig, storedName, storedState] = await Promise.all([
      this.ctx.storage.get<LimiterConfig>(CONFIG_KEY),
      this.ctx.storage.get<string>(NAME_KEY),
      this.ctx.storage.get<BucketState>(STATE_KEY),
    ]);

    // No default to fall back on, by design. See LimiterNotConfiguredError:
    // a bucket nobody configured does not exist, and pacing it at a
    // plausible-looking invented rate is how a mistyped name stays invisible.
    if (storedConfig === undefined) throw new LimiterNotConfiguredError();
    const config = storedConfig;
    const name = storedName ?? '';

    this.#reregister(name);

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

    return { name, config, bucket, scheduler };
  }

  /**
   * Re-assert this bucket's membership of the registry, once per object
   * lifetime.
   *
   * The other half of the repair `unregisterName` describes: pruning fixes
   * names with no bucket, this fixes buckets with no name. Together they mean a
   * registry that was damaged converges back on the truth rather than staying
   * wrong until somebody notices.
   *
   * Fired and forgotten, because it is bookkeeping: it must never delay a
   * caller and must never fail an `execute`. `registerName` is idempotent, so
   * the steady-state cost is one round trip per cold start and no write.
   */
  #reregister(name: string): void {
    if (name === '' || name === REGISTRY_NAME) return;

    this.ctx.waitUntil(
      this.#registry()
        .registerName(name)
        .catch(() => {
          // Retried on the next lifetime; a gap in `stats` is not worth
          // failing a caller's real work over.
        })
    );
  }
}
