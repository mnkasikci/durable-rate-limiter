/**
 * The pacing core: a sliding log whose entire persistable surface is the pair
 * `{ grants, forcedUntil }`, where `grants` is one entry per successful take.
 *
 * A window is not swept by a ticker. Each grant records the instant and amount
 * it took, and a grant counts against the allowance only while it is younger
 * than `windowInMs` — so the window that bounds a caller is the *rolling* one
 * ending at the moment of the read, not a fixed slot anchored to a clock. Stale
 * grants are pruned lazily whenever the bucket is read, which is what lets a
 * bucket be evicted, rebuilt from a stored snapshot, and still land on the
 * correct usage instead of handing out a fresh full allowance against someone
 * else's quota.
 *
 * Persistence is deliberately not the bucket's concern. It reports mutations
 * through `onStateChange` and lets its owner decide what to do with them, so
 * the bucket stays testable outside any host — no storage, no Cloudflare
 * imports, no ambient anything but `Date.now()` where a caller declines to
 * pass a clock reading in.
 *
 * ## Sizing: set `limitPerWindow` to the upstream limit
 *
 * "100 per minute" means a rested caller may spend all 100 at once — the
 * ecosystem norm, and what the surveyed upstreams themselves enforce. So
 * `limitPerWindow` maps 1:1 to the advertised limit; the whole allowance is
 * spendable, with no separate burst knob to configure.
 *
 * The guarantee is two-sided and exact: never more than `limitPerWindow` in ANY
 * rolling window, and a caller idle for a full window may still spend the whole
 * limit at once. Because every grant is measured against the rolling window that
 * ends at the moment of the read, the allowance is bounded continuously — the
 * most any window can ever hold is `limitPerWindow`, with no wider peak to guard
 * against.
 *
 * ## Cost
 *
 * The price of that exactness is state, and it is written through once per take.
 * Takes that land on the same millisecond are coalesced into a single grant, so
 * the persisted log holds at most one entry per distinct take-instant still
 * inside the window: `limitPerWindow` entries in the ordinary case of
 * whole-number takes, and never more than `min(limitPerWindow / smallestAmount,
 * windowInMs)` even under fractional ones. That is nothing for limits in the
 * hundreds, which is the range this is built for; before configuring a limit in
 * the tens of thousands, weigh the per-grant write and the size of the persisted
 * blob.
 */

/** One successful take: the instant it landed and the amount it took. */
export interface BucketGrant {
  /** Epoch ms the take landed. */
  at: number;
  /** Amount taken, fractional and strictly positive. */
  amount: number;
}

/** The whole persistable surface of a bucket. */
export interface BucketState {
  /**
   * One entry per take still inside its rolling window, kept sorted ascending
   * by `at`. A grant counts against the allowance until `at + windowInMs`.
   */
  grants: BucketGrant[];
  /** Epoch ms the current penalty expires; `0` means no penalty. */
  forcedUntil: number;
}

export interface BucketOptions {
  /** The window's whole allowance: the most a rested caller may spend at once. */
  limitPerWindow: number;
  windowInMs: number;
  /**
   * How much of the limit the window reopens with the instant a penalty lifts,
   * as a fraction; default `0.5`. The name is token-bucket vocabulary kept for
   * API stability — there is no bucket being refilled. In sliding-log terms it
   * sets a floor on the *spend* the recovering window carries: `pause()` seeds a
   * synthetic grant so that, when the penalty ends, only `penaltyRefillFraction`
   * of the limit is immediately spendable and the whole limit one window later.
   * See `pause()` for why the default is not `1`.
   */
  penaltyRefillFraction?: number;
}

export interface BucketInit {
  /** Called after every mutation of the persistable pair. */
  onStateChange?: (state: BucketState) => void;
  /** A snapshot to reconstruct from, in place of a fresh bucket. */
  state?: BucketState;
}

/**
 * Rejection handed to every pending waiter when a bucket is destroyed.
 * Rejecting is the honest signal that the wait will never be satisfied.
 */
export class BucketDestroyedError extends Error {
  override readonly name = 'BucketDestroyedError';

  constructor() {
    super(
      'Bucket was destroyed while a caller was waiting for room in the window.'
    );
  }
}

/** Default for `penaltyRefillFraction`; see `pause()` for why it is not `0`. */
const DEFAULT_PENALTY_REFILL_FRACTION = 0.5;

/**
 * The largest delay `setTimeout` honours. Node and workerd store the delay in a
 * signed 32-bit int, so anything above this is silently truncated (in practice
 * clamped to `1`), which would turn a long wait into a 1ms hot loop. Longer
 * waits are served by chaining maximum-length timers instead.
 */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

interface Waiter {
  amount: number;
  resolve: (value: true) => void;
  reject: (reason: Error) => void;
}

