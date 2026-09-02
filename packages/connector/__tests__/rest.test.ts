import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Query } from '@askdepth/audience-contract';
import { restAdapter, type RestQuery } from '../src/adapters/rest';
import { postgresAdapter } from '../src/adapters/postgres';
import { createConnector } from '../src/handler';
import { buildPlan, type BuildPlanInput, type QueryPlan } from '../src/plan';
import type { AdapterContext } from '../src/types';
import { signedRequest, TEST_SECRET } from './_util';

const NOW = 1_700_000_000;
const BASE = 'http://connector.test/askdepth/v1';

const fieldMapping = { externalId: 'uid', email: 'mail', segment: 'seg' } as const;
const attributes = { filterable: ['plan', 'region'], returnable: ['plan'] };
const declaredSchema = {
  columns: [
    { name: 'uid', type: 'string' },
    { name: 'mail', type: 'string' },
    { name: 'seg', type: 'string' },
  ],
};

function plan(criteria: Query, opts: Partial<BuildPlanInput> = {}): QueryPlan {
  return buildPlan({
    criteria,
    requestMapping: opts.requestMapping ?? {},
    fieldMapping,
    filterableAttributes: attributes.filterable,
    returnableAttributes: attributes.returnable,
    limit: opts.limit,
    cursor: opts.cursor,
    sample: opts.sample,
  });
}

const ctx = (signal?: AbortSignal): AdapterContext => ({
  signal: signal ?? new AbortController().signal,
  mode: 'interactive',
  budgetMs: 5_000,
});

const j = async (res: Response): Promise<any> => res.json();

function connectorWith(
  fetchCandidates: (q: RestQuery, c: { signal: AbortSignal }) => Promise<unknown>,
  extra: Record<string, unknown> = {},
) {
  return createConnector({
    secret: TEST_SECRET,
    adapter: restAdapter({ fetchCandidates: fetchCandidates as never, declaredSchema, ...extra }),
    fieldMapping,
    attributes,
    clock: () => NOW,
  });
}

function signed(path: string, body?: unknown) {
  return signedRequest(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? '' : JSON.stringify(body),
    timestamp: NOW,
  });
}

afterEach(() => vi.useRealTimers());

describe('S7.1 — schema() returns the declared schema verbatim', () => {
  it('deep and byte-identical (key order preserved)', async () => {
    const a = restAdapter({ fetchCandidates: async () => [], declaredSchema });
    const out = await a.schema(ctx());
    expect(out).toEqual(declaredSchema);
    expect(JSON.stringify(out)).toBe(JSON.stringify(declaredSchema));
    // a mutation of the returned object must not affect the stored one
    (out.columns as unknown[]).push({ name: 'x', type: 'y' });
    expect((await a.schema(ctx())).columns).toHaveLength(3);
  });
});

describe('S7.2 — keys beyond select are stripped', () => {
  it('an over-returning client cannot leak its own columns through us', async () => {
    const c = connectorWith(async () => [
      {
        externalId: 'u1',
        email: 'a@b.com',
        secret_col: 'LEAKTOP',
        attributes: { plan: 'pro', unknownAttr: 'LEAKATTR' },
      },
    ]);
    const res = await c.fetch(
      signed('/candidates/search', { criteria: { all: [] }, mapping: {}, limit: 10 }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('LEAKTOP');
    expect(text).not.toContain('LEAKATTR');
    expect(text).not.toContain('secret_col');
    const [row] = JSON.parse(text).rows;
    expect(row).toEqual({ externalId: 'u1', email: 'a@b.com', attributes: { plan: 'pro' } });
  });
});

describe('S7.3 — the 1,000-row cap is enforced by truncation', () => {
  it('5,000 rows for limit 100 → 100', async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      externalId: `u${i}`,
      email: `u${i}@x.com`,
    }));
    const a = restAdapter({ fetchCandidates: async () => many, declaredSchema });
    const { rows } = await a.search(plan({ all: [] }, { limit: 100 }), ctx());
    expect(rows).toHaveLength(100);
  });

  it('5,000 rows with no limit → capped at 1,000', async () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      externalId: `u${i}`,
      email: `u${i}@x.com`,
    }));
    const a = restAdapter({ fetchCandidates: async () => many, declaredSchema });
    const { rows } = await a.search(plan({ all: [] }), ctx());
    expect(rows).toHaveLength(1_000);
  });
});

describe('S7.4 — a malformed row aborts the pull', () => {
  it('a row missing externalId → adapter_error, no partial result', async () => {
    const a = restAdapter({
      fetchCandidates: async () => [
        { externalId: 'good', email: 'g@x.com' },
        { email: 'nope@x.com' },
      ],
      declaredSchema,
    });
    await expect(a.search(plan({ all: [] }, { limit: 10 }), ctx())).rejects.toMatchObject({
      code: 'adapter_error',
    });
  });

  it('a row with a malformed email → adapter_error', async () => {
    const a = restAdapter({
      fetchCandidates: async () => [{ externalId: 'u1', email: 'not-an-email' }],
      declaredSchema,
    });
    await expect(a.search(plan({ all: [] }, { limit: 10 }), ctx())).rejects.toMatchObject({
      code: 'adapter_error',
    });
  });
});

