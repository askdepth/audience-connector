// S9 — the reference connector is the CI-startable artifact P4's platform
// integration tests run against. Two things are under test here:
//
//   1. Ready-signal. Both `start:*` entrypoints, spawned as standalone
//      processes with a near-clean env, reach the literal `listening on :<port>`
//      line within a bounded timeout. The Postgres variant reaches it WITHOUT a
//      live database (the `pg` pool dials lazily; the HTTP listener binds
//      first) — it only needs `DATABASE_URL` to be set.
//
//   2. Drift guard. `docs/reference-connector.md` must contain, verbatim, the
//      `start:postgres` / `start:rest` pnpm invocations AND the conformance CLI
//      command that the `reference-postgres` / `reference-rest` CI jobs use. If
//      a CI job command changes and the doc is not updated, this fails — same
//      pattern as `packages/connector/__tests__/conformance-self-check.test.ts`.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TSX_LOADER = require.resolve('tsx');
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const READY_TIMEOUT_MS = 30_000;

/**
 * Spawn `src/<script>` as its own process and resolve with the `listening on :`
 * line. Rejects — never hangs — if that line does not arrive within
 * {@link READY_TIMEOUT_MS}, so a regression fails fast.
 */
async function readySignal(
  script: string,
  extraEnv: Record<string, string>,
): Promise<{ line: string; waitedMs: number }> {
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER, resolve(HERE, '..', 'src', script)],
    {
      // Near-clean env: no DATABASE_URL / TEST_DATABASE_URL / FIXTURE_API_URL
      // unless a caller opts in via extraEnv.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const startedAt = Date.now();
  try {
    return await new Promise<{ line: string; waitedMs: number }>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `${script} did not print "listening on :" within ${READY_TIMEOUT_MS}ms\n` +
              `--- stdout ---\n${outBuf}\n--- stderr ---\n${errBuf}`,
          ),
        );
      }, READY_TIMEOUT_MS);

      let outBuf = '';
      let errBuf = '';
      child.stdout.on('data', (c: Buffer) => {
        outBuf += c.toString('utf8');
        const hit = outBuf.split('\n').find((l) => l.startsWith('listening on :'));
        if (hit) {
          clearTimeout(timer);
          resolveReady({ line: hit.trim(), waitedMs: Date.now() - startedAt });
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        errBuf += c.toString('utf8');
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `${script} exited early with code ${code}\n` +
              `--- stdout ---\n${outBuf}\n--- stderr ---\n${errBuf}`,
          ),
        );
      });
    });
  } finally {
    child.kill('SIGINT');
    if (child.exitCode === null && child.signalCode === null) {
      await once(child, 'exit').catch(() => undefined);
    }
  }
}

describe('S9 — ready-signal on a near-clean env', () => {
  it(
    'start:rest prints "listening on :<port>" (no DB, boots its own fixture backend)',
    async () => {
      const { line, waitedMs } = await readySignal('rest-variant.ts', {
        REFERENCE_SECRET: 's9-entrypoints-rest',
        PORT: '0',
      });
      expect(line).toMatch(/^listening on :\d+$/);
      // Regression guard: it must be well inside the bounded window.
      expect(waitedMs).toBeLessThan(READY_TIMEOUT_MS);
    },
    READY_TIMEOUT_MS + 15_000,
  );

  it(
    'start:postgres prints "listening on :<port>" without a live database',
    async () => {
      // DATABASE_URL is set but points at a port nothing is listening on. The
      // HTTP listener must still bind and announce readiness — the pool dials
      // lazily. This is exactly the "no live DB" case P4 hits before it seeds.
      const { line, waitedMs } = await readySignal('postgres-variant.ts', {
        REFERENCE_SECRET: 's9-entrypoints-pg',
        DATABASE_URL: 'postgres://nobody:nobody@127.0.0.1:59999/does-not-exist',
        PORT: '0',
      });
      expect(line).toMatch(/^listening on :\d+$/);
      expect(waitedMs).toBeLessThan(READY_TIMEOUT_MS);
    },
    READY_TIMEOUT_MS + 15_000,
  );
});

// ── Drift guard ───────────────────────────────────────────────────────────

const ci = readFileSync(resolve(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const doc = readFileSync(resolve(REPO_ROOT, 'docs', 'reference-connector.md'), 'utf8');

/** Collapse runs of whitespace (and shell line-continuations) to single spaces. */
const flatten = (s: string): string => s.replace(/\\\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

const flatDoc = flatten(doc);

/** Slice the YAML block for a top-level job key out of ci.yml. */
function ciJob(name: string): string {
  const from = ci.indexOf(`\n  ${name}:`);
  expect(from, `job "${name}" not found in ci.yml`).toBeGreaterThan(-1);
  const rest = ci.slice(from + 1);
  const next = rest.search(/\n  [a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('S9 — docs/reference-connector.md tracks the CI jobs (drift guard)', () => {
  for (const [job, script, port] of [
    ['reference-postgres', 'start:postgres', '8787'],
    ['reference-rest', 'start:rest', '8788'],
  ] as const) {
    const block = ciJob(job);
    const flatBlock = flatten(block);

    it(`${job}: the pnpm ${script} invocation from ci.yml is in the doc`, () => {
      const m = flatBlock.match(
        /pnpm --filter @askdepth\/reference-connector start:(postgres|rest)/,
      );
      expect(m, `ci.yml job ${job} no longer invokes a start: script the expected way`).not.toBeNull();
      expect(m![0]).toBe(`pnpm --filter @askdepth/reference-connector ${script}`);
      expect(flatDoc, `doc is missing: ${m![0]}`).toContain(m![0]);
    });

    it(`${job}: the conformance CLI command from ci.yml is in the doc`, () => {
      // Everything from `node …/conformance.js conformance` up to (not
      // including) the next YAML line that is not a shell continuation.
      const raw = block.slice(block.indexOf('node packages/connector/dist/bin/conformance.js'));
      const cmdLines: string[] = [];
      for (const l of raw.split('\n')) {
        cmdLines.push(l);
        if (!l.trimEnd().endsWith('\\')) break;
      }
      const cmd = flatten(cmdLines.join('\n'));

      // Sanity: it is the command we think it is.
      expect(cmd).toContain('node packages/connector/dist/bin/conformance.js conformance');
      expect(cmd).toContain(`--url http://localhost:${port}/askdepth/v1`);
      expect(cmd).toContain('--unmapped-column internal_notes');
      expect(cmd).toContain('--unmapped-column crm_account_id');
      expect(cmd).toContain('--filter-only-attribute country');

      // The drift assertion: the doc carries that exact command.
      expect(flatDoc, `doc is missing the ${job} conformance command:\n${cmd}`).toContain(cmd);
    });
  }
});
