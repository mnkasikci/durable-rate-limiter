/**
 * The only code app-alpha and app-bravo share — and the small vocabulary the
 * apps, the mock upstream and the dashboard use across their HTTP contracts.
 *
 * Two independently-deployed Workers coordinate through this file and nothing
 * else. That is the whole demonstration: sharing a bucket is sharing a *name*,
 * so the name is written once, here, and imported by both. Everything else in
 * app-alpha and app-bravo is duplicated on purpose, to prove they are genuinely
 * separate projects that happen to agree on one string.
 */

/**
 * The bucket both apps pace against.
 *
 * This is `idFromName`'s argument on the shared limiter. A typo does not error —
 * it silently creates a *second* bucket, pacing at the full rate against the
 * same upstream quota — so the string lives in exactly one place and both apps
 * import it. That single import is the point of the demo: coordination is a
 * shared name, not a shared codebase.
 */
export const BUCKET_NAME = 'demo-upstream-api';

/** The two demo apps. Each is its own Worker; they share only this module. */
export type DemoApp = 'alpha' | 'bravo';

/** Header the apps send so the mock API can see which app called (it ignores it). */
export const HEADER_APP = 'x-demo-app';

/** Header carrying the per-attempt request id, so a call is traceable end to end. */
export const HEADER_REQUEST_ID = 'x-request-id';

/**
 * The lifecycle state one request is in, from the calling app's point of view.
 *
 * Every one is detectable client-side, which is only possible because the
 * limiter runs the callback in the *app's* isolate — so the app sees each
 * transition first-hand rather than inferring it:
 *
 *  - `queued`    — `limiter.call()` was invoked and the callback has not fired
 *                  yet: the limiter's Durable Object is parking the caller. A
 *                  request that was transiently dropped and is now waiting its
 *                  turn again re-enters here.
 *  - `inFlight`  — the callback fired; the fetch to the mock API is running.
 *  - `requeued`  — the callback's response was a 429, so the limiter will pause
 *                  every caller and re-invoke; the request waits here until its
 *                  next attempt's callback fires (back to `inFlight`).
 *  - `completed` — `call()` resolved with a served (2xx) result.
 *  - `dropped`   — a terminal failure: retries spent (`CallDroppedError`), an
 *                  unexpected throw, or a 429 that exhausted the retry budget
 *                  (resolves with the 429 envelope but was never served).
 */
export type RequestState =
  'queued' | 'inFlight' | 'requeued' | 'completed' | 'dropped';

/**
 * Why a request ended up `dropped`. A cheap breakdown behind the single headline
 * `dropped` count, so a demo run can tell a lost-queue drop from a real 429 wall.
 *
 *  - `queue`        — dropped while parked, retries spent (`CallDroppedError`).
 *  - `exhausted429` — resolved with a 429 envelope: the upstream 429'd it and the
 *                     limiter's retry budget ran out, so it was never served.
 *  - `failed`       — any other throw (a bug, an unexpected transport error).
 */
export type DropReason = 'queue' | 'exhausted429' | 'failed';

/**
 * The snapshot an app's `StatusDO` returns and its `/status` route serves.
 *
 * `counts` tallies the current state of every tracked request; `total` is how
 * many requests are tracked. The dashboard renders `counts` as five tiles and
 * uses `droppedBreakdown` only to annotate the single `dropped` tile.
 */
export interface StatusSnapshot {
  counts: {
    queued: number;
    inFlight: number;
    requeued: number;
    completed: number;
    dropped: number;
  };
  droppedBreakdown: {
    droppedQueue: number;
    exhausted429: number;
    failed: number;
  };
  total: number;
}

/**
 * The mock upstream's `/rate-limit` response — observability, explicitly OUTSIDE
 * the rate limit it reports on.
 *
 * The mock plays a third party enforcing a rolling (sliding) window exactly like
 * the package does: it records served timestamps and prunes those older than the
 * window at read time.
 *
 *  - `remaining`  — slots free in the current rolling window.
 *  - `resetInMs`  — until the window next frees a slot (the oldest served
 *                   timestamp ageing out); `0` when the window is already whole.
 *  - `served` / `rejected` — cumulative counters since the last reset.
 */
export interface RateLimitResponse {
  limitPerWindow: number;
  windowMs: number;
  processingMs: number;
  remaining: number;
  resetInMs: number;
  served: number;
  rejected: number;
}
