// The limiter Worker, exactly as a consumer would deploy it: re-export the
// two classes from the package and nothing else. If this file ever needs to
// contain logic, the package has failed at its job.
//
// It imports from `../../../dist`, not from `../../../src`. That is
// deliberate — the harness verifies the artifact that gets published, so
// `npm run build` is step one of the deploy sequence in the README. A harness
// that tested the sources could pass while the built package was broken.
export { LimiterDO, LimiterEntrypoint } from '../../../dist/do.js';

// A Worker exporting a WorkerEntrypoint still needs its own default export for
// HTTP. This one cannot be reached through a preview URL anyway: "Preview URLs
// are not generated for Workers that implement a Durable Object."
export default {
  fetch(): Response {
    return new Response('drl-verify-limiter\n', {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
