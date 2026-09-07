// S7 — the Postgres reference-connector variant is under test.
//
// Gated on a real Postgres, exactly like `packages/connector/__tests__/
// postgres.test.ts`: skips cleanly when no DB is reachable, but is MANDATORY
// in CI (`if (process.env.CI) expect(available).toBe(true)`).
//
// With a DB present it proves three things end to end:
//   1. the full 15-case conformance suite passes against the variant, run
//      through the built public CLI exactly as the CI gate invokes it;
//   2. `GET /schema` returns real introspected columns — including the two
//      intentionally-unmapped ones (`internal_notes`, `crm_account_id`), the
//      P2 §S6.16 shape, re-asserted against seeded reference data;
//   3. the standalone entrypoint prints the `listening on :<port>` line CI
//      waits for, and shuts down cleanly.

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { sign } from '@askdepth/audience-contract';
import { start, type StartedVariant } from '../src/postgres-variant';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const DSN =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let available = false;
try {
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  await probe.query('SELECT 1');
  await probe.end();
  available = true;
} catch {
  available = false;
}

it('the postgres reference-connector variant requires a Postgres (mandatory in CI)', () => {
  if (process.env.CI) expect(available).toBe(true);
});

const CLI = resolve(HERE, '../../connector/dist/bin/conformance.js');
const VARIANT_SCRIPT = resolve(HERE, '../src/postgres-variant.ts');
const TSX_LOADER = require.resolve('tsx');
const SECRET = 's7-variant-test-secret';

/** A signed GET against the running variant, mirroring the conformance client's
 *  scheme (GET signs the empty body). */
async function signedGet(url: string, path: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign('', timestamp, Buffer.from(SECRET, 'utf8'));
  return fetch(url + path, {
    headers: {
      'x-askdepth-timestamp': String(timestamp),
      'x-askdepth-signature': signature,
    },
  });
}

const d = available ? describe : describe.skip;

d('S7 — postgres variant over the seeded reference base', () => {
  let variant: StartedVariant;

  beforeAll(async () => {
    process.env.REFERENCE_SECRET = SECRET;
    process.env.DATABASE_URL = DSN;
    variant = await start({ port: 0 });
  });

  afterAll(async () => {
    await variant?.close();
  });

  it('the built conformance CLI reports 15 / 15 against the variant', async () => {
    // Async on purpose: the variant's HTTP listener shares this process's event
    // loop, so a *synchronous* child process would deadlock (the child cannot
    // connect while `execFileSync` blocks the loop).
    const { stdout: out } = await execFileAsync(
      process.execPath,
      [
        CLI,
        'conformance',
        '--url',
        variant.url,
        '--secret',
        SECRET,
        '--unmapped-column',
        'internal_notes',
        '--unmapped-column',
        'crm_account_id',
        '--filter-only-attribute',
        'country',
        '--json',
      ],
      { encoding: 'utf8' },
    );
    const report = JSON.parse(out) as {
      passed: number;
      failed: number;
      cases: Array<{ id: string; pass: boolean; detail?: string }>;
    };
    expect(report.cases.filter((c) => !c.pass)).toEqual([]);
    expect(report.passed).toBe(15);
    expect(report.failed).toBe(0);
  });

  it('GET /schema introspects real columns, including the unmapped ones', async () => {
    const res = await signedGet(variant.url, '/schema');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { columns: Array<{ name: string; type: string }> };
    expect(Array.isArray(body.columns)).toBe(true);

    const names = body.columns.map((c) => c.name);
    for (const expected of [
      'external_id',
      'email',
      'signup_at',
      'segment',
      'is_active',
      'plan',
      'country',
      'deviceType',
      'internal_notes',
      'crm_account_id',
    ]) {
      expect(names).toContain(expected);
    }
    for (const c of body.columns) expect(typeof c.type).toBe('string');
  });

  it('the standalone entrypoint prints "listening on :<port>" and stops cleanly', async () => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, VARIANT_SCRIPT], {
      env: { ...process.env, REFERENCE_SECRET: SECRET, DATABASE_URL: DSN, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const line = await new Promise<string>((resolveLine, rejectLine) => {
        const timer = setTimeout(() => rejectLine(new Error('variant did not announce readiness in 20s')), 20_000);
        let buf = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const hit = buf.split('\n').find((l) => l.startsWith('listening on :'));
          if (hit) {
            clearTimeout(timer);
            resolveLine(hit.trim());
          }
        });
        child.once('error', rejectLine);
        child.once('exit', (code) => {
          clearTimeout(timer);
          rejectLine(new Error(`variant exited early with code ${code}`));
        });
      });

      expect(line).toMatch(/^listening on :\d+$/);
    } finally {
      child.kill('SIGINT');
      const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
      // SIGINT with no handler terminates the process; either a clean 0 or a
      // signalled exit is acceptable — what matters is it does not hang.
      expect(code === 0 || code === null || code === 130).toBe(true);
    }
  });
});
