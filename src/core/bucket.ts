/**
 * The pacing core: a token bucket whose entire persistable surface is the
 * triple `{ tokens, lastRefillAt, forcedUntil }`.
 *
 * Tokens are not pushed by a ticker. They are computed from elapsed wall-clock
 * time whenever the bucket is read, which is what lets a bucket be evicted,
 * rebuilt from a stored snapshot, and still land on the correct count instead
 * of handing out a full burst against someone else's quota.
 *
 * Persistence is deliberately not the bucket's concern. It reports mutations
 * through `onStateChange` and lets its owner decide what to do with them, so
 * the bucket stays testable outside any host — no storage, no Cloudflare
 * imports, no ambient anything but `Date.now()` where a caller declines to
 * pass a clock reading in.
 *
 * ## Sizing: worst-case throughput is `capacity + fillPerWindow`
 *
 * NOT `fillPerWindow`. The burst is spent immediately and then the sustained
 * rate refills on top of it within the same window: a bucket at 10/min with a
 * burst of 5 delivers 15 calls in the first rolling minute. To stay under an
 * upstream limit `L`, size so that `capacity + fillPerWindow <= L`.
 *
 * `capacity` and `fillPerWindow` are independent knobs. `{capacity: 10,
 * fillPerWindow: 50, windowInMs: 60_000}` — "50 a minute, never more than 10
 * at once" — is valid and is the most useful shape for pacing a real upstream.
 */

/** The whole persistable surface of a bucket. */
export interface BucketState {
  /** Fractional token count. */
  tokens: number;
  /** Epoch ms of the last refill computation. */
  lastRefillAt: number;
  /** Epoch ms the current penalty expires; `0` means no penalty. */
  forcedUntil: number;
}

export interface BucketOptions {
  /** Burst allowance: the most that can ever be taken at once. */
  capacity: number;
  /** Sustained rate: tokens added per `windowInMs`, trickled continuously. */
  fillPerWindow: number;
  windowInMs: number;
  /** Defaults to `capacity`. */
  initialTokens?: number;
  /** Fraction of capacity restored when a penalty is applied; default `0.5`. */
  penaltyRefillFraction?: number;
}

export interface BucketInit {
  /** Called after every mutation of the persistable triple. */
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
    super('Bucket was destroyed while a caller was waiting for tokens.');
  }
}

/** Default for `penaltyRefillFraction`; see `pause()` for why it is not `0`. */
const DEFAULT_PENALTY_REFILL_FRACTION = 0.5;

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

export class TokenBucket {
  readonly #capacity: number;
  readonly #fillPerWindow: number;
  readonly #windowInMs: number;
  readonly #penaltyRefillFraction: number;
  readonly #onStateChange: ((state: BucketState) => void) | undefined;

  #tokens: number;
  #lastRefillAt: number;
  #forcedUntil: number;

  #queue: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  constructor(options: BucketOptions, init: BucketInit = {}) {
    requireRange(
      'capacity',
      options.capacity,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    );
    requireRange(
      'fillPerWindow',
      options.fillPerWindow,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    );
    requireRange(
      'windowInMs',
      options.windowInMs,
      Number.MIN_VALUE,
      Number.MAX_VALUE
    );

    const initialTokens = options.initialTokens ?? options.capacity;
    requireRange('initialTokens', initialTokens, 0, options.capacity);

    const fraction =
      options.penaltyRefillFraction ?? DEFAULT_PENALTY_REFILL_FRACTION;
    requireRange('penaltyRefillFraction', fraction, 0, 1);

    this.#capacity = options.capacity;
    this.#fillPerWindow = options.fillPerWindow;
    this.#windowInMs = options.windowInMs;
    this.#penaltyRefillFraction = fraction;
    this.#onStateChange = init.onStateChange;