/**
 * Validates a number *before* any range comparison.
 *
 * Every comparison against `NaN` is false, so `if (x <= 0) throw` alone
 * silently accepts it — and a `NaN` window turns a timer into a hot loop that
 * will burn the CPU limit.
 */
function requireFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `${label} must be a finite number, received ${String(value)}`
    );
  }
}

function requireRange(
  label: string,
  value: number,
  min: number,
  max: number
): void {
  requireFinite(label, value);
  if (value < min || value > max) {
    throw new RangeError(
      `${label} must be between ${String(min)} and ${String(max)}, received ${String(value)}`
    );
  }
}

export class SlidingLogBucket {
  readonly #limitPerWindow: number;
  readonly #windowInMs: number;
  readonly #penaltyRefillFraction: number;
  readonly #onStateChange: ((state: BucketState) => void) | undefined;

  #grants: BucketGrant[];
  #forcedUntil: number;

  #queue: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  constructor(options: BucketOptions, init: BucketInit = {}) {
    requireRange(
      'limitPerWindow',
      options.limitPerWindow,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    );
    requireRange(
      'windowInMs',
      options.windowInMs,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    );

    const fraction =
      options.penaltyRefillFraction ?? DEFAULT_PENALTY_REFILL_FRACTION;
    requireRange('penaltyRefillFraction', fraction, 0, 1);

    this.#limitPerWindow = options.limitPerWindow;
    this.#windowInMs = options.windowInMs;
    this.#penaltyRefillFraction = fraction;
    this.#onStateChange = init.onStateChange;

