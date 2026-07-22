import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      do: 'src/do/index.ts',
      client: 'src/client/index.ts',
    },
    format: ['esm'],
    // Workers runtime modules are provided by the platform, never bundled.
    external: [/^cloudflare:/],
    target: 'es2022',
    platform: 'neutral',
    dts: true,
    sourcemap: true,
    clean: false,
    treeshake: true,
    splitting: false,
    // Both halves bundle their own copy of src/core. That is deliberate: the
    // envelope type and ENVELOPE_VERSION come from one file in one package, so
    // the two entrypoints can never be built from different definitions.
  },
  {
    // The setup CLI. Node, not workerd — a separate build because it targets a
    // different runtime entirely. Neither build cleans: the two run
    // concurrently, so a `clean` here would race the other's output. The
    // `build` script wipes `dist` once, before tsup starts.
    entry: { cli: 'cli/index.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    dts: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    splitting: false,
  },
]);
