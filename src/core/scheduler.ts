/**
 * Concurrency gate, retry loop and result classification around an arbitrary
 * async function.
 *
 * The scheduler sits on top of a bucket it does not own — the host constructs
 * and persists the bucket, because the bucket is the thing that must be shared.
 * Nothing here knows about Cloudflare, `fetch`, or `Response`: `fn` is a plain
 * thunk and may execute in another isolate entirely.
 *
 * ## The `fn` contract
 *
 * `fn` is re-invoked from scratch on **every** attempt, so it must build its
 * own request each time. Closing over an already-constructed `Request`,
 * `Response`, stream or `FormData` makes the second attempt fail with a "body
 * already used" error that looks nothing like a retry problem.
 *
 * ```ts
 * // Correct — a fresh request per attempt.
 * await scheduler.call(() => fetch(url, { method: 'POST', body: JSON.stringify(payload) }));
 *
 * // Wrong — the body is consumed by the first attempt.
 * const request = new Request(url, { method: 'POST', body: stream });
 * await scheduler.call(() => fetch(request));
 * ```
 */

/**
 * The slice of the bucket the scheduler depends on. Structural, so a
 * `TokenBucket`, a remote handle, or a test double all satisfy it.
 */
export interface Bucket {
  /** Resolves once a token has actually been taken. */
  consumeAsync(amount: number): Promise<true>;
  /** Throttles every caller of this bucket for `ms`. */
  pause(ms: number): void;
}

export interface RetryOptions {
  /** Retries *after* the first attempt; total attempts are `maxRetries + 1`. */
  maxRetries: number;
  /** Backoff floor, and the base of the exponential. */
  minDelayInMs: number;
  /** Backoff ceiling. */
  maxDelayInMs: number;
  /** Exponential base: `minDelay * factor ** (attempt - 1)`. */
  factor: number;
  /** Whether a parsed `Retry-After` overrides the computed backoff. */
  respectRetryAfter: boolean;
}

/**
 * What a classifier makes of a result that *returned* rather than threw.
 *
 * Deliberately envelope-agnostic. A caller-side protocol that reports failure
 * as data — see `CallReport.failure` — cannot be understood here without
 * dragging wire knowledge into the core, so the host's classifier maps its own
 * shape onto this vocabulary and the scheduler acts on the vocabulary alone.
 */
export interface ResultVerdict {
  isRateLimited?: boolean;
  /** The call failed, even though it returned rather than threw. */
  failed?: boolean;
  /** Only meaningful with `failed`. Defaults to false — do not retry blindly. */
  retryable?: boolean;
  /** Used to build the rejection. */
  message?: string;
}

export interface ResultClassifier<U> {
  classifyResult: (result: U) => ResultVerdict;
  classifyError: (error: unknown) => {
    isRateLimited?: boolean;
    dontRetry?: boolean;
  };
}

/**
 * The rejection a `failed` verdict becomes.
 *
 * It crosses RPC on the way back to the caller, which reconstructs an error
 * from `name`, `message` and `stack` only — so `status` below is legibility for
 * an in-process caller and nothing more, and anything the caller genuinely
 * needs goes into the message. That loss is affordable precisely because this
 * error is terminal: nothing downstream decides anything from it.
 */
export class CallFailedError extends Error {
  /** Stripped by RPC; duplicated into the message for that reason. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(
      status === undefined ? message : `${message} (status ${String(status)})`
    );
    this.name = 'CallFailedError';
    this.status = status;
  }
}

/** What the retry loop knows about the attempt that just failed. */
export interface RetryContext<U> {
  /** 1-based index of the attempt that just finished. */
  attempt: number;
  /** The rejection, when the attempt threw. */
  error: unknown;
  /** The value, when the attempt returned and was classified rate-limited. */
  result: U | undefined;
  /** Whether the outcome was classified as rate-limited. */
  isRateLimited: boolean;
  /** The merged, fully-populated retry options. */
  retry: Required<RetryOptions>;
  /** Clock reading taken by the scheduler, so callers stay deterministic. */
  now: number;
}

/**
 * Computes how long to wait before the next attempt.
 *
 * It must be free of side effects. In particular it must not pause the bucket:
 * it is called for plain errors too, and pausing there would throttle every
 * other caller because one unrelated call hit a network blip.
 */
export type RetryDelayCalculator<U> = (context: RetryContext<U>) => number;

export interface SchedulerOptions<U> {
  /** Injected and owned by the host — never constructed here. */
  bucket: Bucket;
  /** Calls actually in flight; default 5. */
  concurrency?: number;
  /** Merged with the defaults, never swapped in wholesale. */
  retry?: Partial<RetryOptions>;
  classify?: ResultClassifier<U>;
  retryDelay?: RetryDelayCalculator<U>;
}

export const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  minDelayInMs: 500,
  maxDelayInMs: 30_000,
  factor: 2,
  respectRetryAfter: true,
};

