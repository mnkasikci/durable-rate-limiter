// Pure logic and shared types. Nothing here may touch storage, the network,
// timers, or Date.now() implicitly — clocks are passed in so the bucket stays
// testable and deterministic.
export { ENVELOPE_VERSION, type EnvelopeVersion } from './envelope.js';
