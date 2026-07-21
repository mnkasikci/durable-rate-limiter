import { defineConfig } from 'tsup';

export default defineConfig({
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
  clean: true,
  treeshake: true,
  splitting: false,
  // Both halves bundle their own copy of src/core. That is deliberate: the
  // envelope type and ENVELOPE_VERSION come from one file in one package, so
  // the two entrypoints can never be built from different definitions.
});
