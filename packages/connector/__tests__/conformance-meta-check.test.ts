// S5 — the suite tests itself (§0.5 exit criterion).
//
// A conformance runner that passes everything is worse than none: it converts
// an untested integration into a certified one. So for each of the eight
// deliberately-broken fixtures under `__tests__/fixtures/`, this spins the
// fixture up in-process, runs the FULL 15-case suite against it, and asserts
// that EXACTLY the one case the fixture is named for reports `pass:false` and
// all other 14 report `pass:true`.
//
// This is the test that catches a case that is too strict (false-failing
// something unrelated) or too loose (missing what it should catch).
//
// The N7 RNG (`crypto.getRandomValues`, the connector's per-pull shuffle seed)
// is pinned for determinism, exactly as in S4.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  CONFORMANCE_CASES,
  runConformance,
  type CaseResult,
} from '../src/conformance/runner';
import type { ConformanceClient } from '../src/conformance/client';
import { SEED_URL, WITH_UNMAPPED, referenceClient } from './fixtures/_seed';
import { createUnsignedOkClient } from './fixtures/unsigned-ok';
import { createWeakSignatureClient } from './fixtures/weak-signature';
import { createLeakyColumnsClient } from './fixtures/leaky-columns';
import { createLeakyErrorsClient } from './fixtures/leaky-errors';
import { createNondeterministicCursorClient } from './fixtures/nondeterministic-cursor';
import { createNoRowCapClient } from './fixtures/no-row-cap';
import { createFakeRandomSampleClient } from './fixtures/fake-random-sample';
import { createWritePathExposedClient } from './fixtures/write-path-exposed';

interface FixtureSpec {
  dir: string;
  /** The single negative case this fixture must trip. */
  expects: string;
  make: () => ConformanceClient;
}

const FIXTURES: FixtureSpec[] = [
  { dir: 'unsigned-ok', expects: 'N1', make: createUnsignedOkClient },
  { dir: 'weak-signature', expects: 'N2', make: createWeakSignatureClient },
  { dir: 'leaky-columns', expects: 'N3', make: createLeakyColumnsClient },
  { dir: 'leaky-errors', expects: 'N4', make: createLeakyErrorsClient },
  { dir: 'nondeterministic-cursor', expects: 'N5', make: createNondeterministicCursorClient },
  { dir: 'no-row-cap', expects: 'N6', make: createNoRowCapClient },
  { dir: 'fake-random-sample', expects: 'N7', make: createFakeRandomSampleClient },
  { dir: 'write-path-exposed', expects: 'N8', make: createWritePathExposedClient },
];

/** Pin `generateSeed()`'s only entropy source to a fixed cycle of byte fills,
 *  so every cursorless pull gets a fixed but distinct seed. Mirrors S4. */
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

async function runSuite(client: ConformanceClient): Promise<CaseResult[]> {
  const summary = await runConformance(client, CONFORMANCE_CASES, {
    url: SEED_URL,
    timeoutMs: 30_000,
    context: WITH_UNMAPPED,
  });
  return summary.cases;
}

describe('S5 — the conformance suite tests itself against 8 broken fixtures', () => {
  const results = new Map<string, CaseResult[]>();

  beforeAll(async () => {
    pinPullSeeds();
    results.set('__reference__', await runSuite(referenceClient()));
    for (const f of FIXTURES) {
      results.set(f.dir, await runSuite(f.make()));
    }
    vi.restoreAllMocks();
  }, 120_000);

  afterAll(() => vi.restoreAllMocks());

  it('the correct reference fixture passes all 15 (7 positive + 8 negative), 0 fail', () => {
    const cases = results.get('__reference__')!;
    expect(cases).toHaveLength(15);
    expect(cases.filter((c) => !c.pass).map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
  });

  for (const f of FIXTURES) {
    it(`${f.dir} → fails ONLY ${f.expects}`, () => {
      const cases = results.get(f.dir)!;
      expect(cases).toHaveLength(15);

      const failed = cases.filter((c) => !c.pass);
      expect(
        failed.map((c) => `${c.id}: ${c.detail}`),
        `${f.dir}: expected exactly [${f.expects}] to fail`,
      ).toHaveLength(1);
      expect(failed[0].id).toBe(f.expects);

      // And the named case really did assert something — a non-empty detail.
      expect(typeof failed[0].detail).toBe('string');
      expect((failed[0].detail ?? '').length).toBeGreaterThan(10);
    });
  }

  it('every fixture trips exactly its own case and nothing else (aggregate)', () => {
    const table = FIXTURES.map((f) => {
      const failed = results.get(f.dir)!.filter((c) => !c.pass).map((c) => c.id);
      return { fixture: f.dir, expects: f.expects, failed };
    });
    expect(table).toEqual(
      FIXTURES.map((f) => ({ fixture: f.dir, expects: f.expects, failed: [f.expects] })),
    );
  });
});
