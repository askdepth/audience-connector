// The rest adapter — the escape hatch for the non-Postgres targets.
//
// The client supplies the function that talks to their system; we supply the
// contract, the validation, and the guarantees. Because we control none of the
// client's implementation, we *re-enforce* our invariants on whatever it
// returns:
//   - strip any key not in `select` (an over-returning client must not leak
//     its own unmapped columns through us);
//   - enforce the 1,000-row cap by truncation;
//   - validate every row against the canonical field schema — one bad row
//     fails the whole pull (abort over partial, master §4.6).
//
// Sampling: if the client advertises `randomSample` we cannot verify from here
// that their subsample is actually random. That is what P3's conformance
// case 7 exists for. We trust the advertisement and document the gap; we do
// not silently paper over it.

import { CanonicalFieldSchema, type CapabilityFlag } from '@askdepth/audience-contract';
import { ConnectorError } from '../errors';
import { encodeCursor, ROW_CAP, type PlannedFilter, type QueryPlan } from '../plan';
import type { Adapter, AdapterContext, CanonicalRow, SchemaResponse } from '../types';

/** The plain, already-validated view of a query handed to the client. Contains
 *  no secret, no raw HTTP request, and no unmapped column. */
export interface RestQuery {
  /** Canonical field → the client's key. Only these may be returned. */
  select: ReadonlyArray<{ canonical: string; column: string }>;
  /** AND-clauses, resolved to the client's keys. */
  filters: ReadonlyArray<PlannedFilter>;
  /** externalIds to exclude. */
  suppress: readonly string[];
  sample?: { method: 'random'; size: number };
  /** Page size ceiling (search only), already clamped to 1,000. */
  limit?: number;
  /** The client backend's own opaque page token from a previous call. */
  cursor?: string;
  /** Deterministic pull seed, if the client wants a reproducible order. */
  seed: string;
}

export interface RestFetchContext {
  signal: AbortSignal;
}

export type RestFetchResult =
  | { rows: unknown[]; nextCursor?: string }
  | unknown[];

export interface RestAdapterOptions {
  /** Returns candidate rows (canonical shape) for a query. */
  fetchCandidates: (query: RestQuery, ctx: RestFetchContext) => Promise<RestFetchResult>;
  /** Hand-declared schema, returned verbatim from `GET /schema`. */
  declaredSchema: SchemaResponse;
  /** Optional exact count. Without it, `count()` is derived from
   *  `fetchCandidates` and *fails* rather than report a capped number. */
  fetchCount?: (query: RestQuery, ctx: RestFetchContext) => Promise<number>;
  /** Capabilities the client's implementation honours, beyond `declaredSchema`
   *  (which is always advertised). Not verifiable from here — see the note
   *  above about `randomSample`. */
  capabilities?: CapabilityFlag[];
}

function toRestQuery(plan: QueryPlan): RestQuery {
  return {
    select: plan.select.map((s) => ({ canonical: s.canonical, column: s.column })),
    filters: plan.filters.map((f) => ({ ...f })),
    suppress: [...plan.suppress],
    sample: plan.sample,
    limit: plan.limit,
    cursor: plan.after?.k,
    seed: plan.seed,
  };
}

function allowedKeys(plan: QueryPlan): { top: Set<string>; attrs: Set<string> } {
  const top = new Set<string>(['externalId', 'email']);
  const attrs = new Set<string>();
  for (const s of plan.select) {
    if (s.canonical.startsWith('attr.')) attrs.add(s.canonical.slice('attr.'.length));
    else top.add(s.canonical);
  }
  return { top, attrs };
}

function strip(row: Record<string, unknown>, plan: QueryPlan): Record<string, unknown> {
  const { top, attrs } = allowedKeys(plan);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === 'attributes') continue;
    if (top.has(k)) out[k] = v;
  }
  if (attrs.size > 0 && row.attributes && typeof row.attributes === 'object') {
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row.attributes as Record<string, unknown>)) {
      if (attrs.has(k)) filtered[k] = v;
    }
    if (Object.keys(filtered).length > 0) out.attributes = filtered;
  }
  return out;
}

function validateRow(row: Record<string, unknown>): CanonicalRow {
  const parsed = CanonicalFieldSchema.safeParse(row);
  if (!parsed.success) {
    // Abort the pull — do not recruit from malformed data. The zod issues go
    // to `detail` (never the wire).
    throw new ConnectorError('adapter_error', parsed.error.issues);
  }
  return parsed.data as CanonicalRow;
}

function normaliseResult(result: RestFetchResult): { rows: unknown[]; nextCursor?: string } {
  if (Array.isArray(result)) return { rows: result };
  return { rows: result.rows ?? [], nextCursor: result.nextCursor };
}

async function callClient<T>(
  fn: (q: RestQuery, ctx: RestFetchContext) => Promise<T>,
  query: RestQuery,
  ctx: AdapterContext,
): Promise<T> {
  try {
    return await fn(query, { signal: ctx.signal });
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    // The client's error may carry a bearer token or a DSN — never rethrow it.
    throw new ConnectorError('adapter_error', err);
  }
}

export function restAdapter(opts: RestAdapterOptions): Adapter {
  const capabilities: CapabilityFlag[] = Array.from(
    new Set<CapabilityFlag>(['declaredSchema', ...(opts.capabilities ?? [])]),
  );

  return {
    kind: 'rest',
    capabilities,

    async schema(): Promise<SchemaResponse> {
      // Verbatim — a deep clone so a caller cannot mutate the stored object,
      // key order preserved.
      return structuredClone(opts.declaredSchema);
    },

    async count(plan, ctx): Promise<number> {
      const query = toRestQuery(plan);

      if (opts.fetchCount) {
        const n = await callClient(opts.fetchCount, query, ctx);
        if (!Number.isFinite(n) || n < 0) throw new ConnectorError('adapter_error');
        return Math.trunc(n);
      }

      // Derived count. If the client's own result is itself capped or paged, we
      // cannot know the true total — fail rather than return a capped number
      // that looks real. At exactly `ROW_CAP` rows with no cursor we still
      // cannot distinguish "the total is 1000" from "the client truncated at
      // 1000", so that boundary fails too.
      const { rows, nextCursor } = normaliseResult(
        await callClient(opts.fetchCandidates, query, ctx),
      );
      if (nextCursor !== undefined || rows.length >= ROW_CAP) {
        throw new ConnectorError('adapter_error');
      }
      return rows.length;
    },

    async search(plan, ctx) {
      const query = toRestQuery(plan);
      const { rows: rawRows, nextCursor: clientToken } = normaliseResult(
        await callClient(opts.fetchCandidates, query, ctx),
      );

      const limit = Math.min(plan.limit ?? ROW_CAP, ROW_CAP);
      const truncated = rawRows.slice(0, limit);

      const rows: CanonicalRow[] = truncated.map((r) => {
        if (r === null || typeof r !== 'object') {
          throw new ConnectorError('adapter_error');
        }
        return validateRow(strip(r as Record<string, unknown>, plan));
      });

      let nextCursor: string | undefined;
      if (clientToken !== undefined && rawRows.length > 0) {
        // Re-wrap the client's token in our query-bound envelope so the same
        // cursor cannot be replayed against a different query.
        nextCursor = encodeCursor({ k: String(clientToken) }, plan.queryHash, plan.seed);
      }
      return { rows, nextCursor };
    },
  };
}
