import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // No externals beyond zod — the whole point is a client installs this
  // one package and gets a working signer, no further resolution needed.
});
