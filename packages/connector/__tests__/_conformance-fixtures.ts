// Test-only fixtures for the S2 positive conformance cases.
//
// Not a `*.test.ts` file, so vitest does not collect it. Lives under
// `__tests__/` on purpose — no conformance fixture is allowed under `src/`.
//
// Provides:
//   * a seeded synthetic user base (deterministic, 40 rows);
//   * `correctClient()` — a `ConformanceClient` wired straight into a real
//     in-process `createConnector` over a Web-standard `fetch` seam (no HTTP
//     server, but a genuine Request → Response round-trip through signature
//     verification and the frozen handler);
//   * `brokenClient(bug)` — the same connector with an adapter that commits
//     exactly one violation, for the "the suite actually catches it" tests;
//   * `brokenHealthClient()` — a minimal signed stub that answers `/health`
//     with a body missing a required field (the one P1 failure a real
//     connector's frozen `healthBody()` cannot be made to produce).

import { verify } from '@askdepth/audience-contract';
import { createConnector } from '../src/index';
import { ConnectorError } from '../src/errors';
import type { Adapter } from '../src/types';
import type { QueryPlan } from '../src/plan';
import {
  createConformanceClient,
  type ConformanceClient,
} from '../src/conformance/client';
import { memAdapter, type MemRow } from './_mem-adapter';

export const FIXTURE_SECRET = 'conformance-s2-fixture-secret';

const BASE_URL = 'http://connector.fixture/askdepth/v1';

export const FIXTURE_FIELD_MAPPING = {
  externalId: 'user_id',
  email: 'email_addr',
  name: 'full_name',
  segment: 'segment',
  signupAt: 'signup_at',
  isActive: 'is_active',
} as const;

const FIXTURE_ATTRIBUTES = { filterable: ['plan', 'tier'], returnable: ['tier'] };

const FIXTURE_COLUMNS = [
  { name: 'user_id', type: 'text' },
  { name: 'email_addr', type: 'text' },
  { name: 'full_name', type: 'text' },
  { name: 'segment', type: 'text' },
  { name: 'signup_at', type: 'timestamptz' },
  { name: 'is_active', type: 'boolean' },
];

/** 40 deterministic synthetic candidates. 8 are on `plan == "pro"`. */
export function syntheticUsers(count = 40): MemRow[] {
  const rows: MemRow[] = [];
  for (let i = 1; i <= count; i++) {
    rows.push({
      externalId: `ext-${String(i).padStart(4, '0')}`,
      email: `user${i}@synthetic.example`,
      name: `Synthetic User ${i}`,
      segment: i % 2 === 0 ? 'enterprise' : 'smb',
      signupAt: new Date(Date.UTC(2023, 0, i)).toISOString(),
      isActive: i % 4 !== 0,
      attributes: {
        tier: i <= 20 ? 'gold' : 'silver',
        plan: i % 5 === 0 ? 'pro' : 'basic',
      },
    });
  }
  return rows;
}

function connectorClient(adapter: Adapter): ConformanceClient {
  const connector = createConnector({
    secret: FIXTURE_SECRET,
    adapter,
    fieldMapping: FIXTURE_FIELD_MAPPING,
    attributes: FIXTURE_ATTRIBUTES,
  });

  // A Web-standard handler stub: turn the client's `fetch(url, init)` into a
  // real `Request` and hand it to the connector. No connector internals are
  // imported by the cases themselves — they only ever see `ConformanceClient`.
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as unknown as string, init as RequestInit);
    return connector.fetch(req);
  };

  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

/** A correctly-behaving in-process P2 connector over the synthetic base. */
export function correctClient(): ConformanceClient {
  return connectorClient(memAdapter(syntheticUsers(), { columns: FIXTURE_COLUMNS }));
}

/**
 * A correct connector that declares NO returnable attributes — `plan` and
 * `tier` stay filter-only, so no row ever carries an `attributes` payload.
 * Used to exercise P6's honest-limitation branch (no-flag mode, nothing to
 * filter on).
 */
