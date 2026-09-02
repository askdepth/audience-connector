// The wire DSL compiled into an adapter-agnostic query plan, plus the cursor
// machinery.
//
// Two design problems live here.
//
// 1. **Whitelist enforcement is the planner's job, not the adapter's.** A
//    criterion naming a field absent from `config.fieldMapping`, or an
//    `attr.*` not in `config.attributes.filterable`, is rejected here with
//    `malformed_request` before any adapter sees it. Adapters therefore only
//    ever receive resolved, whitelisted columns — which is what makes
//    "no SELECT *" a property of the type rather than a review convention.
//
// 2. **Random subsample vs deterministic pagination.** `ORDER BY random()`
//    satisfies the first and destroys the second. The resolution is a *seeded*
//    deterministic shuffle: a crypto-random `seed` is generated once per pull
//    (a request with no cursor), the rows are ordered by a deterministic hash
//    of `(seed, externalId)`, and the seed is carried in the cursor so every
//    later page reuses it. The order is then stable across pages while being
//    uncorrelated with insertion order — so "take the first N by cursor" is no
//    longer "take the oldest N users" (master §4.5).
//
// Cursors are **not** signed or encrypted: they carry no secret, and the whole
// request is already HMAC-signed. A second signature here would be redundant.
// Do not add one.

import type { Query } from '@askdepth/audience-contract';
import { ConnectorError } from './errors';
import type { FieldMapping } from './types';

export const ROW_CAP = 1_000;
const CURSOR_VERSION = 1;

// Canonical fields that are always retrieved: `externalId` is the unique sort
// key the whole cursor scheme depends on; `email` is the minimum useful
// identity for a recruited candidate.
const ALWAYS_SELECTED = ['externalId', 'email'] as const;

/** A canonical field resolved to the client's own column/key. */
export interface MappedColumn {
  canonical: string;
  column: string;
}

export type FilterKind = 'in' | 'between' | 'eq';

/** One AND-clause, already resolved to a source column. */
export interface PlannedFilter {
  /** `segment` | `signupAt` | `isActive` | `externalId` | `attr.<name>` */
  canonical: string;
  /** The client's source column/key for `canonical`. */
  column: string;
  kind: FilterKind;
  /** `in` */
  values?: readonly unknown[];
  /** `between` (ISO-8601 strings) */
  from?: string;
  to?: string;
  /** `eq` */
  value?: unknown;
  isAttribute: boolean;
}

/**
 * Adapter-specific position marker carried in the cursor. The postgres adapter
 * uses `{ h, id }` (shuffle hash + externalId of the last row for keyset
 * pagination); the rest adapter uses `{ k }` (the client backend's own opaque
 * page token). Each adapter reads only its own fields.
 */
export interface CursorState {
  h?: string;
  id?: string;
  k?: string;
}

export interface QueryPlan {
  /** Mapped columns to retrieve. Never contains an unmapped column. */
  select: MappedColumn[];
  filters: PlannedFilter[];
  /** externalIds to exclude (master §4.4). */
  suppress: string[];
  sample?: { method: 'random'; size: number };
  /** Deterministic shuffle seed. Stable across the pages of one pull. */
  seed: string;
  /** The client's source column for `externalId` — the adapters' sort key. */
  externalIdColumn: string;
  /** Present for search, absent for count. Already clamped to {@link ROW_CAP}. */
  limit?: number;
  /** Keyset position, when paginating. */
  after?: CursorState;
  /** Hash binding this plan to any cursor issued from it. */
  queryHash: string;
}

