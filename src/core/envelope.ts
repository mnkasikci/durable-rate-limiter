/**
 * The single definition of what crosses the RPC boundary.
 *
 * `./do` and `./client` are two halves of one wire protocol that can be
 * deployed independently — the limiter Worker is deployed once and consuming
 * applications are deployed on their own schedules. Version skew between the
 * halves is the failure mode this file exists to prevent, so BOTH entrypoints
 * import their envelope types from here and nowhere else.
 *
 * Rules for changing anything in this file:
 *  - additive changes only (new optional fields) within a major version;
 *  - anything a client may omit is optional and has a `do`-side default;
 *  - anything the object may omit is optional and has a client-side default;
 *  - a change that is not backwards compatible bumps ENVELOPE_VERSION, which
 *    both halves check so skew fails loudly at the first call instead of
 *    silently mis-limiting.
 */

/** Bumped only on a breaking change to the shapes below. */
export const ENVELOPE_VERSION = 1;

export type EnvelopeVersion = typeof ENVELOPE_VERSION;

/**
 * What a caller hands back to the limiter after running its own work.
 *
 * An envelope rather than a `Response` is the whole design in one type. The
 * callback runs in the caller's isolate; returning a `Response` would stream
 * every byte back through a single-threaded Durable Object to reach the caller
 * that already had it. A small summary makes that a compile-time shape instead
 * of a rule someone has to remember.
 *
 * `status` and `retryAfter` are the only fields the object reads, and they are
 * enough for it to detect a rate limit and throttle *every* caller — the
 * capability an in-process limiter structurally cannot have. It parses nothing
 * else, knows no upstream, and never sees a credential.
 *
 * `status` is deliberately where the default classifier already looks, so the
 * envelope needs no bespoke classification on the object side.
 */
export interface CallReport<T> {
  /** Keep this small. Large payloads belong in the caller's isolate. */
  value: T;
  /** HTTP status of the caller's own request, when there was one. */
  status?: number;
  /** Raw `Retry-After` header value; the object parses seconds and HTTP-date. */
  retryAfter?: string | null;
}
