/**
 * The two hooks, and the three-layer resolution that combines them.
 *
 * Both run in the CALLER's isolate, which is forced rather than chosen: the
 * Durable Object only ever receives the envelope, so the raw `Response` and its
 * body never leave the caller. A parser needs the body, so it runs where the
 * body is. Nor can hooks be registered once on the object — an RPC function
 * handle cannot be persisted for later use.
 *
 * ## They mean different things
 *
 * | Hook | Non-null means | Effect |
 * |---|---|---|
 * | `rateLimit` | treat exactly as an HTTP 429 | **global** — pauses every caller, then retries |
 * | `error` | the call failed; `retryable` decides | **local** — retries this call only |
 *
 * That distinction is the entire reason they are two hooks and not one
 * classifier, and blurring them turns one endpoint's 500 into a stall for every
 * other caller of the same upstream.
 */

/**
 * A rate limit the caller recognised in the body. Returned by a `rateLimit`
 * hook; `null` means "not a rate limit, ask the next layer".
 */
export interface RateLimitSignal {
  /**
   * How long to hold off, in milliseconds. Omit when the body says only *that*
   * it is limited and not for how long — the standard backoff then applies.
   */
  retryAfterMs?: number;
}

/**
 * A failure described as data, never thrown.
 *
 * Thrown errors arrive on the far side stripped to `name`/`message`/`stack`, so
 * `retryable` could not survive as an error property. It travels in the
 * envelope instead. See `CallReport.failure`.
 */
export interface FailureDescription {
  message: string;
  /** `false` is final — the object must not try again. */
  retryable: boolean;
}

/**
 * Recognise this API's rate-limit convention in a response.
 *
 * `body` is whatever `read` produced, not the raw stream: `read` has already
 * run by the time hooks are consulted, so a hook that needs the parsed body
 * does not have to consume it a second time.
 */
export type RateLimitHook<T = unknown> = (
  res: Response,
  body: T
) => RateLimitSignal | null;

/** Recognise this API's error convention, and say whether it is worth retrying. */
export type ErrorHook<T = unknown> = (
  res: Response,
  body: T
) => FailureDescription | null;

/**
 * A hook slot at a call site.
 *
 * Three distinct states, and the third is the point: absent falls through to
 * the limiter default, a function is consulted first and falls through on
 * `null`, and an explicit `null` opts out of both hook layers. The built-in
 * HTTP layer is unaffected by all three — see {@link resolveHook}.
 */
export type HookSlot<H> = H | null | undefined;

/**
 * Layers 1 and 2 of the resolution: call site, then limiter default, each
 * falling through on `null`.
 *
 * Layer 3 is not here because it is not optional. `status` and `Retry-After`
 * are copied onto every envelope unconditionally, so a real HTTP 429 is a rate
 * limit regardless of what any hook returns. Hooks can only *add* a
 * classification, never remove one.
 *
 * Chaining rather than replacing is load-bearing. Under replace semantics,
 * overriding `rateLimit` for one oddly-shaped endpoint would silently disable
 * the limiter's own detection at that call site — an invisible regression in
 * exactly the place someone was being careful.
 */
export function resolveHook<T, R>(
  res: Response,
  body: T,
  callSite: HookSlot<(res: Response, body: T) => R | null>,
  fallback: HookSlot<(res: Response, body: unknown) => R | null>
): R | null {
  // An explicit `null` at the call site opts out of the hook layers entirely,
  // including the limiter default. Anything less would leave no way to say
  // "this endpoint's body means nothing, judge it on HTTP alone".
  if (callSite === null) return null;

  if (callSite !== undefined) {
    const hit = callSite(res, body);
    if (hit !== null) return hit;
  }

  if (fallback === null || fallback === undefined) return null;
  return fallback(res, body);
}