    const snapshot = init.state;
    if (snapshot === undefined) {
      this.#grants = [];
      this.#forcedUntil = 0;
    } else {
      requireFinite('state.forcedUntil', snapshot.forcedUntil);
      for (const grant of snapshot.grants) {
        requireFinite('state.grant.at', grant.at);
        // Strictly positive: a zero or negative grant is meaningless and would
        // corrupt the running sum the whole allowance is computed from.
        requireRange(
          'state.grant.amount',
          grant.amount,
          Number.MIN_VALUE,
          Number.MAX_VALUE
        );
      }
      this.#forcedUntil = snapshot.forcedUntil;
      this.#grants = this.#restoreGrants(snapshot.grants, Date.now());
    }
  }

  /**
   * Normalises a restored log: sort ascending, drop what has already aged out,
   * and — if the survivors still exceed the limit because the snapshot was
   * written under a larger one — drop the OLDEST until they fit.
   *
   * A shrunken limit must tighten pacing, never wedge the restore: keeping a
   * log whose sum exceeds the new limit would make every `consume` refuse until
   * enough entries aged out, which for a long window is indistinguishable from a
   * hang. Dropping the oldest is the least surprising loss — those entries are
   * the closest to expiry anyway.
   *
   * A grant dated in the future breaks the ascending-`at` invariant every read
   * relies on: `consume` appends `{ at: now }`, and a later grant sorted before
   * it would make `msUntilAvailable` walk out of order and return a wrong wait.
   * The one legitimate future date is the penalty's synthetic grant, dated at
   * `forcedUntil`; anything past that is a corrupt snapshot, so `at` is clamped
   * to `max(now, forcedUntil)` — conservative, keeping the spend rather than
   * discarding it.
   */
  #restoreGrants(grants: BucketGrant[], now: number): BucketGrant[] {
    const ceiling = Math.max(now, this.#forcedUntil);
    const live = grants
      .map((grant) =>
        grant.at > ceiling ? { at: ceiling, amount: grant.amount } : grant
      )
      .sort((a, b) => a.at - b.at)
      .filter((grant) => grant.at + this.#windowInMs > now);

    // Keep the newest suffix whose sum fits, walking newest-first; the first
    // entry that would push the sum over the limit ends the kept range, so
    // everything older than it is dropped.
    const kept: BucketGrant[] = [];
    let sum = 0;
    for (const grant of [...live].reverse()) {
      if (sum + grant.amount > this.#limitPerWindow) break;
      sum += grant.amount;
      kept.push(grant);
    }
    kept.reverse();
    return kept;
  }

  /**
   * A copy of the persistable pair as it stands at `now`, with aged-out grants
   * excluded. A pure read: it does not mutate the log, so projecting a future or
   * out-of-order `now` cannot evict grants a later real `consume` still needs.
   */
  getState(now: number = Date.now()): BucketState {
    requireFinite('now', now);
    return {
      grants: this.#liveGrants(now).map((grant) => ({
        at: grant.at,
        amount: grant.amount,
      })),
      forcedUntil: this.#forcedUntil,
    };
  }

  /**
   * Amount available in the current rolling window at `now`, fractional. A pure
   * read — see `getState` — so it never evicts a still-live grant.
   */
  available(now: number = Date.now()): number {
    requireFinite('now', now);
    if (now < this.#forcedUntil) return 0;
    return this.#limitPerWindow - this.#usedAt(now);
  }

  /** Takes `amount` if it is available. Never blocks. */
  consume(amount: number, now: number = Date.now()): boolean {
    this.#assertAlive();
    this.#assertAmount(amount);
    this.#prune(now);

    if (
      now < this.#forcedUntil ||
      this.#used() + amount > this.#limitPerWindow
    ) {
      return false;
    }

    // Every surviving grant has `at <= now` (a future-dated grant only exists
    // under a penalty, which the guard above already refused), so the newest
    // grant is the tail. Takes on the same millisecond are folded into it rather
    // than appended: they share an expiry, so one summed grant is exact, and it
    // caps the log at one entry per distinct instant instead of one per take —
    // the difference between `limitPerWindow` and `limitPerWindow / smallest`
    // entries under fractional amounts.
    const tail = this.#grants[this.#grants.length - 1];
    if (tail?.at === now) {
      tail.amount += amount;
    } else {
      this.#grants.push({ at: now, amount });
    }
    this.#emit();
    return true;
  }

  /**
   * Resolves — with `true`, always, never `false` — once `amount` has actually
   * been taken. An API documented as "await until available" that can resolve
   * falsy forces every call site into a `while (!await ...)` spin.
   */
  async consumeAsync(amount: number): Promise<true> {
    if (this.consume(amount)) return true;

    return new Promise<true>((resolve, reject) => {
      this.#queue.push({ amount, resolve, reject });
      this.#schedule();
    });
  }

  /** Milliseconds until `amount` can be taken; `0` means now. */
  msUntilAvailable(amount: number, now: number = Date.now()): number {
    this.#assertAmount(amount);
    requireFinite('now', now);

    // A pure read — see `getState` — so it computes over the live grants without
    // pruning the stored log.
    const live = this.#liveGrants(now);
    let used = 0;
    for (const grant of live) used += grant.amount;

    // A penalty freezes the log `pause` set to a single synthetic grant dated
    // at `forcedUntil`, so the allowance the recovering window opens with is
    // `limit - used`. If `amount` fits that, only the penalty's end stands
    // between the caller and the take; otherwise it must also wait for that
    // synthetic grant to age out, one window past the penalty.
    if (now < this.#forcedUntil) {
      return amount <= this.#limitPerWindow - used
        ? this.#forcedUntil - now
        : this.#forcedUntil + this.#windowInMs - now;
    }

    if (used + amount <= this.#limitPerWindow) return 0;

    // The deficit clears as grants age out oldest-first. Walk from the oldest,
    // freeing each grant's amount, until enough room has opened; that grant's
    // expiry is the soonest the take can land. Freeing every grant leaves only
    // `amount`, which `#assertAmount` caps at the limit, so a satisfying grant
    // always exists — the loop is entered only when the log is non-empty.
    let freed = 0;
    let readyAt = now;
    for (const grant of live) {
      freed += grant.amount;
      readyAt = grant.at + this.#windowInMs;
      if (used - freed + amount <= this.#limitPerWindow) break;
    }
    return readyAt - now;
  }

  /**
   * Feeds an upstream rate-limit response back in so it throttles *every*
   * caller, not just the one that received it.
   *
   * The guarantee is preserved across the pause: the synthetic spend the
   * recovering window carries is never *less* than the real spend that is still
   * inside its rolling window when the penalty lifts. `penaltyRefillFraction` is
   * a floor on that spend, not a reset of it — so a pause shorter than the
   * window cannot hand back room that already-issued grants have spent.
   */
  pause(ms: number, now: number = Date.now()): void {
    this.#assertAlive();
    requireRange('ms', ms, 0, Number.MAX_VALUE);
    this.#prune(now);

    // Furthest deadline wins, and we never early-return when a penalty is
    // already active: concurrent deadlines of 5s / 60s / 5s must wait 60
    // seconds, not 5.
    this.#forcedUntil = Math.max(this.#forcedUntil, now + ms);

    // The recovering window opens at the penalty's end, and it does not open
    // full: a whole window aimed at an API that just asked for backoff re-trips
    // it immediately. The log is replaced with one synthetic grant dated at the
    // penalty's end so the window that opens then holds at most
    // `penaltyRefillFraction` of the limit and the full limit one window later.
    // Half rather than empty — zeroed penalties stack multiplicatively and the
    // recovery curve is far steeper than the sum of the individual delays.
    //
    // But the fraction is only a floor. Real grants still inside their window at
    // the moment the penalty lifts are physically part of the rolling window
    // that opens then; recording less than they represent would let the window
    // re-admit room reality has already spent, breaking the two-sided guarantee
    // for a pause shorter than the window. So the synthetic amount is the larger
    // of the fraction floor and that surviving live spend. A zero-amount grant
    // (fraction `1`, no surviving spend) is simply an empty log: nothing to
    // persist, and nothing a restore could reject for being non-positive.
    let liveAtLift = 0;
    for (const grant of this.#grants) {
      if (grant.at + this.#windowInMs > this.#forcedUntil) {
        liveAtLift += grant.amount;
      }
    }
    const floor = this.#limitPerWindow * (1 - this.#penaltyRefillFraction);
    const spent = Math.max(floor, liveAtLift);
    this.#grants = spent > 0 ? [{ at: this.#forcedUntil, amount: spent }] : [];

    this.#emit();
    this.#schedule();
  }

  /**
   * Clears any timer and drains the wait queue by rejecting. Idempotent —
   * consumers call it from a `finally`.
   */
  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#clearTimer();
    const waiting = this.#queue;
    this.#queue = [];
    for (const waiter of waiting) waiter.reject(new BucketDestroyedError());
  }

  /**
   * Drops grants that have aged out of the rolling window, reopening their
   * allowance at read time.
   *
   * A grant stops counting once it is `windowInMs` old, so a caller rested past
   * the newest grant's expiry meets an empty log and may spend the whole limit.
   * The synthetic penalty grant is dated in the *future* (`forcedUntil`), so it
   * is never pruned early and the backoff it encodes cannot be thrown away
   * before it bites. Pruning never emits — reclaiming aged-out room is not a
   * state change worth persisting, so only `consume` and `pause` write through.
   */
  #prune(now: number): void {
    requireFinite('now', now);
    this.#grants = this.#grants.filter(
      (grant) => grant.at + this.#windowInMs > now
    );
  }

  /** Sum of the surviving grants; assumes the log has already been pruned. */
  #used(): number {
    let total = 0;
    for (const grant of this.#grants) total += grant.amount;
    return total;
  }

  /**
   * The grants still inside their window at `now`, as a new array, without
   * touching the stored log. What the pure reads (`getState`, `available`,
   * `msUntilAvailable`) compute over so a projected clock cannot evict grants a
   * later real `consume` still needs. Order is preserved, so the result stays
   * sorted ascending.
   */
  #liveGrants(now: number): BucketGrant[] {
    return this.#grants.filter((grant) => grant.at + this.#windowInMs > now);
  }

  /** Sum of the grants still inside their window at `now`, without pruning. */
  #usedAt(now: number): number {
    let total = 0;
    for (const grant of this.#grants) {
      if (grant.at + this.#windowInMs > now) total += grant.amount;
    }
    return total;
  }

  /**
   * Releases waiters strictly head-of-line. Only the head is ever considered;
   * if it cannot be satisfied we stop. Scanning for any satisfiable waiter
   * serves cheap `amount: 1` callers past an expensive `amount: 5` one
   * indefinitely under sustained load — starvation that presents as a hang.
   */
  #pump(): void {
    const now = Date.now();
    let head = this.#queue[0];
    while (head !== undefined && this.consume(head.amount, now)) {
      this.#queue.shift();
      head.resolve(true);
      head = this.#queue[0];
    }
    this.#schedule();
  }

  /**
   * One timer for the whole queue, sized to the exact deficit and cleared when
   * the queue drains. No timer may exist unless a caller is waiting — a
   * pending timer prevents an idle host from hibernating and bills duration
   * around the clock. Never a repeating tick.
   *
   * The delay is clamped to `MAX_TIMER_DELAY`: a wait longer than the
   * `setTimeout` ceiling (a window or penalty past ~24.8 days) would otherwise
   * be truncated to 1ms and busy-loop. When the timer fires early because it was
   * clamped, `#pump` finds the head still unsatisfiable and reschedules the
   * remaining wait — chaining maximum-length timers until the deficit clears.
   */
  #schedule(): void {
    this.#clearTimer();
    const head = this.#queue[0];
    if (head === undefined) return;

    // At least 1ms: a 0ms timer that re-enters a still-unsatisfiable pump is
    // the hot loop this whole design exists to avoid.
    const delay = Math.min(
      MAX_TIMER_DELAY,
      Math.max(1, this.msUntilAvailable(head.amount))
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  #assertAlive(): void {
    if (this.#destroyed) throw new BucketDestroyedError();
  }

  #assertAmount(amount: number): void {
    requireRange('amount', amount, Number.MIN_VALUE, this.#limitPerWindow);
  }

  /** A defensive copy — the caller must never alias internal state. */
  #snapshot(): BucketState {
    return {
      grants: this.#grants.map((grant) => ({
        at: grant.at,
        amount: grant.amount,
      })),
      forcedUntil: this.#forcedUntil,
    };
  }

  #emit(): void {
    this.#onStateChange?.(this.#snapshot());
  }
}
