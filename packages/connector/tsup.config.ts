import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'shims/express': 'src/shims/express.ts',
    'shims/fastify': 'src/shims/fastify.ts',
    'shims/lambda': 'src/shims/lambda.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  // Core stays dependency-free; the contract is a real runtime dependency and
  // the framework packages are optional peers — none of them get bundled.
  external: ['pg', 'express', 'fastify', '@askdepth/audience-contract'],
});
