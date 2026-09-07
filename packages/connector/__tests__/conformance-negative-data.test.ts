// S4 — the four negative conformance cases that need a seeded, known data set
// to detect: N3 (unmapped columns), N5 (non-deterministic cursor pagination),
// N6 (the 1,000-row cap), N7 (a non-random subsample while advertising
// `randomSample`). Cases N1..N8 of docs/conformance-spec.md, "a connector
// fails if it…".
//
// Obligations, mirroring S2/S3:
//   1. a correct in-process connector over the big seeded base makes every one
//      PASS;
//   2. an ad-hoc fixture that commits exactly one of the violations makes the
//      matching case FAIL, with a detail that names what went wrong;
//   3. each broken fixture trips ONLY its own case;
//   4. the registry is the full 15 and `--case` selection still works.
//
// N7 is statistical. The connector's per-pull shuffle seed is pinned here so
// CI is deterministic (see `pinPullSeeds`); a live run may need a retry or two.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONFORMANCE_CASES,
  RunnerError,
  runConformance,
  type ConformanceCase,
  type ConformanceCaseContext,
} from '../src/conformance/runner';
import { main, parseArgs } from '../src/bin/conformance';
import { startStubConnector, type StubConnector } from './_conformance-stub';
import { verify } from '@askdepth/audience-contract';
import { createConnector } from '../src/index';
import type { Adapter, CanonicalRow } from '../src/types';
import { createConformanceClient, type ConformanceClient } from '../src/conformance/client';
import { memAdapter, type MemRow } from './_mem-adapter';
import {
  bigCorrectClient,
  bigBrokenClient,
  bigRowCapClient,
  bigSyntheticUsers,
  BIGBASE_SECRET,
  BIG_FIELD_MAPPING,
  BIG_ATTRIBUTES,
  BIG_COLUMNS,
  UNMAPPED_COLUMNS,
} from './_conformance-bigbase';

const BIGBASE_URL = 'http://bigbase.fixture/askdepth/v1';

/** A `ConformanceClient` wired straight into an in-process `createConnector`. */
function seam(config: Parameters<typeof createConnector>[0]): ConformanceClient {
  const connector = createConnector(config);
  const fetchImpl: typeof fetch = async (input, init) =>
    connector.fetch(new Request(String(input), init as RequestInit));
  return createConformanceClient({ url: BIGBASE_URL, secret: BIGBASE_SECRET, fetchImpl });
}

