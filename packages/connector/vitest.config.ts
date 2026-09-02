import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const here = import.meta.dirname;

// The `examples/` apps import the package by its public name to prove the
// published surface works unmodified. In the test run we alias that name to
// the local source (subpaths first). CI's `examples/smoke.mjs` exercises the
// built `dist/` on Node/Deno/Bun.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@askdepth/audience-connector/express',
        replacement: resolve(here, 'src/shims/express.ts'),
      },
      {
        find: '@askdepth/audience-connector/fastify',
        replacement: resolve(here, 'src/shims/fastify.ts'),
      },
      {
        find: '@askdepth/audience-connector/lambda',
        replacement: resolve(here, 'src/shims/lambda.ts'),
      },
      {
        find: '@askdepth/audience-connector',
        replacement: resolve(here, 'src/index.ts'),
      },
    ],
  },
});
