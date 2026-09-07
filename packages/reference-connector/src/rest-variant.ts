// The Askdepth reference connector — rest variant (spec §S8).
//
// The SAME seeded synthetic user base as the Postgres variant (the S6 seed,
// `generateRows()`, 5,000 rows) and the SAME canonical field mapping, served
// through the frozen `restAdapter` instead of `postgresAdapter`. Running the
// full 15-case conformance suite against both and getting the same 15 results
// is the proof that the reference connector is not secretly Postgres-shaped —
// its behaviour is a property of the SDK + the mapping, not of one backend.
//
// It consumes the **built public** `@askdepth/audience-connector` exactly as a
// third-party integrator would: `createConnector` + `restAdapter` from the
// package root, `expressHandler` from the `/express` subpath. Nothing here
// reaches into `@askdepth/audience-connector/src/*`, and there is no code path
// that exists only to satisfy the platform's integration tests.
//
// `fetchCandidates` / `fetchCount` are the integrator's glue: they translate a
// planned, whitelisted query into a call to the client's own backend — here the
// in-memory `rest-fixture-api`. See that file's header for exactly which
// guarantees the adapter enforces and which the backend must uphold.
//
// ── Environment ───────────────────────────────────────────────────────────
//   REFERENCE_SECRET   required — HMAC signing secret. No insecure default.
//   FIXTURE_API_URL    optional — point at an already-running fixture backend.
//                      When unset, `start()` boots one in-process on loopback.
//   PORT               listen port (default 8788 — distinct from the pg
//                      variant's 8787 so both can run at once).
//
// ── Run ───────────────────────────────────────────────────────────────────
//   REFERENCE_SECRET=… pnpm --filter @askdepth/reference-connector start:rest
// prints `listening on :<port>` once the HTTP listener is up.

import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import express from 'express';
import {
  createConnector,
  restAdapter,
  type RestQuery,
  type RestFetchContext,
  type CanonicalRow,
  type SchemaResponse,
  type CapabilityFlag,
} from '@askdepth/audience-connector';
import { expressHandler } from '@askdepth/audience-connector/express';
import { fieldMapping, attributes } from '../seed/generate';
import { startFixtureApi, type FixtureFilter, type StartedFixtureApi } from './rest-fixture-api';

/** Handle returned by {@link start} — identical contract to the pg variant. */
export interface StartedVariant {
  readonly url: string;
  readonly port: number;
  readonly secret: string;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Override the listen port. `0` binds an ephemeral port. Defaults to `PORT` env or 8788. */
  port?: number;
  /** Use an already-running fixture backend instead of booting one in-process. */
  fixtureApiUrl?: string;
}

/**
 * Hand-declared schema, returned verbatim from `GET /schema` (P2). Hand-written
 * on purpose — that is the point of the rest adapter, which cannot introspect a
 * client's store. The COLUMN-NAME SET is field-for-field identical to what the
 * Postgres variant introspects from `information_schema` over the same seed
 * (all 10 physical columns of `reference_users`); only the `type` strings
 * differ (declared here vs. `data_type` from the catalog), which the S8
 * cross-check test explicitly allows. Key order is preserved by the adapter.
 */
export const declaredSchema: SchemaResponse = {
  columns: [
    { name: 'external_id', type: 'text' },
    { name: 'email', type: 'text' },
    { name: 'signup_at', type: 'timestamptz' },
    { name: 'segment', type: 'text' },
    { name: 'is_active', type: 'boolean' },
    { name: 'plan', type: 'text' },
    { name: 'country', type: 'text' },
    { name: 'deviceType', type: 'text' },
    { name: 'internal_notes', type: 'text' },
    { name: 'crm_account_id', type: 'text' },
  ],
};

/** Same set the postgres adapter advertises — the mapping, not the backend,
 *  decides what the connector can serve. `restAdapter` always adds
 *  `declaredSchema` on top. */
const CAPABILITIES: CapabilityFlag[] = [
  'externalIdIn',
  'attributeFilters',
  'dateRanges',
  'randomSample',
];

function requiredSecret(): string {
  const secret = process.env.REFERENCE_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error(
      'reference-connector (rest): REFERENCE_SECRET is required and has no insecure default — ' +
        'export REFERENCE_SECRET before starting the variant.',
    );
  }
  return secret;
}

/** `RestQuery.filters` → the fixture backend's clause shape. */
function toFixtureFilters(query: RestQuery): FixtureFilter[] {
  return query.filters.map((f) => ({
    column: f.column,
    kind: f.kind,
    values: f.values,
    from: f.from,
    to: f.to,
    value: f.value,
  }));
}

