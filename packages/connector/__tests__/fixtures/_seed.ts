// Shared seeded base for the S5 deliberately-broken conformance fixtures.
//
// Not a `*.test.ts` file, so vitest does not collect it. Lives under
// `__tests__/` on purpose — no conformance fixture is allowed under `src/`
// (the `unsigned-ok` verification bypass is the single exception, and it too
// lives only under `__tests__/fixtures/`).
//
// Every fixture is a GENUINE connector instance: `createConnector` from the
// real `@askdepth/audience-connector` package, a real adapter over this base,
// and real signature verification. A fixture only drops to a hand-built signed
// fetch-seam when the frozen handler makes the violation otherwise unreachable
// (the row cap and the extra write route), and even then the seam verifies the
// signature exactly like a real connector and delegates every unrelated
// request to one.
//
// Base shape (mirrors `_conformance-bigbase.ts`, tuned so the positive cases'
// preconditions hold — P4/P7 need the "everyone" result set strictly under the
// 1,000-row cap):
//   * 900 deterministic rows, `signupAt` strictly increasing with insertion;
//   * `attr.plan` — filter-only (~20% "pro"); `attr.tier` — returnable;
//   * two columns present in the row data but absent from `fieldMapping` and
//     from the declared `/schema` columns: `internal_notes`, `secret_note`.

import { createConnector } from '../../src/index';
import type { Adapter } from '../../src/types';
import { memAdapter, type MemRow } from '../_mem-adapter';
import {
  createConformanceClient,
  type ConformanceClient,
} from '../../src/conformance/client';
import type { ConformanceCaseContext } from '../../src/conformance/runner';

export const SEED_SECRET = 'conformance-s5-fixture-secret';
export const SEED_URL = 'http://fixture.local/askdepth/v1';

export const SEED_FIELD_MAPPING = {
  externalId: 'user_id',
  email: 'email_addr',
  name: 'full_name',
  segment: 'segment',
  signupAt: 'signup_at',
  isActive: 'is_active',
} as const;

export const SEED_ATTRIBUTES = { filterable: ['plan', 'tier'], returnable: ['tier'] };

/** Only the mapped store columns are declared. `internal_notes` / `secret_note`
 *  exist in the row data but are deliberately NOT here. */
export const SEED_COLUMNS = [
  { name: 'user_id', type: 'text' },
  { name: 'email_addr', type: 'text' },
  { name: 'full_name', type: 'text' },
  { name: 'segment', type: 'text' },
  { name: 'signup_at', type: 'timestamptz' },
  { name: 'is_active', type: 'boolean' },
];

/** Store columns that exist in the data but are intentionally unmapped. */
export const UNMAPPED_COLUMNS = ['internal_notes', 'secret_note'] as const;

/** The runner context that hands N3 its out-of-band unmapped-column list. */
export const WITH_UNMAPPED: ConformanceCaseContext = {
  unmappedColumns: [...UNMAPPED_COLUMNS],
  filterOnlyAttributes: [],
  filterOnlyAttributeValues: {},
};

export const SEED_ROW_COUNT = 900;

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

/** `SEED_ROW_COUNT` deterministic rows. `signupAt` strictly increases with
 *  insertion order — the property N7's distribution test relies on. */
export function seedRows(count = SEED_ROW_COUNT): MemRow[] {
  const rnd = mulberry32(0x51ee_d500);
  const rows: MemRow[] = [];
  for (let i = 0; i < count; i++) {
    const r = rnd();
    rows.push({
      externalId: `seed-${String(i).padStart(4, '0')}`,
      email: `seed${i}@synthetic.example`,
      name: `Seed Synthetic ${i}`,
      segment: r < 0.5 ? 'enterprise' : 'smb',
      signupAt: new Date(Date.UTC(2021, 0, 1) + i * 3_600_000).toISOString(),
      isActive: rnd() < 0.75,
      attributes: {
        plan: rnd() < 0.2 ? 'pro' : 'basic', // filter-only
        tier: rnd() < 0.4 ? 'gold' : 'silver', // returnable
      },
      // Present in the store, absent from SEED_FIELD_MAPPING and SEED_COLUMNS.
      internal_notes: `NOTE_${i}_do_not_export`,
      secret_note: `SECRET_${i}`,
    });
  }
  return rows;
}

/** A `ConformanceClient` over an arbitrary fetch seam pointed at `SEED_URL`. */
export function seamClient(fetchImpl: typeof fetch): ConformanceClient {
  return createConformanceClient({ url: SEED_URL, secret: SEED_SECRET, fetchImpl });
}

/** A `fetch` seam backed by a genuine in-process `createConnector` over the
 *  given adapter. This is a real Request → Response round-trip through
 *  signature verification and the frozen handler. */
export function connectorFetch(adapter: Adapter): typeof fetch {
  const connector = createConnector({
    secret: SEED_SECRET,
    adapter,
    fieldMapping: SEED_FIELD_MAPPING,
    attributes: SEED_ATTRIBUTES,
  });
  return async (input, init) => connector.fetch(new Request(String(input), init as RequestInit));
}

/** A genuine, fully-correct connector over the seeded base — the reference the
 *  broken fixtures are compared against. */
export function referenceClient(): ConformanceClient {
  return seamClient(connectorFetch(memAdapter(seedRows(), { columns: SEED_COLUMNS })));
}

/** Correct connector whose `/schema` DOES list an unmapped store column
 *  (`internal_notes`) — a legitimate postgres-style introspection. Its search
 *  rows still never carry it. Used by the N3 regression test for part (A). */
export function referenceClientSchemaListsUnmapped(): ConformanceClient {
  const columns = [...SEED_COLUMNS, { name: 'internal_notes', type: 'text' }];
  return seamClient(connectorFetch(memAdapter(seedRows(), { columns })));
}
