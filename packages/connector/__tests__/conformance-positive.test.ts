// S2 — the seven positive conformance cases (P1–P7 of docs/conformance-spec.md).
//
// Two obligations per case:
//   1. a correct in-process P2 connector makes it pass;
//   2. a connector that is subtly wrong for that one behaviour makes it fail,
//      with a `detail` that names expected-vs-observed.
// Plus: `--case` selection still works with a populated registry, and an
// unknown id is still exit 2 (not a silent no-op).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { CONFORMANCE_CASES, runConformance } from '../src/conformance/runner';
import type { ConformanceCase, ConformanceCaseContext } from '../src/conformance/runner';
import { main } from '../src/bin/conformance';
import {
  brokenClient,
  brokenHealthClient,
  correctClient,
  correctClientNoReturnable,
  type Bug,
} from './_conformance-fixtures';
import { startStubConnector, type StubConnector } from './_conformance-stub';

const byId = (id: string): ConformanceCase => {
  const c = CONFORMANCE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no such case ${id}`);
  return c;
};

const ALL_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const;

// S3 wired the four wire-provable negatives; S4 added the seeded-data ones.
// The registry is now the full 15 in spec order.
const NEGATIVE_IDS = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'] as const;

describe('S2 — registry shape', () => {
  it('holds P1–P7 then N1–N8, in spec order, with matching kinds', () => {
    expect(CONFORMANCE_CASES.map((c) => c.id)).toEqual([...ALL_IDS, ...NEGATIVE_IDS]);
    const kind = Object.fromEntries(CONFORMANCE_CASES.map((c) => [c.id, c.kind]));
    for (const id of ALL_IDS) expect(kind[id]).toBe('positive');
    for (const id of NEGATIVE_IDS) expect(kind[id]).toBe('negative');
  });
});

describe('S2 — a correct connector passes every positive case', () => {
  for (const id of ALL_IDS) {
    it(`${id} passes`, async () => {
      const result = await byId(id).run(correctClient());
      expect(result, JSON.stringify(result)).toMatchObject({ id, pass: true });
    });
  }
});

describe('S2 — a subtly-wrong connector fails the matching case', () => {
  const brokenFor: Record<(typeof ALL_IDS)[number], () => ReturnType<typeof correctClient>> = {
    P1: brokenHealthClient,
    P2: () => brokenClient('emptySchema'),
    P3: () => brokenClient('negativeCount'),
    P4: () => brokenClient('noCursor'),
    P5: () => brokenClient('ignoreExternalIdIn'),
    P6: () => brokenClient('leakFilterAttribute'),
    P7: () => brokenClient('ignoreSuppress'),
  };

  // P6's leak is only a *conformance* failure once the operator declares which
  // attribute is filter-only: without `--filter-only-attribute` a connector
  // that returns `plan` in rows is not non-conformant (E-1). So grade the
  // broken P6 fixture in declared mode.
  const contextFor: Partial<Record<(typeof ALL_IDS)[number], ConformanceCaseContext>> = {
    P6: {
      unmappedColumns: [],
      filterOnlyAttributes: ['plan'],
      filterOnlyAttributeValues: {},
    },
  };

  for (const id of ALL_IDS) {
    it(`${id} fails with an expected-vs-observed detail`, async () => {
      const result = await byId(id).run(brokenFor[id](), contextFor[id]);
      expect(result.id).toBe(id);
      expect(result.pass).toBe(false);
      expect(typeof result.detail).toBe('string');
      expect(result.detail && result.detail.length).toBeGreaterThan(10);
      expect(result.detail).toMatch(/expected/i);
    });
  }
});

describe('S2 — the broken fixtures are wrong ONLY for their own case', () => {
  // Guards against a fixture that fails for an unrelated reason (which would
  // make the "suite catches it" claim hollow). `negativeCount` is excluded
  // on purpose: `/candidates/count` is a shared primitive that P5/P6/P7 use
  // as a cross-check, so a broken count legitimately trips more than P3.
  //
  // The third tuple element lists cases that share a primitive with the bug
  // and so legitimately also fail:
  //   * `ignoreExternalIdIn` — P4 and P7 now pin their bounded working sets
  //     with an `externalId IN` clause (to stay size-agnostic, since cursorless
  //     search is randomly sub-sampled per pull), so a connector that drops
  //     that filter fails them too. That is a real defect both should catch.
  const spec: Array<[Bug, (typeof ALL_IDS)[number], Array<(typeof ALL_IDS)[number]>]> = [
    ['emptySchema', 'P2', []],
    ['noCursor', 'P4', []],
    ['ignoreExternalIdIn', 'P5', ['P4', 'P7']],
    ['leakFilterAttribute', 'P6', []],
    ['ignoreSuppress', 'P7', []],
  ];

  for (const [bug, ownId, alsoFails] of spec) {
    it(`${bug} leaves the other cases passing`, async () => {
      for (const id of ALL_IDS) {
        if (id === ownId || id === 'P1' || alsoFails.includes(id)) continue;
        const result = await byId(id).run(brokenClient(bug));
        expect(result, `${bug} unexpectedly broke ${id}: ${result.detail}`).toMatchObject({
          id,
          pass: true,
        });
      }
    });
  }
});

describe('P6 — attribute-filter grading no longer hardcodes the connector schema', () => {
  const P6 = () => byId('P6');
  const declared = (
    filterOnlyAttributes: string[],
    filterOnlyAttributeValues: Record<string, string> = {},
  ): ConformanceCaseContext => ({
    unmappedColumns: [],
    filterOnlyAttributes,
    filterOnlyAttributeValues,
  });

  it('no flag, correct connector → passes by exercising a real returnable-attribute filter', async () => {
    const r = await P6().run(correctClient());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'P6', pass: true });
    // Not a vacuous pass: a concrete attr.* filter on a discovered returnable
    // attribute was sent and its value checked on every row.
    expect(r.detail).toMatch(/exercised attr\.\* filtering on the observed returnable attribute/);
    expect(r.detail).toMatch(/attr\.tier ==/);
    expect(r.detail).toMatch(/count \d+/);
    expect(r.detail).not.toMatch(/projects no returnable attributes/);
  });

  it('no flag, connector with NO returnable attributes → honest limited pass that names the limitation', async () => {
    const r = await P6().run(correctClientNoReturnable());
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'P6', pass: true });
    expect(r.detail).toMatch(/connector projects no returnable attributes/);
    expect(r.detail).toMatch(/--filter-only-attribute/);
  });

  it('--filter-only-attribute plan=pro → passes; detail shows the declared filter narrowed and stayed absent', async () => {
    const r = await P6().run(correctClient(), declared(['plan'], { plan: 'pro' }));
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'P6', pass: true });
    expect(r.detail).toMatch(/filtered on attr\.plan == "pro"/);
    expect(r.detail).toMatch(/subset of \d+/);
    expect(r.detail).toMatch(/"plan" absent from every row/);
    // The additive returnable cross-check still ran.
    expect(r.detail).toMatch(/also filtered on returnable attr\.tier/);
  });

  it('--filter-only-attribute plan (no value) → passes; detail shows the structural-acceptance probe ran', async () => {
    const r = await P6().run(correctClient(), declared(['plan']));
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'P6', pass: true });
    expect(r.detail).toMatch(/filtered on attr\.plan == <sentinel>: accepted structurally/);
    expect(r.detail).toMatch(/"plan" absent from every row/);
  });

  describe('subtly-wrong connectors fail, each with a detail that names the problem', () => {
    it('(a) leaks the filter-only attribute into rows', async () => {
      const r = await P6().run(brokenClient('leakFilterAttribute'), declared(['plan'], { plan: 'pro' }));
      expect(r).toMatchObject({ id: 'P6', pass: false });
      expect(r.detail).toMatch(/expected/i);
      expect(r.detail).toMatch(/plan/);
    });

    it('(b) ignores an attr.* filter entirely (returns the full set regardless)', async () => {
      const r = await P6().run(brokenClient('ignoreAttrFilter'));
      expect(r).toMatchObject({ id: 'P6', pass: false });
      expect(r.detail).toMatch(/expected/i);
      expect(r.detail).toMatch(/filter ignored, not applied/);
    });

    it('(b) ignores an attr.* filter — also caught in declared mode', async () => {
      const r = await P6().run(brokenClient('ignoreAttrFilter'), declared(['plan'], { plan: 'pro' }));
      expect(r).toMatchObject({ id: 'P6', pass: false });
      expect(r.detail).toMatch(/expected/i);
    });

    it('(c) 400s on any attr.* clause', async () => {
      const r = await P6().run(brokenClient('rejectAttrFilter'));
      expect(r).toMatchObject({ id: 'P6', pass: false });
      expect(r.detail).toMatch(/expected/i);
      expect(r.detail).toMatch(/observed 400/);
    });

    it('(c) 400s on any attr.* clause — also caught in declared mode', async () => {
      const r = await P6().run(brokenClient('rejectAttrFilter'), declared(['plan']));
      expect(r).toMatchObject({ id: 'P6', pass: false });
      expect(r.detail).toMatch(/expected the connector to accept and process an attr\.plan filter/);
    });
  });
});

describe('S2 — case selection with a populated registry', () => {
  it('runConformance only:["P1","P2"] runs exactly those two', async () => {
    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: 'http://connector.fixture/askdepth/v1',
      timeoutMs: 5000,
      only: ['P1', 'P2'],
    });
    expect(summary.cases.map((c) => c.id)).toEqual(['P1', 'P2']);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('runConformance with no filter runs the whole registry (P1–P7 + N1–N8)', async () => {
    // N7 is statistical; pin the per-pull shuffle seed so this stays green.
    const fills = [0x11, 0x9a, 0xde, 0x0f, 0xca, 0x37, 0x5b, 0xe2];
    let n = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: ArrayBufferView) => {
      const u = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
      const f = fills[n++ % fills.length];
      for (let k = 0; k < u.length; k++) u[k] = (f + k * 31) & 0xff;
      return arr;
    }) as typeof crypto.getRandomValues);

    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: 'http://connector.fixture/askdepth/v1',
      timeoutMs: 20000,
    });
    vi.restoreAllMocks();
    expect(summary.cases.map((c) => c.id)).toEqual([...ALL_IDS, ...NEGATIVE_IDS]);
    expect(summary.cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(summary.failed).toBe(0);
  });
});

describe('S2 — unknown --case id is still a runner error (exit 2)', () => {
  let stub: StubConnector | undefined;
  afterEach(async () => {
    await stub?.close();
    stub = undefined;
  });

  it('exits 2, names the unknown id, does not silently run zero cases', async () => {
    stub = await startStubConnector('any-secret');
    const err: string[] = [];
    const out: string[] = [];
    const code = await main(
      ['--url', stub.url, '--secret', 'any-secret', '--case', 'xyz'],
      { out: (s) => out.push(s), err: (s) => err.push(s) },
    );
    expect(code).toBe(2);
    expect(err.join('').toLowerCase()).toContain('unknown case');
    expect(err.join('')).toContain('xyz');
  });

  it('a known id (P3) selects and passes against the correct fixture', async () => {
    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: 'http://connector.fixture/askdepth/v1',
      timeoutMs: 5000,
      only: ['P3'],
    });
    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]).toMatchObject({ id: 'P3', pass: true });
  });
});
