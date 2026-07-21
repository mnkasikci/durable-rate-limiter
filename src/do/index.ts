// Public entrypoint for `@bakidev/durable-rate-limiter/do`.
//
// A consumer's limiter Worker re-exports the Durable Object class from here and
// deploys it. Module scope must stay inert: no I/O, no timers, no side effects.
export { ENVELOPE_VERSION } from '../core/index.js';
export { RateLimiterDurableObject } from './rate-limiter.js';

// The limiter Worker's default export lands here.
export default {
  fetch(): Response {
    return new Response('durable-rate-limiter', { status: 200 });
  },
};
