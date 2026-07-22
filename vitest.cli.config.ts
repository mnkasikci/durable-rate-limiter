import { defineConfig } from 'vitest/config';

// The CLI runs in Node, so it cannot be tested by the workerd pool the package
// itself uses. Separate config rather than a project, so neither suite can
// change the other's runtime by accident.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['cli/**/*.test.ts'],
  },
});