export interface BuildPlanInput {
  criteria: Query;
  /** The mapping proposed in the request body: sourceColumn → canonicalField.
   *  Advisory — it selects which canonical fields to return; column resolution
   *  always goes through `config.fieldMapping`. */
  requestMapping: Record<string, string>;
  fieldMapping: FieldMapping;
  filterableAttributes: readonly string[];
  returnableAttributes: readonly string[];
  /** search only */
  limit?: number;
  cursor?: string;
  sample?: { method: 'random'; size: number };
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

const DSL_FIELDS = new Set(['segment', 'signupAt', 'isActive', 'externalId']);

function resolveColumn(fieldMapping: FieldMapping, canonical: string): string {
  const col = (fieldMapping as Record<string, string | undefined>)[canonical];
  if (!col) throw new ConnectorError('malformed_request');
  return col;
}

function planFilters(
  criteria: Query,
  fieldMapping: FieldMapping,
  filterableAttributes: readonly string[],
): PlannedFilter[] {
  const filterable = new Set(filterableAttributes);
  const filters: PlannedFilter[] = [];

  for (const c of criteria.all) {
    const field = c.field;

    if (field.startsWith('attr.')) {
      const attrName = field.slice('attr.'.length);
      if (!filterable.has(attrName)) throw new ConnectorError('malformed_request');
      const op = (c as { op: string }).op;
      if (op === 'in') {
        const values = (c as { values?: unknown[] }).values;
        if (!Array.isArray(values) || values.length === 0) {
          throw new ConnectorError('malformed_request');
        }
        filters.push({ canonical: field, column: attrName, kind: 'in', values, isAttribute: true });
      } else if (op === 'eq') {
        const value = (c as { value?: unknown }).value;
        if (value === undefined) throw new ConnectorError('malformed_request');
        filters.push({ canonical: field, column: attrName, kind: 'eq', value, isAttribute: true });
      } else {
        throw new ConnectorError('malformed_request');
      }
      continue;
    }

    if (!DSL_FIELDS.has(field)) throw new ConnectorError('malformed_request');
    const column = resolveColumn(fieldMapping, field);

    // The contract's zod schema already guarantees these shapes on the request
    // path; the re-checks here keep `buildPlan` safe when it is called directly
    // (it is exported) — a bad shape is `malformed_request`, never a TypeError.
    switch (field) {
      case 'segment':
      case 'externalId': {
        const values = (c as { values?: unknown }).values;
        if (!Array.isArray(values) || values.length === 0) {
          throw new ConnectorError('malformed_request');
        }
        filters.push({ canonical: field, column, kind: 'in', values, isAttribute: false });
        break;
      }
      case 'signupAt': {
        const { from, to } = c as { from?: unknown; to?: unknown };
        if (typeof from !== 'string' || typeof to !== 'string') {
          throw new ConnectorError('malformed_request');
        }
        filters.push({ canonical: field, column, kind: 'between', from, to, isAttribute: false });
        break;
      }
      case 'isActive': {
        const value = (c as { value?: unknown }).value;
        if (typeof value !== 'boolean') throw new ConnectorError('malformed_request');
        filters.push({ canonical: field, column, kind: 'eq', value, isAttribute: false });
        break;
      }
    }
  }
  return filters;
}

function planSelect(
  input: BuildPlanInput,
): { select: MappedColumn[]; externalIdColumn: string } {
  const { fieldMapping, requestMapping, returnableAttributes } = input;
  const externalIdColumn = resolveColumn(fieldMapping, 'externalId');

  const wanted = new Set<string>(ALWAYS_SELECTED);
  for (const canonical of Object.values(requestMapping)) {
    if (canonical.startsWith('attr.')) continue; // display attrs handled below
    wanted.add(canonical);
  }

  const select: MappedColumn[] = [];
  for (const canonical of wanted) {
    // Every requested canonical field must be one the client actually mapped.
    const column = resolveColumn(fieldMapping, canonical);
    select.push({ canonical, column });
  }

  // Attributes are filter-only *by default*; a display attribute must be
  // explicitly listed in `returnable` (master §4.3).
  for (const attrName of returnableAttributes) {
    select.push({ canonical: `attr.${attrName}`, column: attrName });
  }

  return { select, externalIdColumn };
}

export function buildPlan(input: BuildPlanInput): QueryPlan {
  const filters = planFilters(input.criteria, input.fieldMapping, input.filterableAttributes);
  const { select, externalIdColumn } = planSelect(input);
  const suppress = input.criteria.suppressExternalIds ? [...input.criteria.suppressExternalIds] : [];
  const sample = input.sample;

  if (sample && input.limit !== undefined && sample.size > input.limit) {
    // A sample larger than the page it must fit into is incoherent.
    throw new ConnectorError('malformed_request');
  }

  const queryHash = computeQueryHash({ select, filters, suppress, sampleSize: sample?.size });

  let seed: string;
  let after: CursorState | undefined;
  if (input.cursor !== undefined) {
    const decoded = decodeCursor(input.cursor);
    if (decoded.qh !== queryHash) throw new ConnectorError('invalid_cursor');
    seed = decoded.seed;
    after = decoded.after;
  } else {
    seed = generateSeed();
  }

  return {
    select,
    filters,
    suppress,
    sample,
    seed,
    externalIdColumn,
    limit: input.limit === undefined ? undefined : Math.min(input.limit, ROW_CAP),
    after,
    queryHash,
  };
}

// ---------------------------------------------------------------------------
// Deterministic seed + shuffle hash (Web-standard crypto only — no node:*)
// ---------------------------------------------------------------------------

/** 16 crypto-random bytes as hex. One per pull. */
export function generateSeed(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const U64 = 0xffffffffffffffffn;

/** 64-bit FNV-1a over the UTF-16 code units of `str`. */
function fnvBig(str: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash ^ BigInt(str.charCodeAt(i))) * prime) & U64;
  }
  return hash;
}