describe('S7.5 — a client throw becomes adapter_error with nothing leaked', () => {
  it('a Bearer token and a DSN in the thrown message do not reach the wire', async () => {
    const c = connectorWith(async () => {
      throw new Error('upstream 500: Authorization: Bearer abc123secret db=postgres://u:p@h/db');
    });
    const res = await c.fetch(
      signed('/candidates/search', { criteria: { all: [] }, mapping: {}, limit: 10 }),
    );
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('adapter_error');
    expect(text).not.toContain('abc123secret');
    expect(text).not.toContain('postgres://');
    expect(text).not.toContain('Bearer');
  });
});

describe('S7.6 — a hanging client times out and its signal is aborted', () => {
  it('the AbortSignal handed to the client function is aborted', async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const c = connectorWith(
      (_q, fctx) =>
        new Promise((_resolve, reject) => {
          fctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted'));
          });
        }),
      {},
    );
    const p = c.fetch(
      signed('/candidates/search', { criteria: { all: [] }, mapping: {}, limit: 10 }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await j(res)).error.code).toBe('timeout');
    expect(sawAbort).toBe(true);
  });
});

describe('S7.7 — a derived count never reports a silently-capped number', () => {
  it('without fetchCount, a base larger than the cap → adapter_error', async () => {
    const many = Array.from({ length: 1_500 }, (_, i) => ({ externalId: `u${i}`, email: `u${i}@x.com` }));
    const a = restAdapter({ fetchCandidates: async () => many, declaredSchema });
    await expect(a.count(plan({ all: [] }), ctx())).rejects.toMatchObject({ code: 'adapter_error' });
  });

  it('without fetchCount, exactly ROW_CAP rows and no cursor → adapter_error (boundary)', async () => {
    const exactly = Array.from({ length: 1_000 }, (_, i) => ({ externalId: `u${i}`, email: `u${i}@x.com` }));
    const a = restAdapter({ fetchCandidates: async () => exactly, declaredSchema });
    await expect(a.count(plan({ all: [] }), ctx())).rejects.toMatchObject({ code: 'adapter_error' });
  });

  it('without fetchCount, a paged client result → adapter_error (true total unknown)', async () => {
    const a = restAdapter({
      fetchCandidates: async () => ({ rows: [{ externalId: 'u1', email: 'a@x.com' }], nextCursor: 'more' }),
      declaredSchema,
    });
    await expect(a.count(plan({ all: [] }), ctx())).rejects.toMatchObject({ code: 'adapter_error' });
  });

  it('without fetchCount, a small complete result → the exact length', async () => {
    const a = restAdapter({
      fetchCandidates: async () => [
        { externalId: 'u1', email: 'a@x.com' },
        { externalId: 'u2', email: 'b@x.com' },
      ],
      declaredSchema,
    });
    expect(await a.count(plan({ all: [] }), ctx())).toBe(2);
  });

  it('with fetchCount, the client-supplied number is returned as-is', async () => {
    const a = restAdapter({
      fetchCandidates: async () => [],
      fetchCount: async () => 91_234,
      declaredSchema,
    });
    expect(await a.count(plan({ all: [] }), ctx())).toBe(91_234);
  });
});

describe('S7.8 — declaredSchema is advertised for rest and not for postgres', () => {
  it('/health lists declaredSchema for a rest connector', async () => {
    const c = connectorWith(async () => []);
    const body = await j(await c.fetch(signed('/health')));
    expect(body.capabilities).toContain('declaredSchema');
  });

  it('/health does not list declaredSchema for a postgres connector', async () => {
    const c = createConnector({
      secret: TEST_SECRET,
      adapter: postgresAdapter({ pool: {} as never, table: 'users' }),
      fieldMapping,
      attributes,
      clock: () => NOW,
    });
    const body = await j(await c.fetch(signed('/health')));
    expect(body.capabilities).not.toContain('declaredSchema');
  });
});

describe('S7.9 — the query handed to the client is clean', () => {
  it('no secret, no raw request, no unmapped column', async () => {
    let seen: RestQuery | undefined;
    const a = restAdapter({
      fetchCandidates: async (q) => {
        seen = q;
        return [];
      },
      declaredSchema,
    });
    await a.search(
      plan(
        { all: [{ field: 'segment', op: 'in', values: ['pro'] }] },
        { requestMapping: { uid: 'externalId', mail: 'email', seg: 'segment' }, limit: 50 },
      ),
      ctx(),
    );
    expect(seen).toBeDefined();
    expect(Object.keys(seen!).sort()).toEqual(
      ['cursor', 'filters', 'limit', 'sample', 'seed', 'select', 'suppress'].sort(),
    );
    const flat = JSON.stringify(seen);
    expect(flat).not.toMatch(/secret|signature|authorization|request/i);
    const allowedCols = new Set(['uid', 'mail', 'seg', 'plan', 'region']);
    for (const s of seen!.select) expect(allowedCols.has(s.column)).toBe(true);
    for (const f of seen!.filters) expect(allowedCols.has(f.column)).toBe(true);
  });
});
