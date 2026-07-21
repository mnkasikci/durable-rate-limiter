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
