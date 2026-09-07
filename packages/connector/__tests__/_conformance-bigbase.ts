// Test-only fixture for the S4 seeded-data conformance cases (N3, N5, N6, N7).
//
// Not a `*.test.ts` file, so vitest does not collect it. Lives under
// `__tests__/` on purpose — no conformance fixture is allowed under `src/`.
//
// Provides:
//   * `bigSyntheticUsers()` — a deterministic, seeded synthetic base of >= 3000
//     rows, with a monotonic `signupAt`, a filter-only `attr.plan`, a
//     returnable `attr.tier`, and TWO columns that exist in the row data but
//     are absent from `fieldMapping` and from the declared `/schema` columns
//     (`internal_notes`, `secret_note`) — the shape N3 needs, mirroring
//     `postgres.test.ts` S6.3's fixture.
//   * `bigCorrectClient()` — a genuine in-process connector over that base.
//   * `bigBrokenClient(bug)` — the same connector with exactly one violation
//     wired in, for N3 / N5 / N7.
//   * `bigRowCapClient()` — a hand-built fetch seam that returns 1,500 rows for
//     a capped request, for N6 (the frozen handler's defensive slice makes an
//     over-cap response impossible through `createConnector`).
//   * `UNMAPPED_COLUMNS` — the out-of-band list handed to N3 via the runner
//     context (mirrors the CLI's `--unmapped-column`).

import { verify } from '@askdepth/audience-contract';
import { createConnector } from '../src/index';
import type { Adapter, CanonicalRow } from '../src/types';
import { pageInMemory, memAdapter, type MemRow } from './_mem-adapter';
import { ROW_CAP, type QueryPlan } from '../src/plan';
import {
  createConformanceClient,
  type ConformanceClient,
} from '../src/conformance/client';

export const BIGBASE_SECRET = 'conformance-s4-bigbase-secret';
const BASE_URL = 'http://bigbase.fixture/askdepth/v1';

export const BIG_FIELD_MAPPING = {
  externalId: 'user_id',
  email: 'email_addr',
  name: 'full_name',
  segment: 'segment',
  signupAt: 'signup_at',
  isActive: 'is_active',
} as const;

export const BIG_ATTRIBUTES = { filterable: ['plan', 'tier'], returnable: ['tier'] };

/** Only the mapped store columns are declared. `internal_notes` / `secret_note`
 *  exist in the row data but are deliberately NOT here — that is the point. */
export const BIG_COLUMNS = [
  { name: 'user_id', type: 'text' },
  { name: 'email_addr', type: 'text' },
  { name: 'full_name', type: 'text' },
  { name: 'segment', type: 'text' },
  { name: 'signup_at', type: 'timestamptz' },
  { name: 'is_active', type: 'boolean' },
];

/** Store columns that exist in the data but are intentionally unmapped. */
export const UNMAPPED_COLUMNS = ['internal_notes', 'secret_note'] as const;

/** Deterministic PRNG — mulberry32. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BIG_COUNT = 3200;

/** >= 3000 deterministic rows. `signupAt` strictly increases with insertion. */
export function bigSyntheticUsers(count = BIG_COUNT): MemRow[] {
  const rnd = mulberry32(0x5f4a4c00);
  const rows: MemRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rnd();
    rows.push({
      externalId: `big-${String(i).padStart(5, '0')}`,
      email: `big${i}@synthetic.example`,
      name: `Big Synthetic ${i}`,
      segment: r < 0.5 ? 'enterprise' : 'smb',
      signupAt: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString(),
      isActive: rnd() < 0.75,
      attributes: {
        plan: rnd() < 0.2 ? 'pro' : 'basic', // filter-only
        tier: rnd() < 0.4 ? 'gold' : 'silver', // returnable
      },
      // Present in the store, absent from fieldMapping and BIG_COLUMNS.
      internal_notes: `NOTE_${i}_do_not_export`,
      secret_note: `SECRET_${i}`,
    });
  }
  return rows;
}

function seamClient(fetchImpl: typeof fetch): ConformanceClient {
  return createConformanceClient({ url: BASE_URL, secret: BIGBASE_SECRET, fetchImpl });
}

