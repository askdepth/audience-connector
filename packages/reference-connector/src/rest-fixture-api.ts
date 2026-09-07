// The Askdepth reference connector — rest variant's *fixture backend* (spec §S8).
//
// This is NOT part of the SDK. It stands in for "the client's own backend" —
// the system a real `restAdapter` integrator would put behind their
// `fetchCandidates`. It holds the S6 seed (`generateRows()`, 5,000 rows) in
// memory and serves it as a plain JSON API over real HTTP loopback. The rest
// variant's connector talks to it exactly as it would talk to a third party.
//
// ── Division of responsibility ────────────────────────────────────────────
// The frozen `restAdapter` (packages/connector/src/adapters/rest.ts) already
// ENFORCES, on whatever this API returns:
//   * the 1,000-row response cap (it truncates `rows` to `min(limit, 1000)`);
//   * column projection — it strips every key that is not a mapped canonical
//     field / returnable attribute, so `internal_notes` / `crm_account_id`
//     cannot leak even though this API serves full store rows (N3);
//   * canonical-row validation (`CanonicalFieldSchema`) — one bad row aborts;
//   * the query-bound cursor envelope — it re-wraps our opaque page token in
//     `encodeCursor({ k }, queryHash, seed)` so a token cannot be replayed
//     against a different query.
// We must therefore NOT re-implement any of the above. What the adapter
// DELEGATES to this API, and this API alone upholds:
//   * filtering (`segment`/`signupAt`/`isActive`/`externalId` DSL + `attr.*`)
//     and `suppressExternalIds` — the adapter passes clauses through untouched;
//   * a STABLE TOTAL ORDER and a deterministic opaque cursor, so paging is
//     repeatable — no repeats, no gaps, same cursor ⇒ same bytes (N5);
//   * an EXACT count (the adapter's derived count deliberately fails at or above
//     the cap, so the rest variant wires `fetchCount` straight to `POST /count`)
//     —
//     never a capped number (N6 / P3 / P5 / P7);
//   * a GENUINE uniform random subsample when `sample` is set — the adapter
//     does no sampling of its own, it trusts the advertisement. The RNG is
//     seeded per pull from `seed`, so it is a real sample rather than insertion
//     order, and different pulls draw independently (N7).
//
// Ordering key: `md5(seed || "|" || external_id)` — the fixture backend's OWN
// deterministic ordering key. It is deliberately not required to match, and does
// not match, the postgres adapter's internal key (`md5(seedParam || extIdCol`
// `::text)`, no `"|"` separator): the two produce a different row order for the
// same seed. That is fine. The conformance guarantee is "same seed, same
// mapping, same 15 verdicts", not identical row order, and a cursor is never
// shared between the two variants. What this key MUST be — and is — is
// uncorrelated with signup order (so "first N" is a fair sample) yet fully
// deterministic for a fixed seed (so pagination is stable).

import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { generateRows, columns, type ReferenceUserRow } from '../seed/generate';

/** One AND-clause, already resolved to a store column by the connector's planner. */
export interface FixtureFilter {
  /** Store column, e.g. `segment`, `signup_at`, `is_active`, `external_id`, `plan`. */
  column: string;
  kind: 'in' | 'between' | 'eq';
  values?: readonly unknown[];
  from?: string;
  to?: string;
  value?: unknown;
}

export interface FixtureQueryBody {
  filters?: FixtureFilter[];
  suppress?: string[];
  /** Per-pull deterministic seed, carried across pages by the adapter's cursor. */
  seed: string;
  /** Our own opaque page token from a previous `POST /query`. */
  cursor?: string;
  /** Page-size ceiling (already clamped to ≤ 1,000 by the adapter/handler). */
  limit?: number;
  /** Present ⇒ return a uniform random subsample of `size`, no pagination. */
  sample?: { method: 'random'; size: number };
}

export interface StartedFixtureApi {
  /** Base URL, e.g. `http://127.0.0.1:49812`. No trailing slash. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartFixtureApiOptions {
  /** Listen port. `0` (default) binds an ephemeral port. Falls back to `FIXTURE_PORT`. */
  port?: number;
  /** Seed override — defaults to the S6 canonical seed. */
  seed?: number;
}

// ── Query engine (pure) ───────────────────────────────────────────────────