/** One store row (all backend columns) → a canonical row, keyed only by the
 *  planned `select`. The adapter still strips + validates on top of this. */
function toCanonicalRow(store: Record<string, unknown>, select: RestQuery['select']): CanonicalRow {
  const columnFor = (canonical: string): string | undefined =>
    select.find((s) => s.canonical === canonical)?.column;

  const extIdCol = columnFor('externalId') ?? 'external_id';
  const emailCol = columnFor('email') ?? 'email';

  const row: CanonicalRow = {
    externalId: String(store[extIdCol]),
    email: String(store[emailCol] ?? ''),
  };

  for (const s of select) {
    if (s.canonical === 'externalId' || s.canonical === 'email') continue;
    const value = store[s.column];
    if (value === undefined || value === null) continue;
    if (s.canonical.startsWith('attr.')) {
      const name = s.canonical.slice('attr.'.length);
      row.attributes = { ...(row.attributes ?? {}), [name]: value };
    } else {
      (row as unknown as Record<string, unknown>)[s.canonical] = value;
    }
  }
  return row;
}

async function postJson(
  url: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    // Deliberately terse — no backend body echoed. The adapter wraps whatever
    // we throw as `adapter_error` and the detail never reaches the wire, but
    // there is no reason to carry payload this far in the first place.
    throw new Error(`fixture backend ${url} → HTTP ${res.status}`);
  }
  return res.json();
}

/**
 * Boot the rest variant. Resolves once its HTTP listener is accepting
 * connections. When `fixtureApiUrl` is not supplied, an in-process fixture
 * backend is started on loopback and torn down by `close()`.
 */
export async function start(opts: StartOptions = {}): Promise<StartedVariant> {
  const secret = requiredSecret();
  const port = opts.port ?? Number(process.env.PORT ?? 8788);

  const externalFixture = opts.fixtureApiUrl ?? process.env.FIXTURE_API_URL;
  let ownedFixture: StartedFixtureApi | undefined;
  const fixtureUrl = externalFixture ?? (ownedFixture = await startFixtureApi()).url;

  const fetchCandidates = async (
    query: RestQuery,
    ctx: RestFetchContext,
  ): Promise<{ rows: CanonicalRow[]; nextCursor?: string }> => {
    const payload = {
      filters: toFixtureFilters(query),
      suppress: query.suppress,
      seed: query.seed,
      cursor: query.cursor,
      limit: query.limit,
      sample: query.sample,
    };
    const body = (await postJson(`${fixtureUrl}/query`, payload, ctx.signal)) as {
      rows?: unknown;
      nextCursor?: unknown;
    };
    const rawRows = Array.isArray(body.rows) ? body.rows : [];
    const rows = rawRows.map((r) => toCanonicalRow(r as Record<string, unknown>, query.select));
    const nextCursor = typeof body.nextCursor === 'string' ? body.nextCursor : undefined;
    return { rows, nextCursor };
  };

  const fetchCount = async (query: RestQuery, ctx: RestFetchContext): Promise<number> => {
    const body = (await postJson(
      `${fixtureUrl}/count`,
      { filters: toFixtureFilters(query), suppress: query.suppress },
      ctx.signal,
    )) as { count?: unknown };
    const n = Number(body.count);
    if (!Number.isFinite(n) || n < 0) throw new Error('fixture backend returned a non-count');
    return Math.trunc(n);
  };

  const connector = createConnector({
    adapter: restAdapter({
      fetchCandidates,
      fetchCount,
      declaredSchema,
      capabilities: CAPABILITIES,
    }),
    fieldMapping: { ...fieldMapping },
    attributes: {
      filterable: [...attributes.filterable],
      returnable: [...attributes.returnable],
    },
    secret,
  });

  const app = express();
  // No body parser: the Express shim needs the exact signed bytes.
  app.use(expressHandler(connector));

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, () => resolve(s));
    s.once('error', reject);
  });

  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
  const url = `http://localhost:${boundPort}/askdepth/v1`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (ownedFixture) await ownedFixture.close();
  };

  return { url, port: boundPort, secret, close };
}

function isMain(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
}

if (isMain()) {
  start().then(
    (variant) => {
      // The exact line CI (and the demo script) waits for.
      // eslint-disable-next-line no-console
      console.log(`listening on :${variant.port}`);
      // eslint-disable-next-line no-console
      console.log(`conformance url: ${variant.url}`);
    },
    (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