    const snapshot = init.state;
    if (snapshot === undefined) {
      this.#tokens = initialTokens;
      this.#lastRefillAt = Date.now();
      this.#forcedUntil = 0;
    } else {
      requireRange('state.tokens', snapshot.tokens, 0, options.capacity);
      requireFinite('state.lastRefillAt', snapshot.lastRefillAt);
      requireFinite('state.forcedUntil', snapshot.forcedUntil);
      this.#tokens = snapshot.tokens;
      this.#lastRefillAt = snapshot.lastRefillAt;
      this.#forcedUntil = snapshot.forcedUntil;
    }
  }

  /** A copy of the persistable triple, refilled to `now`. */
  getState(now: number = Date.now()): BucketState {
    this.#refill(now);
    return {
      tokens: this.#tokens,
      lastRefillAt: this.#lastRefillAt,
      forcedUntil: this.#forcedUntil,
    };
  }

  /** Tokens available right now, fractional. */
  available(now: number = Date.now()): number {
    this.#refill(now);
    return this.#tokens;
  }

  /** Takes `amount` if it is available. Never blocks. */
  consume(amount: number, now: number = Date.now()): boolean {
    this.#assertAlive();
    this.#assertAmount(amount);
    this.#refill(now);

    if (now < this.#forcedUntil || this.#tokens < amount) return false;

    this.#tokens -= amount;
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
    this.#refill(now);

    const penaltyWait = now < this.#forcedUntil ? this.#forcedUntil - now : 0;
    const deficit = amount - this.#tokens;
    if (deficit <= 0) return penaltyWait;

    return (
      penaltyWait +
      Math.ceil((deficit / this.#fillPerWindow) * this.#windowInMs)
    );
  }

  /**
   * Feeds an upstream rate-limit response back in so it throttles *every*
   * caller, not just the one that received it.
   */
  pause(ms: number, now: number = Date.now()): void {
    this.#assertAlive();
    requireRange('ms', ms, 0, Number.MAX_VALUE);
    this.#refill(now);

    // Furthest deadline wins, and we never early-return when a penalty is
    // already active: concurrent deadlines of 5s / 60s / 5s must wait 60
    // seconds, not 5.
    this.#forcedUntil = Math.max(this.#forcedUntil, now + ms);

    // Do not resume at full capacity — a full burst aimed at an API that just
    // asked for backoff re-trips it immediately. Halving rather than zeroing:
    // zeroed penalties stack multiplicatively and the recovery curve is far
    // steeper than the sum of the individual delays.
    this.#tokens = this.#capacity * this.#penaltyRefillFraction;

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
   * Fractional, continuous refill computed at read time.
   *
   * No accrual during a penalty window: counting elapsed time through a
   * penalty banks tokens while the bucket is supposed to be stopped, then
   * bursts the instant the penalty lifts, defeating the penalty entirely.
   */
  #refill(now: number): void {
    requireFinite('now', now);

    if (now < this.#forcedUntil) {
      // Advance the clock, accrue nothing.
      this.#lastRefillAt = now;
      return;
    }

    // Load-bearing: also covers a penalty that expired between two reads, so
    // the elapsed window begins at the penalty's end and not before it began.
    const start = Math.max(this.#lastRefillAt, this.#forcedUntil);
    const elapsed = now - start;
    if (elapsed > 0) {
      const gained = (elapsed / this.#windowInMs) * this.#fillPerWindow;
      this.#tokens = Math.min(this.#capacity, this.#tokens + gained);
    }
    this.#lastRefillAt = Math.max(this.#lastRefillAt, now);
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
   */
  #schedule(): void {
    this.#clearTimer();
    const head = this.#queue[0];
    if (head === undefined) return;

    // At least 1ms: a 0ms timer that re-enters a still-unsatisfiable pump is
    // the hot loop this whole design exists to avoid.
    const delay = Math.max(1, this.msUntilAvailable(head.amount));
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
    requireRange('amount', amount, Number.MIN_VALUE, this.#capacity);
  }

  #emit(): void {
    this.#onStateChange?.({
      tokens: this.#tokens,
      lastRefillAt: this.#lastRefillAt,
      forcedUntil: this.#forcedUntil,
    });
  }
}
