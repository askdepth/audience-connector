// S5 (A) — N3 grades candidate-data leakage, NOT schema introspection.
//
// S4's N3 asserted a declared-unmapped column must appear in NO response,
// `/schema` included. That is wrong: a genuine postgres connector's `/schema`
// legitimately returns every introspected store column (P2, `postgres.test.ts`
// S6.16), including columns absent from `fieldMapping`. Spec item 3 ("returns
// unmapped columns") is about candidate-data leakage.
//
// N3 now grades only `/candidates/search` row payloads and `/candidates/count`
// bodies against the declared list; `/schema` is not graded.

import { describe, it, expect } from 'vitest';
import { CONFORMANCE_CASES, type ConformanceCase } from '../src/conformance/runner';
import {
  WITH_UNMAPPED,
  referenceClient,
  referenceClientSchemaListsUnmapped,
} from './fixtures/_seed';
import { createLeakyColumnsClient } from './fixtures/leaky-columns';

const n3: ConformanceCase = CONFORMANCE_CASES.find((c) => c.id === 'N3')!;

describe('S5 — N3 does not fail on a declared column that appears only in /schema', () => {
  it('passes: /schema lists `internal_notes`, but no search row or count body carries it', async () => {
    const r = await n3.run(referenceClientSchemaListsUnmapped(), WITH_UNMAPPED);
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N3', pass: true });
    expect(r.detail).toMatch(/schema not graded/);
  });

  it('passes: the fully-mapped reference connector, with the declared list', async () => {
    const r = await n3.run(referenceClient(), WITH_UNMAPPED);
    expect(r, JSON.stringify(r)).toMatchObject({ id: 'N3', pass: true });
  });

  it('still fails: a connector that leaks `internal_notes` into candidate-data rows', async () => {
    const r = await n3.run(createLeakyColumnsClient(), WITH_UNMAPPED);
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
    expect(r.detail).toMatch(/candidates\/search/);
  });

  it('still fails structurally with no out-of-band list (data-only row-key check kept)', async () => {
    const r = await n3.run(createLeakyColumnsClient(), { unmappedColumns: [] });
    expect(r).toMatchObject({ id: 'N3', pass: false });
    expect(r.detail).toContain('internal_notes');
  });
});