export const DEFAULT_CONCURRENCY = 5;

function requirePositive(label: string, value: number, min: number): void {
  // `!(value >= min)` and not `value < min`: every comparison against NaN is
  // false, so the negated form is the only one that rejects it.
  if (!Number.isFinite(value) || !(value >= min)) {
    throw new RangeError(
      `${label} must be a finite number >= ${String(min)}, received ${String(value)}`
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Reads `status`, then `response.status`. */
function readStatus(source: Record<string, unknown>): number | undefined {
  if (typeof source.status === 'number') return source.status;
  const response = asRecord(source.response);
  if (response !== undefined && typeof response.status === 'number') {
    return response.status;
  }
  return undefined;
}

/** The status of a returned result, in the same places the classifier looks. */
function resultStatus(result: unknown): number | undefined {
  const record = asRecord(result);
  return record === undefined ? undefined : readStatus(record);
}

export interface StatusClassifierOptions {
  /**
   * Opt in to reading a numeric `error.code` as an HTTP status.
   *
   * Off by default: gRPC statuses and some DB drivers put non-HTTP numbers
   * there, and a `code: 404` from one of those would be misread as a permanent
   * failure and never retried.
   */
  trustNumericErrorCode?: boolean;
}

/** The default HTTP-ish classifier: `429` is a rate limit, other `4xx` is final. */
export function createStatusClassifier<U>(
  options: StatusClassifierOptions = {}
): ResultClassifier<U> {
  const trustCode = options.trustNumericErrorCode ?? false;

  const statusOf = (value: unknown, allowCode: boolean): number | undefined => {
    const record = asRecord(value);
    if (record === undefined) return undefined;
    const status = readStatus(record);
    if (status !== undefined) return status;
    if (allowCode && typeof record.code === 'number') return record.code;
    return undefined;
  };

  return {
    classifyResult: (result) => ({
      isRateLimited: statusOf(result, false) === 429,
    }),
    classifyError: (error) => {
      const status = statusOf(error, trustCode);
      if (status === 429) return { isRateLimited: true };
      return {
        dontRetry: status !== undefined && status >= 400 && status < 500,
      };
    },
  };
}

function headerValue(carrier: unknown, name: string): string | undefined {
  const record = asRecord(carrier);
  if (record === undefined) return undefined;

  // A `Headers` object: case-insensitive `.get()`, returns null when absent.
  if (typeof record.get === 'function') {
    const got = (record.get as (key: string) => unknown)(name);
    return typeof got === 'string' ? got : undefined;
  }

  // A plain object: match the key case-insensitively ourselves.
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/** `"120"` → 120000; an HTTP-date → ms from `now`; anything else → undefined. */
function parseRetryAfter(raw: string, now: number): number | undefined {
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * Pulls an explicit delay out of a result or an error.
 *
 * A numeric `retryAfterMs` wins when present — a delay taken from a response
 * body is already a number and should not round trip through stringified
 * seconds.
 */
export function readRetryAfterMs(
  source: unknown,
  now: number
): number | undefined {
  const record = asRecord(source);
  if (record === undefined) return undefined;

  const nested = asRecord(record.response);
  for (const candidate of [record.retryAfterMs, nested?.retryAfterMs]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return Math.max(0, candidate);
    }
  }

  for (const carrier of [record.headers, nested?.headers]) {
    const raw = headerValue(carrier, 'Retry-After');
    if (raw !== undefined) {
      const parsed = parseRetryAfter(raw, now);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

/** `min(minDelay * factor ** (attempt - 1), maxDelay)`. */
export function exponentialBackoff(
  attempt: number,
  retry: Required<RetryOptions>
): number {
  return Math.min(
    retry.minDelayInMs * retry.factor ** (attempt - 1),
    retry.maxDelayInMs
  );
}

/**
 * The default delay calculator: `Retry-After` when it parses, exponential
 * backoff otherwise. Pure — see `RetryDelayCalculator`.
 */
export function defaultRetryDelay<U>(context: RetryContext<U>): number {
  if (context.retry.respectRetryAfter) {
    const explicit =
      readRetryAfterMs(context.error, context.now) ??
      readRetryAfterMs(context.result, context.now);
    if (explicit !== undefined) {
      return Math.min(explicit, context.retry.maxDelayInMs);
    }
  }
  return exponentialBackoff(context.attempt, context.retry);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Scheduler<U = unknown> {
  readonly #bucket: Bucket;
  readonly #concurrency: number;
  readonly #retry: Required<RetryOptions>;
  readonly #classify: ResultClassifier<U>;
  readonly #retryDelay: RetryDelayCalculator<U>;

  #active = 0;
  #waiters: (() => void)[] = [];

  constructor(options: SchedulerOptions<U>) {
    // Merge, never replace: `{ maxRetries: 5 }` left to stand alone gives
    // `undefined * undefined ** n` → NaN, and `setTimeout(fn, NaN)` fires
    // immediately — every retry hammering an API that is already limiting you.
    this.#retry = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    requirePositive('concurrency', this.#concurrency, 1);
    requirePositive('retry.maxRetries', this.#retry.maxRetries, 0);
    requirePositive('retry.minDelayInMs', this.#retry.minDelayInMs, 0);
    requirePositive('retry.maxDelayInMs', this.#retry.maxDelayInMs, 0);
    requirePositive('retry.factor', this.#retry.factor, 1);

    this.#bucket = options.bucket;
    this.#classify = options.classify ?? createStatusClassifier<U>();
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  /** Calls currently in flight. */
  get active(): number {
    return this.#active;
  }

  /**
   * Runs `fn` under the concurrency cap, the bucket and the retry policy.
   *
   * The slot is released on **completion**, which is why the run is `await`ed
   * inside the `try`. `return this.#run(fn)` would complete the `try` abruptly
   * and free the slot one microtask after the task *started*, leaving the cap
   * bounding nothing — invisible until upstream latency turns variable.
   */
  async call<T extends U>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await this.#run(fn);
    } finally {
      this.#release();
    }
  }

  async #run<T extends U>(fn: () => Promise<T>): Promise<T> {
    const attempts = this.#retry.maxRetries + 1;
    let lastError: unknown;
    let lastResult: T | undefined;
    let threw = false;
    /** The rejection a `failed` verdict has earned, if the loop runs out. */
    let failure: CallFailedError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Before *every* attempt, not just the first.
      await this.#bucket.consumeAsync(1);

      let outcome: { result: T; verdict: ResultVerdict } | undefined;
      try {
        const result = await fn();
        const verdict = this.#classify.classifyResult(result);
        if ((verdict.isRateLimited ?? false) || (verdict.failed ?? false)) {
          outcome = { result, verdict };
        } else {
          return result;
        }
      } catch (error) {
        const verdict = this.#classify.classifyError(error);
        lastError = error;
        threw = true;
        if ((verdict.dontRetry ?? false) || attempt === attempts) break;

        const delay = this.#delayFor(attempt, error, undefined, verdict);
        if (verdict.isRateLimited ?? false) {
          // A rate limit throttles every caller...
          this.#bucket.pause(delay);
        } else {
          // ...an error retries only the call that failed.
          await sleep(delay);
        }
        continue;
      }

      const { result, verdict } = outcome;
      const isRateLimited = verdict.isRateLimited ?? false;
      lastResult = result;
      threw = false;
      failure =
        (verdict.failed ?? false)
          ? new CallFailedError(
              verdict.message ?? 'the call failed',
              resultStatus(result)
            )
          : undefined;

      // A 429 is a rate limit first: it pauses and retries whatever else the
      // verdict says. Only outside that branch is a non-retryable failure
      // allowed to end the call, and it ends it here rather than after a wait
      // nobody is waiting for.
      if (
        !isRateLimited &&
        failure !== undefined &&
        verdict.retryable !== true
      ) {
        throw failure;
      }
      if (attempt === attempts) break;

      const delay = this.#delayFor(attempt, undefined, result, verdict);
      if (isRateLimited) {
        // Pausing the bucket is the wait: the next `consumeAsync` blocks until
        // the penalty lifts, and every other caller waits with us.
        this.#bucket.pause(delay);
      } else {
        // A retryable failure is this call's problem alone.
        await sleep(delay);
      }
    }

    if (threw) throw lastError;
    if (failure !== undefined) throw failure;
    return lastResult as T;
  }

  #delayFor(
    attempt: number,
    error: unknown,
    result: U | undefined,
    verdict: { isRateLimited?: boolean }
  ): number {
    const delay = this.#retryDelay({
      attempt,
      error,
      result,
      isRateLimited: verdict.isRateLimited ?? false,
      retry: this.#retry,
      now: Date.now(),
    });
    // A calculator that returns nonsense must not become `setTimeout(fn, NaN)`.
    return Number.isFinite(delay) && delay > 0 ? delay : 0;
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active++;
      return Promise.resolve();
    }
    // The slot is handed over on release, so `#active` stays untouched here.
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#active--;
      return;
    }
    next();
  }
}
