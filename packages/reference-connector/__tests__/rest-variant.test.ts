// S8 — the rest reference-connector variant is under test.
//
// Unlike the Postgres variant's suite this one needs NO database: the rest
// variant serves the S6 seed from memory through an in-process fixture backend.
// It runs everywhere.
//
// It proves four things:
//   1. the full 15-case conformance suite passes against the rest variant, run
//      through the built public CLI exactly as the CI gate invokes it —
//      i.e. the SAME 15 results as the Postgres variant, over the SAME seed and
//      the SAME field mapping, but through `restAdapter` instead of
//      `postgresAdapter`;
//   2. `GET /schema` returns the hand-declared schema verbatim (exact object,
//      key order) — the P2 `rest.test.ts` S7.1 shape;
//   3. (DB-gated) the rest variant's `/schema` column-NAME set is identical to
//      the Postgres variant's *introspected* `/schema` column-name set — this
//      is what proves "same dataset, same mapping", not two accidentally
//      different demos. `type` strings are allowed to differ;
//   4. the standalone entrypoint prints the `listening on :<port>` line CI
//      waits for, and shuts down cleanly.

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { sign } from '@askdepth/audience-contract';
import { start, declaredSchema, type StartedVariant } from '../src/rest-variant';
import { startFixtureApi, type StartedFixtureApi } from '../src/rest-fixture-api';
import { TABLE_NAME, fixturesSqlPath } from '../seed/generate';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

const CLI = resolve(HERE, '../../connector/dist/bin/conformance.js');
const VARIANT_SCRIPT = resolve(HERE, '../src/rest-variant.ts');
const TSX_LOADER = require.resolve('tsx');
const SECRET = 's8-rest-variant-test-secret';

/** A signed GET against a running variant, mirroring the conformance client's
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

describe('S8 — rest variant over the seeded reference base (no DB)', () => {
  let fixture: StartedFixtureApi;
  let variant: StartedVariant;

  beforeAll(async () => {
    process.env.REFERENCE_SECRET = SECRET;
    // Start the fixture backend first, then point the variant at it.
    fixture = await startFixtureApi();
    variant = await start({ port: 0, fixtureApiUrl: fixture.url });
  });

  afterAll(async () => {
    await variant?.close();
    await fixture?.close();
  });

  it('the built conformance CLI reports 15 / 15 against the rest variant', async () => {
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

  it('GET /schema returns the hand-declared schema verbatim (object + key order)', async () => {
    const res = await signedGet(variant.url, '/schema');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Deep value equality …
    expect(body).toEqual(declaredSchema);
    // … and byte-for-byte serialisation equality (key order preserved).
    expect(JSON.stringify(body)).toBe(JSON.stringify(declaredSchema));
  });

  it('the standalone entrypoint prints "listening on :<port>" and stops cleanly', async () => {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, VARIANT_SCRIPT], {
      env: { ...process.env, REFERENCE_SECRET: SECRET, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const line = await new Promise<string>((resolveLine, rejectLine) => {
        const timer = setTimeout(
          () => rejectLine(new Error('variant did not announce readiness in 20s')),
          20_000,
        );
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
      expect(code === 0 || code === null || code === 130).toBe(true);
    }
  });
});

// ── Test 3: /schema cross-check against the introspected Postgres schema ────
// DB-gated — needs the Postgres variant. Skips cleanly with no DB; MANDATORY in
// CI (the `reference-postgres` job provides one).

const DSN = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

let dbAvailable = false;
if (DSN) {
  try {
    const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
    await probe.query('SELECT 1');
    await probe.end();
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}

it('the /schema cross-check requires a Postgres when DSN is set (mandatory in CI)', () => {
  if (process.env.CI) expect(dbAvailable).toBe(true);
});

const dbDescribe = dbAvailable ? describe : describe.skip;

dbDescribe('S8 — rest vs postgres /schema column-name parity', () => {
  it('the two variants expose the identical set of column names', async () => {
    process.env.REFERENCE_SECRET = SECRET;
    process.env.DATABASE_URL = DSN;

    // The DB handed to this test need not already have `reference_users`
    // (the `workspace` CI job exports a DSN without this seed) — load it.
    const seedPool = new Pool({ connectionString: DSN });
    try {
      await seedPool.query(readFileSync(fixturesSqlPath(), 'utf8'));
    } finally {
      await seedPool.end();
    }

    const { start: startPg } = await import('../src/postgres-variant');
    const pg = await startPg({ port: 0 });
    const restFixture = await startFixtureApi();
    const rest = await start({ port: 0, fixtureApiUrl: restFixture.url });

    try {
      const pgBody = (await (await signedGet(pg.url, '/schema')).json()) as {
        columns: Array<{ name: string; type: string }>;
      };
      const restBody = (await (await signedGet(rest.url, '/schema')).json()) as {
        columns: Array<{ name: string; type: string }>;
      };

      const pgNames = [...new Set(pgBody.columns.map((c) => c.name))].sort();
      const restNames = [...new Set(restBody.columns.map((c) => c.name))].sort();

      // Identical NAME sets — `type` strings may differ (introspected vs declared).
      expect(restNames).toEqual(pgNames);
    } finally {
      await rest.close();
      await restFixture.close();
      await pg.close();
      const dropPool = new Pool({ connectionString: DSN });
      try {
        await dropPool.query(`DROP TABLE IF EXISTS "${TABLE_NAME}"`);
      } finally {
        await dropPool.end();
      }
    }
  });
});
