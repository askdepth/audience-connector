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
import {
  bigCorrectClient,
  bigBrokenClient,
  bigRowCapClient,
  UNMAPPED_COLUMNS,
} from './_conformance-bigbase';

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