// ── D-3: a store column nested inside `row.attributes` ─────────────────────
// The adapter injects `attributes: { internal_notes: <value> }` — a real store
// column — onto every search row, and the connector's `/schema` lists
// `internal_notes` (a genuine full-store introspection). `internal_notes` is
// NOT a filterable attribute, so N3's `attr.*` disambiguation probe rejects it
// and the nested key is flagged.
function nestedAttrLeakClient(): ConformanceClient {
  const source = bigSyntheticUsers();
  const columns = [...BIG_COLUMNS, { name: 'internal_notes', type: 'text' }];
  const base = memAdapter(source, { columns });
  const notesById = new Map(source.map((r) => [r.externalId, (r as MemRow).internal_notes]));
  const adapter: Adapter = {
    ...base,
    async search(plan, ctx) {
      const real = await base.search(plan, ctx);
      return {
        ...real,
        rows: real.rows.map((row) => ({
          ...row,
          attributes: {
            ...(row.attributes ?? {}),
            internal_notes: notesById.get(row.externalId) ?? 'NOTE',
          },
        })) as CanonicalRow[],
      };
    },
  };
  return seam({
    secret: BIGBASE_SECRET,
    adapter,
    fieldMapping: BIG_FIELD_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
}

// ── D-4: a correct randomSample connector that does NOT map `signupAt` ─────
const NO_SIGNUP_MAPPING = {
  externalId: 'user_id',
  email: 'email_addr',
  name: 'full_name',
  segment: 'segment',
  isActive: 'is_active',
} as const;

function noSignupCorrectClient(): ConformanceClient {
  return seam({
    secret: BIGBASE_SECRET,
    adapter: memAdapter(bigSyntheticUsers(), { columns: BIG_COLUMNS }),
    fieldMapping: NO_SIGNUP_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
}

/** D-4: an oldest-N fake sampler that also does not map `signupAt` — must
 *  still fail N7 through the insertion-order fallback. */
function noSignupOldestSampleClient(): ConformanceClient {
  const source = bigSyntheticUsers();
  const base = memAdapter(source, { columns: BIG_COLUMNS });
  const adapter: Adapter = {
    ...base,
    async search(plan, ctx) {
      if (!plan.sample) return base.search(plan, ctx);
      const size = plan.sample.size;
      const rows = source
        .slice(0, size)
        .map((r) => ({ externalId: r.externalId, email: r.email }) as CanonicalRow);
      return { rows, nextCursor: undefined };
    },
  };
  return seam({
    secret: BIGBASE_SECRET,
    adapter,
    fieldMapping: NO_SIGNUP_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
}

// ── D-5: a sampler that returns the SAME subset on every pull ──────────────
function fixedSubsetSampleClient(): ConformanceClient {
  const source = bigSyntheticUsers();
  const base = memAdapter(source, { columns: BIG_COLUMNS });
  // A deterministic pseudo-random 400 — spread across the timeline (so it
  // clears the percentile band) but IDENTICAL on every draw.
  const fixed = [...source]
    .map((r, i) => ({ r, k: (i * 2654435761) % source.length }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 400)
    .map(({ r }) => r);
  const adapter: Adapter = {
    ...base,
    async search(plan, ctx) {
      if (!plan.sample) return base.search(plan, ctx);
      const size = plan.sample.size;
      const rows = fixed
        .slice(0, size)
        .map((r) => ({ externalId: r.externalId, email: r.email, signupAt: r.signupAt }) as CanonicalRow);
      return { rows, nextCursor: undefined };
    },
  };
  return seam({
    secret: BIGBASE_SECRET,
    adapter,
    fieldMapping: BIG_FIELD_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
}

// ── N6: a connector that drops the row cap ONLY when criteria is non-empty ──
function filteredOnlyRowCapClient(): ConformanceClient {
  const secret = Buffer.from(BIGBASE_SECRET, 'utf8');
  const delegate = createConnector({
    secret: BIGBASE_SECRET,
    adapter: memAdapter(bigSyntheticUsers(), { columns: BIG_COLUMNS }),
    fieldMapping: BIG_FIELD_MAPPING,
    attributes: BIG_ATTRIBUTES,
  });
  const j = { 'content-type': 'application/json' };
  const overCap = Array.from({ length: 1500 }, (_, i) => ({
    externalId: `fcap-${String(i).padStart(4, '0')}`,
    email: `fcap${i}@synthetic.example`,
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
        { status: 401, headers: j },
      );
    }
    if (url.pathname.endsWith('/candidates/search') && method === 'POST') {
      let body: { limit?: unknown; cursor?: unknown; sample?: unknown; criteria?: { all?: unknown } } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* delegate */
      }
      const all = body.criteria?.all;
      const nonEmpty = Array.isArray(all) && all.length > 0;
      if (
        typeof body.limit === 'number' &&
        Number.isInteger(body.limit) &&
        body.limit > 1000
      ) {
        return new Response(
          JSON.stringify({ error: { code: 'limit_exceeded', message: 'Request exceeds an allowed limit.' } }),
          { status: 400, headers: j },
        );
      }
      if (body.limit === 1000 && body.cursor === undefined && body.sample === undefined && nonEmpty) {
        // THE VIOLATION: the cap is dropped once a WHERE clause is present.
        return new Response(JSON.stringify({ rows: overCap, nextCursor: undefined }), {
          status: 200,
          headers: j,
        });
      }
    }
    return delegate.fetch(new Request(String(input), init as RequestInit));
  };
  return createConformanceClient({ url: BIGBASE_URL, secret: BIGBASE_SECRET, fetchImpl });
}

const byId = (id: string): ConformanceCase => {
  const c = CONFORMANCE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no such case ${id}`);
  return c;
};

const WITH_UNMAPPED: ConformanceCaseContext = {
  unmappedColumns: [...UNMAPPED_COLUMNS],
  filterOnlyAttributes: [],
  filterOnlyAttributeValues: {},
};
const NO_CONTEXT: ConformanceCaseContext = {
  unmappedColumns: [],
  filterOnlyAttributes: [],
  filterOnlyAttributeValues: {},
};

/**
 * Pin `generateSeed()` (the only `crypto.getRandomValues` caller) to a fixed
 * cycle of byte fills, so every cursorless pull in a test gets a fixed —
 * but distinct — seed. Mirrors the "5 fixed seeds" of plan.test.ts S5.13.
 */
function pinPullSeeds() {
  const fills = [0x11, 0x9a, 0xde, 0x0f, 0xca, 0x37, 0x5b, 0xe2];
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: ArrayBufferView) => {
    const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const f = fills[n++ % fills.length];
    for (let k = 0; k < u.length; k++) u[k] = (f + k * 31) & 0xff;
    return arr;
  }) as typeof crypto.getRandomValues);
}

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 1. a correct connector passes every seeded-data negative case
// ---------------------------------------------------------------------------

describe('S4 — a correct connector passes N3/N5/N6/N7', () => {
  it('N3 passes with an out-of-band unmapped-column list', async () => {
    const r = await byId('N3').run(bigCorrectClient(), WITH_UNMAPPED);
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N3', pass: true });
    expect(r.detail).toMatch(/internal_notes/);
  });

  it('N3 passes with no list (weaker structural check), and says so', async () => {
    const r = await byId('N3').run(bigCorrectClient(), NO_CONTEXT);
    expect(r).toMatchObject({ id: 'N3', pass: true });
    expect(r.detail).toMatch(/no out-of-band unmapped-column list/i);
  });

  it('N5 passes', async () => {
    const r = await byId('N5').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N5', pass: true });
  });

  it('N6 passes', async () => {
    const r = await byId('N6').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N6', pass: true });
  });

  it('N7 passes (seed pinned)', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N7', pass: true });
    expect(r.detail).toMatch(/percentile/);
  });
});

// ---------------------------------------------------------------------------
// 2. each broken fixture fails its own case with a naming detail
// ---------------------------------------------------------------------------

describe('S4 — a broken fixture fails the matching case', () => {
  it('N3: a row that carries an unmapped column → fail, names the column', async () => {
    const r = await byId('N3').run(bigBrokenClient('leakUnmappedColumn'), WITH_UNMAPPED);
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
  });

  it('N3: the same leak is caught even with no out-of-band list', async () => {
    const r = await byId('N3').run(bigBrokenClient('leakUnmappedColumn'), NO_CONTEXT);
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
  });

  it('N5: pages ordered by random() → fail (repeat or unstable cursor)', async () => {
    const r = await byId('N5').run(bigBrokenClient('randomPageOrder'));
    expect(r).toMatchObject({ id: 'N5', pass: false });
    expect(r.detail?.toLowerCase()).toMatch(/twice|deterministic|stable|cover/);
  });

  it('N6: ~1,500 rows for a capped request → fail, names the count', async () => {
    const r = await byId('N6').run(bigRowCapClient());
    expect(r).toMatchObject({ id: 'N6', pass: false });
    expect(r.detail).toMatch(/1500/);
    expect(r.detail).toMatch(/cap/i);
  });

  it('N7: sample returns the oldest S by signup order → fail, statistical verdict', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(bigBrokenClient('oldestSampleNotRandom'));
    expect(r).toMatchObject({ id: 'N7', pass: false });
    expect(r.detail?.toLowerCase()).toMatch(/oldest|percentile|band/);
  });
});

// ---------------------------------------------------------------------------
// 3. each broken fixture trips ONLY its own case
// ---------------------------------------------------------------------------

describe('S4 — a broken fixture is wrong ONLY for its own case', () => {
  const others = (own: string) => ['N3', 'N5', 'N6', 'N7'].filter((id) => id !== own);

  it('leakUnmappedColumn leaves N5/N6/N7 passing', async () => {
    pinPullSeeds();
    for (const id of others('N3')) {
      const r = await byId(id).run(bigBrokenClient('leakUnmappedColumn'), WITH_UNMAPPED);
      expect(r, `${id}: ${r.detail}`).toMatchObject({ id, pass: true });
    }
  });

  it('randomPageOrder leaves N3/N6/N7 passing', async () => {
    pinPullSeeds();
    for (const id of others('N5')) {
      const r = await byId(id).run(bigBrokenClient('randomPageOrder'), WITH_UNMAPPED);
      expect(r, `${id}: ${r.detail}`).toMatchObject({ id, pass: true });
    }
  });

  it('bigRowCapClient leaves N3/N5/N7 passing', async () => {
    pinPullSeeds();
    for (const id of others('N6')) {
      const r = await byId(id).run(bigRowCapClient(), WITH_UNMAPPED);
      expect(r, `${id}: ${r.detail}`).toMatchObject({ id, pass: true });
    }
  });

  it('oldestSampleNotRandom leaves N3/N5/N6 passing', async () => {
    pinPullSeeds();
    for (const id of others('N7')) {
      const r = await byId(id).run(bigBrokenClient('oldestSampleNotRandom'), WITH_UNMAPPED);
      expect(r, `${id}: ${r.detail}`).toMatchObject({ id, pass: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. registry / selection regression — the full 15
// ---------------------------------------------------------------------------

describe('S4 — registry is the full 15 and selection still works', () => {
  it('CONFORMANCE_CASES is P1–P7 then N1–N8', () => {
    expect(CONFORMANCE_CASES.map((c) => c.id)).toEqual([
      'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7',
      'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8',
    ]);
  });

  it('runConformance only:["N3","N7"] runs exactly those two, both pass', async () => {
    pinPullSeeds();
    const summary = await runConformance(bigCorrectClient(), CONFORMANCE_CASES, {
      url: 'http://bigbase.fixture/askdepth/v1',
      timeoutMs: 20000,
      only: ['N3', 'N7'],
      context: WITH_UNMAPPED,
    });
    expect(summary.cases.map((c) => c.id)).toEqual(['N3', 'N7']);
    expect(summary.failed).toBe(0);
  });

  it('an unknown id (ZZ9) → RunnerError (exit 2)', async () => {
    await expect(
      runConformance(bigCorrectClient(), CONFORMANCE_CASES, {
        url: 'http://bigbase.fixture/askdepth/v1',
        timeoutMs: 5000,
        only: ['ZZ9'],
      }),
    ).rejects.toBeInstanceOf(RunnerError);
  });
});

// ---------------------------------------------------------------------------
// 5. CLI: --unmapped-column parsing and --case selection over the bin
// ---------------------------------------------------------------------------

describe('S4 — CLI wiring', () => {
  let stub: StubConnector | undefined;
  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  it('parseArgs collects repeatable --unmapped-column', () => {
    const parsed = parseArgs([
      '--url', 'https://c.example/askdepth/v1',
      '--secret', 's',
      '--unmapped-column', 'internal_notes',
      '--unmapped-column', 'secret_note',
    ]);
    expect('help' in parsed).toBe(false);
    if ('help' in parsed) throw new Error('unreachable');
    expect(parsed.unmappedColumns).toEqual(['internal_notes', 'secret_note']);
  });

  it('parseArgs collects repeatable --filter-only-attribute', () => {
    const parsed = parseArgs([
      '--url', 'https://c.example/askdepth/v1',
      '--secret', 's',
      '--filter-only-attribute', 'country',
      '--filter-only-attribute', 'region',
    ]);
    expect('help' in parsed).toBe(false);
    if ('help' in parsed) throw new Error('unreachable');
    expect(parsed.filterOnlyAttributes).toEqual(['country', 'region']);
    expect(parsed.unmappedColumns).toEqual([]);
  });

  it('--case N3 --case N7 --unmapped-column internal_notes selects exactly those two', async () => {
    stub = await startStubConnector('cli-secret');
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      [
        '--url', stub.url,
        '--secret', 'cli-secret',
        '--json',
        '--case', 'N3',
        '--case', 'N7',
        '--unmapped-column', 'internal_notes',
      ],
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    // The bare stub is not a real connector, so the two cases fail — but the
    // point is selection + arg wiring, so exit 1 (a case failed), never 2.
    expect(code).toBe(1);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.cases.map((c: { id: string }) => c.id)).toEqual(['N3', 'N7']);
    expect(err.join('')).toBe('');
  });

  it('--case ZZ9 → exit 2', async () => {
    stub = await startStubConnector('cli-secret');
    const err: string[] = [];
    const code = await main(
      ['--url', stub.url, '--secret', 'cli-secret', '--case', 'ZZ9'],
      { out: () => {}, err: (s) => err.push(s) },
    );
    expect(code).toBe(2);
    expect(err.join('').toLowerCase()).toContain('unknown case');
  });
});

// ---------------------------------------------------------------------------
// Security-review coverage gaps: D-3, D-4, D-5, N5-filtered, N6-filtered
// ---------------------------------------------------------------------------

describe('S4 — D-3: N3 descends into row.attributes', () => {
  it('a store column nested in row.attributes → fail, names it (WITH the out-of-band list)', async () => {
    const r = await byId('N3').run(nestedAttrLeakClient(), WITH_UNMAPPED);
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
  });

  it('the same nested leak is caught with NO out-of-band list (structural attr.* probe)', async () => {
    const r = await byId('N3').run(nestedAttrLeakClient(), NO_CONTEXT);
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
    expect(r.detail).toMatch(/attributes/);
  });

  it('the correct connector (real attr.tier display) still passes N3', async () => {
    const r = await byId('N3').run(bigCorrectClient(), WITH_UNMAPPED);
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N3', pass: true });
  });
});

describe('S4 — D-4: N7 works without a signupAt mapping', () => {
  it('a correct randomSample connector with NO signupAt mapping → N7 pass via the fallback', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(noSignupCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N7', pass: true });
    expect(r.detail).toMatch(/insertion-order mode/);
  });

  it('an oldest-N fake with NO signupAt mapping still fails N7 in fallback mode', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(noSignupOldestSampleClient());
    expect(r).toMatchObject({ id: 'N7', pass: false });
    expect(r.detail?.toLowerCase()).toMatch(/oldest|percentile|band/);
  });

  it('the signupAt-mapping reference connector still runs N7 in signupAt mode', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N7', pass: true });
    expect(r.detail).toMatch(/signupAt mode/);
  });
});

describe('S4 — D-5: N7 checks the draws differ from each other', () => {
  it('a sampler that returns the SAME 400 ids on every pull → N7 pass:false on the diversity check', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(fixedSubsetSampleClient());
    expect(r).toMatchObject({ id: 'N7', pass: false });
    expect(r.detail?.toLowerCase()).toMatch(/jaccard|identical/);
  });

  it('the correct connector (independent draws) still passes the diversity check', async () => {
    pinPullSeeds();
    const r = await byId('N7').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N7', pass: true });
    expect(r.detail).toMatch(/Jaccard/);
  });
});

describe('S4 — N5: the filtered pass', () => {
  it('the nondeterministic-cursor bug still fails N5', async () => {
    const r = await byId('N5').run(bigBrokenClient('randomPageOrder'));
    expect(r).toMatchObject({ id: 'N5', pass: false });
  });

  it('the correct connector passes both the unfiltered and the externalId IN pass', async () => {
    const r = await byId('N5').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N5', pass: true });
    expect(r.detail).toMatch(/externalId IN/);
  });
});

describe('S4 — N6: the filtered pass', () => {
  it('a connector that drops the cap ONLY when criteria is non-empty → N6 pass:false', async () => {
    const r = await byId('N6').run(filteredOnlyRowCapClient());
    expect(r).toMatchObject({ id: 'N6', pass: false });
    expect(r.detail).toMatch(/filtered/);
    expect(r.detail).toMatch(/1500/);
  });

  it('the correct connector passes the unfiltered and the filtered cap check', async () => {
    const r = await byId('N6').run(bigCorrectClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N6', pass: true });
    expect(r.detail).toMatch(/filtered \(isActive/);
  });

  it('the plain over-cap fixture still fails N6 on the unfiltered leg', async () => {
    const r = await byId('N6').run(bigRowCapClient());
    expect(r).toMatchObject({ id: 'N6', pass: false });
    expect(r.detail).toMatch(/1500/);
  });
});
