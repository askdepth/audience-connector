// S2 — the seven positive conformance cases (P1–P7 of docs/conformance-spec.md).
//
// Two obligations per case:
//   1. a correct in-process P2 connector makes it pass;
//   2. a connector that is subtly wrong for that one behaviour makes it fail,
//      with a `detail` that names expected-vs-observed.
// Plus: `--case` selection still works with a populated registry, and an
// unknown id is still exit 2 (not a silent no-op).

import { describe, it, expect, afterEach } from 'vitest';
import { CONFORMANCE_CASES, runConformance } from '../src/conformance/runner';
import type { ConformanceCase } from '../src/conformance/runner';
import { main } from '../src/bin/conformance';
import {
  brokenClient,
  brokenHealthClient,
  correctClient,
  type Bug,
} from './_conformance-fixtures';
import { startStubConnector, type StubConnector } from './_conformance-stub';

const byId = (id: string): ConformanceCase => {
  const c = CONFORMANCE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no such case ${id}`);
  return c;
};

const ALL_IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7'] as const;

describe('S2 — registry shape', () => {
  it('holds exactly P1–P7, in spec order, all kind:"positive"', () => {
    expect(CONFORMANCE_CASES.map((c) => c.id)).toEqual([...ALL_IDS]);
    expect(CONFORMANCE_CASES.every((c) => c.kind === 'positive')).toBe(true);
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

  for (const id of ALL_IDS) {
    it(`${id} fails with an expected-vs-observed detail`, async () => {
      const result = await byId(id).run(brokenFor[id]());
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
  const spec: Array<[Bug, (typeof ALL_IDS)[number]]> = [
    ['emptySchema', 'P2'],
    ['noCursor', 'P4'],
    ['ignoreExternalIdIn', 'P5'],
    ['leakFilterAttribute', 'P6'],
    ['ignoreSuppress', 'P7'],
  ];

  for (const [bug, ownId] of spec) {
    it(`${bug} leaves the other cases passing`, async () => {
      for (const id of ALL_IDS) {
        if (id === ownId || id === 'P1') continue;
        const result = await byId(id).run(brokenClient(bug));
        expect(result, `${bug} unexpectedly broke ${id}: ${result.detail}`).toMatchObject({
          id,
          pass: true,
        });
      }
    });
  }
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

  it('runConformance with no filter runs all seven', async () => {
    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: 'http://connector.fixture/askdepth/v1',
      timeoutMs: 5000,
    });
    expect(summary.cases.map((c) => c.id)).toEqual([...ALL_IDS]);
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
