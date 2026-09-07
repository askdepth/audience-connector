// Deliberately-broken fixture — breaks N3 ONLY ("returns unmapped columns").
//
// A genuine `createConnector`, but its adapter ignores the plan's `select` and
// splices an unmapped store column (`internal_notes`) back onto every search
// row — the shape a raw `SELECT *` produces. `count` and pagination are
// untouched, so every other case still passes. (`CanonicalFieldSchema` strips
// unknown keys, so the positive row-shape checks are unaffected; N3 reads the
// raw JSON body, which still carries the leak.)

import type { Adapter, CanonicalRow } from '../../../src/types';
import type { QueryPlan } from '../../../src/plan';
import { memAdapter, type MemRow } from '../../_mem-adapter';
import { connectorFetch, seamClient, seedRows, SEED_COLUMNS } from '../_seed';
import type { ConformanceClient } from '../../../src/conformance/client';

const LEAKED_COLUMN = 'internal_notes';

export function createLeakyColumnsClient(): ConformanceClient {
  const source = seedRows();
  const notesById = new Map(source.map((r) => [r.externalId, (r as MemRow)[LEAKED_COLUMN]]));
  const base = memAdapter(source, { columns: SEED_COLUMNS });

  const adapter: Adapter = {
    ...base,
    async search(plan: QueryPlan, ctx) {
      const real = await base.search(plan, ctx);
      return {
        ...real,
        rows: real.rows.map((row) => ({
          ...row,
          [LEAKED_COLUMN]: notesById.get(row.externalId) ?? `NOTE_${row.externalId}`,
        })) as CanonicalRow[],
      };
    },
  };

  return seamClient(connectorFetch(adapter));
}
