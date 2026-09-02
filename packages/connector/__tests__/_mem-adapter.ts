// An in-memory reference executor for a QueryPlan: filter → seeded shuffle →
// keyset page → project to `select`. Used to exercise the pagination and
// sampling *properties* (S5), and reused as a stand-in adapter in later
// stages. Not shipped.

import type { Adapter, AdapterContext, CanonicalRow, SchemaResponse } from '../src/types';
import { encodeCursor, shuffleHash, ROW_CAP, type QueryPlan } from '../src/plan';

export interface MemRow extends CanonicalRow {
  [k: string]: unknown;
}

function matchesFilters(row: MemRow, plan: QueryPlan): boolean {
  for (const f of plan.filters) {
    const actual = f.isAttribute
      ? (row.attributes as Record<string, unknown> | undefined)?.[f.column]
      : (row as Record<string, unknown>)[f.canonical];
    if (f.kind === 'in') {
      if (!f.values!.some((v) => v === actual)) return false;
    } else if (f.kind === 'eq') {
      if (actual !== f.value) return false;
    } else {
      // between (ISO strings compare lexically)
      if (typeof actual !== 'string' || actual < f.from! || actual > f.to!) return false;
    }
  }
  return true;
}

/** Pure: the ordered, keyset-paginated, projected page for a plan. */
export function pageInMemory(
  rows: MemRow[],
  plan: QueryPlan,
): { rows: MemRow[]; nextCursor?: string } {
  const suppressed = new Set(plan.suppress);
  const keyed = rows
    .filter((r) => !suppressed.has(r.externalId) && matchesFilters(r, plan))
    .map((r) => ({ r, key: shuffleHash(plan.seed, r.externalId) }))
    .sort((a, b) =>
      a.key < b.key
        ? -1
        : a.key > b.key
          ? 1
          : a.r.externalId < b.r.externalId
            ? -1
            : a.r.externalId > b.r.externalId
              ? 1
              : 0,
    );

  const after = plan.after as { h: string; id: string } | undefined;
  const remaining = after
    ? keyed.filter((x) => x.key > after.h || (x.key === after.h && x.r.externalId > after.id))
    : keyed;

  const limit = plan.limit ?? ROW_CAP;
  const page = remaining.slice(0, limit);
  const hasMore = remaining.length > page.length;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor(
          { h: shuffleHash(plan.seed, last.r.externalId), id: last.r.externalId },
          plan.queryHash,
          plan.seed,
        )
      : undefined;

  return { rows: page.map((x) => project(x.r, plan)), nextCursor };
}

function project(row: MemRow, plan: QueryPlan): MemRow {
  const out: MemRow = { externalId: row.externalId, email: row.email };
  for (const s of plan.select) {
    if (s.canonical === 'externalId' || s.canonical === 'email') continue;
    if (s.canonical.startsWith('attr.')) {
      const name = s.canonical.slice('attr.'.length);
      const attrs = row.attributes as Record<string, unknown> | undefined;
      if (attrs && name in attrs) {
        out.attributes = { ...(out.attributes ?? {}), [name]: attrs[name] };
      }
    } else if (s.canonical in row) {
      (out as Record<string, unknown>)[s.canonical] = (row as Record<string, unknown>)[s.canonical];
    }
  }
  return out;
}

export function memAdapter(
  rows: MemRow[],
  opts: { capabilities?: Adapter['capabilities']; columns?: SchemaResponse['columns'] } = {},
): Adapter {
  return {
    kind: 'rest',
    capabilities: opts.capabilities ?? ['externalIdIn', 'attributeFilters', 'dateRanges', 'randomSample'],
    async schema(): Promise<SchemaResponse> {
      return { columns: opts.columns ?? [{ name: 'user_id', type: 'text' }] };
    },
    async count(plan): Promise<number> {
      const suppressed = new Set(plan.suppress);
      return rows.filter((r) => !suppressed.has(r.externalId) && matchesFilters(r, plan)).length;
    },
    async search(plan, _ctx: AdapterContext) {
      return pageInMemory(rows, plan);
    },
  };
}
