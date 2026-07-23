/**
 * The one failure the caller must survive on its own, and the vocabulary for
 * observing it.
 *
 * The object's wait queue is memory-only and cannot be otherwise: an RPC
 * function handle cannot be persisted, so a queue of them cannot be written to
 * storage. A caller parked in that queue is holding an open RPC connection to
 * the object, and if the object is evicted, reset or redeployed while it waits,
 * that connection breaks and `execute` rejects with a transport error —
 * typically `Network connection lost.`
 *
 * Measured against a real deployment across four runs of ten Workflow
 * instances stampeding one bucket: **7 of 290 calls, 2.4%** (95% CI 1.2–4.9%).
 * Every one was dropped *while parked*; none died once its callback had
 * started. Waits at the moment of the drop ranged from 47 s to 8.8 min and did
 * not cluster at the long end, so this is not a duration ceiling — it reads as
 * eviction or restart landing on whoever happens to be queued. See `verify/`.
 *
 * At that rate an application that does not retry loses calls in normal
 * operation, which is why the retry lives in this package rather than in a
 * paragraph telling every consumer to write the same wrapper. In the run made
 * after it shipped, both drops recovered on their first retry and the run
 * finished with zero failures.
 *
 * ## Why there is no published failure probability
 *
 * It is tempting to raise 2.4% to the sixth power and quote the result. Do not,
 * and do not let the README either. Two things break it:
 *
 *  - **The base rate is uncertain.** 7 of 290 is a small sample; the interval
 *    is 1.2–4.9%, and compounding an uncertain number amplifies the
 *    uncertainty. At six attempts the honest range spans a factor of 5 000.
 *  - **The events are not independent.** Drops come from eviction, reset and
 *    redeploy — and a redeploy drops *every* parked caller at once, then the
 *    retries re-queue into the same window. No run has yet produced a call
 *    dropped twice, so P(second drop | first drop) is simply unmeasured.
 *
 * What can be said: a call must now be dropped six separate times to fail, no
 * observed call was dropped more than once, and {@link DropHook} exists so an
 * operator can measure the rate on *their* deployment instead of inheriting
 * this one's.
 */

/** What the caller is told about a drop, as it happens. */
export interface DropEvent {
  /** The instance name — which bucket the caller was queued on. */
  limiter: string;
  /** 1-based index of the attempt that was dropped. */
  attempt: number;
  /** Whether another attempt follows. `false` means the call is about to fail. */
  willRetry: boolean;
  /**
   * The transport rejection, as reconstructed by RPC — `name`, `message` and
   * `stack` only, every custom property already stripped. Log the message;
   * nothing can usefully be decided from its type.
   */
  error: Error;
}

/**
 * Called on every drop, retried or not.
 *
 * This exists because a retry that is silent is a retry nobody can size. The
 * drop rate is a property of the deployment — object churn, redeploy cadence,
 * how long callers park — and it is not knowable in advance, so it has to be
 * observable in production rather than assumed from this package's own
 * measurements.
 *
 * It must not throw and must not block: it runs on the caller's path between
 * attempts, and anything slow here is added directly to the latency of a call
 * that has already been unlucky once.
 */
export type DropHook = (event: DropEvent) => void;

/**
 * Every retry spent, and the caller still never ran.
 *
 * A real class with real properties, unlike the errors on the object side —
 * this one is thrown to application code in the same isolate and never crosses
 * an RPC boundary, so `attempts` and `limiter` actually survive to be read.
 * That asymmetry is worth stating plainly: the constraint that forces the
 * envelope protocol does not apply here.
 *
 * `cause` carries the underlying transport rejection.
 */
export class CallDroppedError extends Error {
  /** How many attempts were made in total, including the first. */
  readonly attempts: number;
  /** The instance name the caller was queued on. */
  readonly limiter: string;

  constructor(limiter: string, attempts: number, cause: Error) {
    super(
      `call to limiter "${limiter}" was dropped while queued and never ran, ` +
        `after ${String(attempts)} attempt${attempts === 1 ? '' : 's'}: ${cause.message}`,
      { cause }
    );
    this.name = 'CallDroppedError';
    this.attempts = attempts;
    this.limiter = limiter;
  }
}

/**
 * The limiter a caller asked for does not exist.
 *
 * Lives beside {@link CallDroppedError} because the two are the outcomes of one
 * fork. Both arrive the same way — a rejection from the object *before* the
 * callback ever fired — and telling them apart is the whole job: a drop is
 * transport, transient, and worth retrying; this is permanent, and retrying it
 * six times only wastes round trips, lies to `onDrop` about a drop that never
 * happened, and buries the real remedy under a message about queueing.
 *
 * Almost always a mistyped instance name. A typo is not an error anywhere else
 * in this system — it simply names a different bucket — so this is the point at
 * which it becomes visible, and it is worth making that moment legible.
 *
 * A real class with real properties, like `CallDroppedError` and unlike the
 * errors on the object side: it is constructed in the caller's own isolate and
 * never crosses an RPC boundary, so `limiter` survives to be read.
 */
export class NoSuchLimiterError extends Error {
  /** The instance name that resolved to nothing. */
  readonly limiter: string;

  constructor(limiter: string, cause: Error) {
    super(
      `limiter "${limiter}" does not exist: it has never been configured. ` +
        'That is usually a mistyped instance name — it is not an error to ' +
        'name a bucket nobody set up, it is simply a different bucket. ' +
        'Configure it, or check the name against `listNames()`.',
      { cause }
    );
    this.name = 'NoSuchLimiterError';
    this.limiter = limiter;
  }
}

/**
 * Attempts after the first, so six in total.
 *
 * Higher than the object's own retry budget of 3, because these attempts are
 * cheap in a way the object's are not: a dropped caller never reached the
 * upstream, so re-queueing costs a take from the bucket and some waiting rather
 * than a duplicate request.
 *
 * Not higher still. Past roughly this point the residual risk is dominated by
 * correlated failures — a redeploy taking out every parked caller at once —
 * which more attempts cannot fix, while the costs stay real: every attempt
 * takes from the bucket before it runs, so a retry storm quietly spends upstream
 * quota doing nothing, and each re-queue adds another full wait to a call that
 * has already been unlucky.
 */
export const DEFAULT_DROP_RETRIES = 5;