function connectorFetch(adapter: Adapter): typeof fetch {
  const connector = createConnector({
    secret: BIGBASE_SECRET,
    adapter,
    fieldMapping: BIG_FIELD_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
  return async (input, init) => connector.fetch(new Request(String(input), init as RequestInit));
}

/** A genuine in-process connector over the big base. */
export function bigCorrectClient(): ConformanceClient {
  return seamClient(connectorFetch(memAdapter(bigSyntheticUsers(), { columns: BIG_COLUMNS })));
}

export type BigBug =
  | 'leakUnmappedColumn' // N3: every search row carries `internal_notes`
  | 'randomPageOrder' // N5: each page is an ORDER BY random() slice, cursor ignored
  | 'oldestSampleNotRandom'; // N7: a `sample` request returns the oldest S by signup

export function bigBrokenClient(bug: BigBug): ConformanceClient {
  const source = bigSyntheticUsers();
  const base = memAdapter(source, { columns: BIG_COLUMNS });

  const broken: Adapter = {
    ...base,
    async search(plan: QueryPlan, ctx) {
      if (bug === 'leakUnmappedColumn') {
        const real = await base.search(plan, ctx);
        return {
          ...real,
          rows: real.rows.map((row, i) => ({
            ...row,
            internal_notes: (source[i] as MemRow).internal_notes,
          })) as CanonicalRow[],
        };
      }

      if (bug === 'randomPageOrder') {
        // A real page only to borrow a valid, continuing cursor. The rows are a
        // fresh ORDER BY random() slice of the whole (correctly projected)
        // result set, and `plan.after` is ignored — so pages overlap and the
        // same cursor never returns the same bytes twice.
        const real = await base.search(plan, ctx);
        const full = pageInMemory(source, { ...plan, limit: ROW_CAP, after: undefined });
        const limit = plan.limit ?? ROW_CAP;
        const rows = [...full.rows]
          .map((r) => ({ r, k: Math.random() }))
          .sort((a, b) => a.k - b.k)
          .slice(0, limit)
          .map(({ r }) => r) as CanonicalRow[];
        return { rows, nextCursor: real.nextCursor };
      }

      // oldestSampleNotRandom
      if (plan.sample) {
        const size = plan.sample.size;
        const rows = source.slice(0, size).map(
          (r) => ({ externalId: r.externalId, email: r.email, signupAt: r.signupAt }) as CanonicalRow,
        );
        return { rows, nextCursor: undefined };
      }
      return base.search(plan, ctx);
    },
  };

  return seamClient(connectorFetch(broken));
}

/**
 * N6 fixture. The frozen handler slices every adapter result to `plan.limit`,
 * so an over-cap response cannot come out of `createConnector`. This hand-built
 * seam verifies the signature like a real connector, answers /health, /schema
 * and /count from a real in-process connector, but returns 1,500 rows for a
 * `limit: 1000` search — the exact cap violation N6 must catch. A `limit: 1001`
 * request is still refused with the documented `limit_exceeded` code, and
 * everything else is delegated so N3 / N5 / N7 still pass here.
 */
export function bigRowCapClient(): ConformanceClient {
  const secret = Buffer.from(BIGBASE_SECRET, 'utf8');
  const delegate = connectorFetch(memAdapter(bigSyntheticUsers(), { columns: BIG_COLUMNS }));
  const jsonHeaders = { 'content-type': 'application/json' };

  const overCapRows = Array.from({ length: 1500 }, (_, i) => ({
    externalId: `cap-${String(i).padStart(4, '0')}`,
    email: `cap${i}@synthetic.example`,
    signupAt: new Date(Date.UTC(2019, 0, 1) + i * 3_600_000).toISOString(),
  }));

  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(String(input), init as RequestInit);
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const raw = method === 'GET' || method === 'HEAD' ? '' : await req.clone().text();

    const ts = req.headers.get('x-askdepth-timestamp') ?? '';
    const sig = req.headers.get('x-askdepth-signature') ?? '';
    if (!verify(raw, ts, sig, secret).valid) {
      return new Response(
        JSON.stringify({ error: { code: 'unauthorized', message: 'Request is not authorized.' } }),
        { status: 401, headers: jsonHeaders },
      );
    }

    if (url.pathname.endsWith('/candidates/search') && method === 'POST') {
      let body: { limit?: unknown; sample?: unknown; cursor?: unknown } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* fall through to delegate */
      }
      const limit = body.limit;
      if (typeof limit === 'number' && Number.isInteger(limit) && limit > 1000) {
        return new Response(
          JSON.stringify({
            error: { code: 'limit_exceeded', message: 'Request exceeds an allowed limit.' },
          }),
          { status: 400, headers: jsonHeaders },
        );
      }
      if (limit === 1000 && body.sample === undefined && body.cursor === undefined) {
        // The violation: a single response over the 1,000-row cap.
        return new Response(JSON.stringify({ rows: overCapRows, nextCursor: undefined }), {
          status: 200,
          headers: jsonHeaders,
        });
      }
    }

    return delegate(input, init);
  };

  return seamClient(fetchImpl);
}
