import { defineConfig } from 'tsup';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Core stays dependency-free; the contract is a real runtime dependency and
// the framework packages are optional peers — none of them get bundled.
const external = ['pg', 'express', 'fastify', '@askdepth/audience-contract'];

export default defineConfig([
  // Library entries — dual ESM/CJS with types, unchanged.
  {
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
    external,
  },
  // The conformance CLI. CommonJS + `#!/usr/bin/env node` shebang so
  // `dist/bin/conformance.js` is directly executable. The package is
  // `type: module`, so a sibling `dist/bin/package.json` pins this one file
  // back to CommonJS. `clean: false` — the library build above already wiped
  // dist/.
  {
    entry: { 'bin/conformance': 'src/bin/conformance.ts' },
    format: ['cjs'],
    outExtension: () => ({ js: '.js' }),
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'es2022',
    external,
    banner: { js: '#!/usr/bin/env node' },
    async onSuccess() {
      const dir = resolve(process.cwd(), 'dist', 'bin');
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
    },
  },
]);
