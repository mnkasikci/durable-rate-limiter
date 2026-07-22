import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    // The package's own suites only. `cli/` is Node — it imports node:os and
    // node:child_process, which do not resolve inside workerd — and runs under
    // vitest.cli.config.ts instead.
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        // Per-test storage isolation cannot work here: write-through
        // persistence is deliberately fire-and-forget (`void storage.put`), so
        // a write can still be in flight when a test ends and the pool fails
        // trying to pop the storage stack. Tests take a distinct limiter name
        // each instead, which is the isolation `idFromName` already provides.
        isolatedStorage: false,
        miniflare: {
          compatibilityFlags: ['nodejs_compat'],
        },
      },
    },
    coverage: {
      // V8's native coverage is not available inside workerd; istanbul
      // instruments the source instead and is the only provider that works.
      provider: 'istanbul',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