function matchesFilters(row: ReferenceUserRow, filters: readonly FixtureFilter[]): boolean {
  for (const f of filters) {
    const actual = (row as unknown as Record<string, unknown>)[f.column];
    if (f.kind === 'in') {
      if (!(f.values ?? []).some((v) => v === actual)) return false;
    } else if (f.kind === 'eq') {
      if (actual !== f.value) return false;
    } else {
      // between — ISO-8601 strings compare lexically (S6 `signup_at` is ISO).
      if (typeof actual !== 'string' || actual < (f.from ?? '') || actual > (f.to ?? '')) {
        return false;
      }
    }
  }
  return true;
}

/** Stable, well-distributed order key for a row under one pull's seed. */
function orderKey(seed: string, externalId: string): string {
  return createHash('md5').update(`${seed}|${externalId}`).digest('hex');
}

interface CursorPos {
  h: string;
  id: string;
}

function encodeToken(pos: CursorPos): string {
  return Buffer.from(JSON.stringify(pos), 'utf8').toString('base64url');
}

function decodeToken(token: string): CursorPos | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as CursorPos).h === 'string' &&
      typeof (parsed as CursorPos).id === 'string'
    ) {
      return parsed as CursorPos;
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

interface Keyed {
  row: ReferenceUserRow;
  key: string;
}

function orderedPopulation(
  rows: readonly ReferenceUserRow[],
  body: FixtureQueryBody,
): Keyed[] {
  const suppressed = new Set(body.suppress ?? []);
  const filters = body.filters ?? [];
  return rows
    .filter((r) => !suppressed.has(r.external_id) && matchesFilters(r, filters))
    .map((row) => ({ row, key: orderKey(body.seed, row.external_id) }))
    .sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : a.row.external_id < b.row.external_id ? -1 : a.row.external_id > b.row.external_id ? 1 : 0,
    );
}

export function runQuery(
  rows: readonly ReferenceUserRow[],
  body: FixtureQueryBody,
): { rows: ReferenceUserRow[]; nextCursor?: string } {
  const ordered = orderedPopulation(rows, body);

  // Sample: a genuine uniform random subsample. The order key is seeded per
  // pull and uncorrelated with insertion order, so the first `size` of the
  // shuffled population IS a fair draw. One-shot — no cursor.
  if (body.sample) {
    const size = Math.max(0, Math.trunc(body.sample.size));
    return { rows: ordered.slice(0, size).map((x) => x.row) };
  }

  const limit = Math.max(0, Math.trunc(body.limit ?? ordered.length));

  let start = 0;
  if (body.cursor !== undefined) {
    const pos = decodeToken(body.cursor);
    if (!pos) {
      // An unreadable token yields an empty tail rather than a silent restart —
      // the connector never sends us one it did not get from us.
      return { rows: [] };
    }
    start = ordered.findIndex(
      (x) => x.key > pos.h || (x.key === pos.h && x.row.external_id > pos.id),
    );
    if (start < 0) start = ordered.length;
  }

  const slice = ordered.slice(start, start + limit);
  const hasMore = start + limit < ordered.length;
  const last = slice[slice.length - 1];
  const nextCursor =
    hasMore && last ? encodeToken({ h: last.key, id: last.row.external_id }) : undefined;

  return { rows: slice.map((x) => x.row), nextCursor };
}

export function runCount(
  rows: readonly ReferenceUserRow[],
  body: Pick<FixtureQueryBody, 'filters' | 'suppress'>,
): number {
  const suppressed = new Set(body.suppress ?? []);
  const filters = body.filters ?? [];
  return rows.filter((r) => !suppressed.has(r.external_id) && matchesFilters(r, filters)).length;
}

// ── HTTP surface ──────────────────────────────────────────────────────────

/**
 * Boot the in-memory fixture backend. Resolves once it is accepting
 * connections. The caller owns the handle and must `close()` it.
 */
export async function startFixtureApi(
  opts: StartFixtureApiOptions = {},
): Promise<StartedFixtureApi> {
  const rows = generateRows(opts.seed);
  const port = opts.port ?? Number(process.env.FIXTURE_PORT ?? 0);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, rows: rows.length, columns: [...columns] });
  });

  app.post('/query', (req, res) => {
    const body = req.body as FixtureQueryBody;
    if (!body || typeof body.seed !== 'string' || body.seed === '') {
      res.status(400).json({ error: 'seed (string) is required' });
      return;
    }
    res.json(runQuery(rows, body));
  });

  app.post('/count', (req, res) => {
    const body = (req.body ?? {}) as Pick<FixtureQueryBody, 'filters' | 'suppress'>;
    res.json({ count: runCount(rows, body) });
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });

  const boundPort = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${boundPort}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { url, port: boundPort, close };
}