/** splitmix64 finalizer — avalanches the FNV output so that inputs sharing a
 *  long common prefix (`u_0001`, `u_0002`, ...) do not land in adjacent
 *  positions once the hashes are sorted. */
function mix64(x: bigint): bigint {
  let z = x & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}

/**
 * A well-distributed 64-bit hash as 16 zero-padded hex chars, so lexical order
 * equals numeric order. Used to bind a cursor to its query and to order rows
 * by `(seed, externalId)`. Not security-relevant — the request is already
 * signed and the cursor carries no secret.
 */
export function fnv1a64(str: string): string {
  return mix64(fnvBig(str)).toString(16).padStart(16, '0');
}

/** Stable, well-distributed sort key for a row under a given pull's seed. */
export function shuffleHash(seed: string, externalId: string): string {
  return mix64(fnvBig(seed + '|' + externalId))
    .toString(16)
    .padStart(16, '0');
}

// ---------------------------------------------------------------------------
// Query hash — normalised so key order in the criteria JSON is irrelevant
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function computeQueryHash(core: {
  select: MappedColumn[];
  filters: PlannedFilter[];
  suppress: string[];
  sampleSize: number | undefined;
}): string {
  // Normalise so the hash depends only on the *meaning* of the query, not on
  // the order the platform happened to serialise it in:
  //   - `values` in an `IN` clause are a set → sort them;
  //   - filters are sorted by a total key (canonical + kind + payload), so two
  //     filters on the same field in a different array position still match.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const normFilters = core.filters
    .map((f) => ({
      canonical: f.canonical,
      column: f.column,
      kind: f.kind,
      values: f.values ? [...f.values].map(stableStringify).sort() : undefined,
      from: f.from,
      to: f.to,
      value: f.value === undefined ? undefined : stableStringify(f.value),
    }))
    .map((f) => ({ f, key: stableStringify(f) }))
    .sort((a, b) => cmp(a.key, b.key))
    .map(({ f }) => f);

  const normalised = {
    select: [...core.select]
      .map((c) => ({ canonical: c.canonical, column: c.column }))
      .sort((a, b) => cmp(a.canonical, b.canonical) || cmp(a.column, b.column)),
    filters: normFilters,
    suppress: [...core.suppress].sort(),
    sampleSize: core.sampleSize ?? null,
  };
  return fnv1a64(stableStringify(normalised));
}

// ---------------------------------------------------------------------------
// Cursor codec — opaque base64url of { v, after, qh, seed }
// ---------------------------------------------------------------------------

interface CursorPayload {
  v: number;
  after: CursorState;
  qh: string;
  seed: string;
}

function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function encodeCursor(after: CursorState, queryHash: string, seed: string): string {
  const payload: CursorPayload = { v: CURSOR_VERSION, after, qh: queryHash, seed };
  return b64urlEncode(JSON.stringify(payload));
}

export function decodeCursor(token: string): CursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(token));
  } catch {
    throw new ConnectorError('invalid_cursor');
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    (payload as CursorPayload).v !== CURSOR_VERSION ||
    typeof (payload as CursorPayload).qh !== 'string' ||
    typeof (payload as CursorPayload).seed !== 'string'
  ) {
    throw new ConnectorError('invalid_cursor');
  }
  const after = (payload as CursorPayload).after;
  if (after === null || typeof after !== 'object') {
    throw new ConnectorError('invalid_cursor');
  }
  return payload as CursorPayload;
}