export function correctClientNoReturnable(): ConformanceClient {
  const connector = createConnector({
    secret: FIXTURE_SECRET,
    adapter: memAdapter(syntheticUsers(), { columns: FIXTURE_COLUMNS }),
    fieldMapping: FIXTURE_FIELD_MAPPING,
    attributes: { filterable: ['plan', 'tier'], returnable: [] },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input as unknown as string, init as RequestInit);
    return connector.fetch(req);
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

export type Bug =
  | 'emptySchema' // P2: /schema returns { columns: [] }
  | 'negativeCount' // P3: count returns -1
  | 'noCursor' // P4: search never returns nextCursor
  | 'ignoreExternalIdIn' // P5: externalId IN filter is dropped
  | 'leakFilterAttribute' // P6: filter-only attribute echoed into every row
  | 'ignoreAttrFilter' // P6: every attr.* filter is dropped (full set returned)
  | 'rejectAttrFilter' // P6: any attr.* clause is answered with malformed_request
  | 'ignoreSuppress'; // P7: suppressExternalIds is ignored

function withoutExternalIdFilter(plan: QueryPlan): QueryPlan {
  return { ...plan, filters: plan.filters.filter((f) => f.canonical !== 'externalId') };
}

function withoutAttributeFilters(plan: QueryPlan): QueryPlan {
  return { ...plan, filters: plan.filters.filter((f) => !f.isAttribute) };
}

function hasAttributeFilter(plan: QueryPlan): boolean {
  return plan.filters.some((f) => f.isAttribute);
}

/** The synthetic connector with exactly one violation wired in. */
export function brokenClient(bug: Bug): ConformanceClient {
  const base = memAdapter(syntheticUsers(), { columns: FIXTURE_COLUMNS });

  const broken: Adapter = {
    ...base,
    async schema(ctx) {
      const real = await base.schema(ctx);
      return bug === 'emptySchema' ? { columns: [] } : real;
    },
    async count(plan, ctx) {
      if (bug === 'rejectAttrFilter' && hasAttributeFilter(plan)) {
        throw new ConnectorError('malformed_request');
      }
      const p =
        bug === 'ignoreExternalIdIn'
          ? withoutExternalIdFilter(plan)
          : bug === 'ignoreAttrFilter'
            ? withoutAttributeFilters(plan)
            : bug === 'ignoreSuppress'
              ? { ...plan, suppress: [] }
              : plan;
      const real = await base.count(p, ctx);
      return bug === 'negativeCount' ? -1 : real;
    },
    async search(plan, ctx) {
      if (bug === 'rejectAttrFilter' && hasAttributeFilter(plan)) {
        throw new ConnectorError('malformed_request');
      }
      const p =
        bug === 'ignoreExternalIdIn'
          ? withoutExternalIdFilter(plan)
          : bug === 'ignoreAttrFilter'
            ? withoutAttributeFilters(plan)
            : bug === 'ignoreSuppress'
              ? { ...plan, suppress: [] }
              : plan;
      const real = await base.search(p, ctx);

      if (bug === 'noCursor') return { rows: real.rows };
      if (bug === 'leakFilterAttribute') {
        return {
          ...real,
          rows: real.rows.map((r) => ({
            ...r,
            attributes: { ...(r.attributes ?? {}), plan: 'LEAKED' },
          })),
        };
      }
      return real;
    },
  };

  return connectorClient(broken);
}

/**
 * P1's broken counterpart. The frozen `healthBody()` always builds a valid
 * `HealthResponseSchema`, so the only way to get an invalid `/health` body is
 * a stub connector: this one verifies the signature like a real connector,
 * then answers `/health` without the required `capabilities` field.
 */
export function brokenHealthClient(): ConformanceClient {
  const secret = Buffer.from(FIXTURE_SECRET, 'utf8');
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const ts = headers.get('x-askdepth-timestamp') ?? '';
    const sig = headers.get('x-askdepth-signature') ?? '';
    const jsonHeaders = { 'content-type': 'application/json' };

    if (!verify('', ts, sig, secret).valid) {
      return new Response(JSON.stringify({ error: { code: 'unsigned' } }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    if (url.pathname.endsWith('/health')) {
      // Missing `capabilities` — fails HealthResponseSchema.
      return new Response(JSON.stringify({ ok: true, contractVersion: '1.0.0' }), {
        status: 200,
        headers: jsonHeaders,
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: jsonHeaders,
    });
  };

  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}
