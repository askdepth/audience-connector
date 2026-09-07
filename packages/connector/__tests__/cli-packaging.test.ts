// S9.5 — the conformance CLI must survive packaging.
//
// `@askdepth/audience-connector` ships the conformance runner as a `bin`
// (`audience-connector` → `dist/bin/conformance.js`). A third party installs
// the tarball `npm publish` would upload and runs `npx audience-connector
// conformance …`; the bin only exists for them if `files`, the tsup build, and
// the `bin` field all still line up. A future `files` narrowing or a tsup
// entry rename could silently drop the CLI from the tarball and nobody would
// notice until a consumer's `npx` failed.
//
// This is the durable guard: it runs `npm pack --dry-run --json` for this
// workspace (local, no network, no install) and asserts the packed file list
// carries the CLI, plus that the manifest still points `bin` at it.
//
// The heavier flow — pack this workspace + the contract, `npm install` both
// into a throwaway dir OUTSIDE the monorepo, and run the just-installed
// `audience-connector` bin against the rest reference variant — is verified by
// hand in S9.5 (see docs/conformance.md) and, if wired, belongs in a CI job
// gated on an env flag, not in the default unit suite: it needs `pnpm pack`,
// two `npm install`s, and a live server.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const pkgRoot = resolve(__dirname, '..');

interface PackEntry {
  path: string;
}
interface PackReport {
  name: string;
  version: string;
  files: PackEntry[];
}

function packDryRun(): PackReport {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: pkgRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const report = JSON.parse(raw) as PackReport[];
  return report[0];
}

describe('conformance CLI is in the published tarball', () => {
  const report = packDryRun();
  const paths = report.files.map((f) => f.path);

  it('packs the executable bundle and its CJS pin', () => {
    expect(paths, 'dist/bin/conformance.js missing from tarball').toContain(
      'dist/bin/conformance.js',
    );
    expect(paths, 'dist/bin/package.json missing from tarball').toContain(
      'dist/bin/package.json',
    );
  });

  it('packs the library entrypoints alongside it', () => {
    for (const f of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts']) {
      expect(paths, `${f} missing from tarball`).toContain(f);
    }
  });

  it('the packed manifest points bin at the packed file', () => {
    // `npm pack` copies `bin` into the published manifest verbatim — no
    // rewriting — so the on-disk manifest is what a consumer resolves.
    const manifest = JSON.parse(
      readFileSync(resolve(pkgRoot, 'package.json'), 'utf8'),
    ) as { bin?: Record<string, string>; files?: string[] };

    expect(manifest.bin?.['audience-connector']).toBe('dist/bin/conformance.js');
    // The bin path must sit under a `files` entry or npm drops it.
    expect(manifest.files).toContain('dist');
  });
});
