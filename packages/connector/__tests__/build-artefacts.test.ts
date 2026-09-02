import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Cheap guard on the `exports` map: a broken entry or a missing dual-format
// output shows up here in CI (build runs before test) rather than at publish
// time. Skips itself locally when `dist/` has not been built yet.
const pkgRoot = resolve(__dirname, '..');
const dist = (p: string) => resolve(pkgRoot, 'dist', p);
const distBuilt = existsSync(dist('index.js'));

describe.skipIf(!distBuilt)('build artefacts (dist/)', () => {
  const entries = [
    'index',
    'shims/express',
    'shims/fastify',
    'shims/lambda',
  ];

  for (const entry of entries) {
    it(`emits ${entry}.{js,cjs,d.ts}`, () => {
      expect(existsSync(dist(`${entry}.js`)), `${entry}.js`).toBe(true);
      expect(existsSync(dist(`${entry}.cjs`)), `${entry}.cjs`).toBe(true);
      expect(existsSync(dist(`${entry}.d.ts`)), `${entry}.d.ts`).toBe(true);
    });
  }
});

it('fails in CI if dist/ was never built', () => {
  // In CI the build step precedes the test step, so dist/ must exist. Locally
  // this is allowed to be absent (the describe block above self-skips).
  if (process.env.CI) {
    expect(distBuilt, 'dist/index.js — did `build` run before `test`?').toBe(true);
  }
});
