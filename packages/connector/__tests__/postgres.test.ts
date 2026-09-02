import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Query } from '@askdepth/audience-contract';
import { postgresAdapter } from '../src/adapters/postgres';
import { createConnector } from '../src/handler';
import { buildPlan, decodeCursor, type BuildPlanInput, type QueryPlan } from '../src/plan';
import type { AdapterContext } from '../src/types';
import { signedRequest, TEST_SECRET } from './_util';

const DSN =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:5432/postgres';

let available = false;
try {
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 2000, max: 1 });
  await probe.query('SELECT 1');
  await probe.end();
  available = true;
} catch {
  available = false;
}

it('S6 integration tests require a Postgres (mandatory in CI)', () => {
  if (process.env.CI) expect(available).toBe(true);
});

const NOW = 1_700_000_000;
const BASE = 'http://connector.test/askdepth/v1';
const T = 'p2_s6_users';
const SLEEP_VIEW = 'p2_s6_sleep';

const fieldMapping = {
  externalId: 'user_id',
  email: 'email_addr',
  segment: 'seg',
  signupAt: 'created',
  isActive: 'active',
} as const;
const attributes = { filterable: ['plan', 'region'], returnable: ['plan'] };

// Accumulates every SQL string the adapter issues, across the whole file.
const ALL_SQL: string[] = [];

function spy(pool: Pool): Pool {
  const anyPool = pool as unknown as {
    connect: (...a: unknown[]) => unknown;
  };
  const origConnect = anyPool.connect.bind(pool);
  anyPool.connect = function (...args: unknown[]) {
    // `Pool.query()` calls `connect(callback)` internally — leave that path
    // untouched; only wrap the promise form the adapter uses.
    if (typeof args[0] === 'function') return origConnect(...args);
    return (origConnect() as Promise<{ query: (...a: unknown[]) => unknown }>).then((client) => {
      const origQuery = client.query.bind(client);
      client.query = (q: unknown, ...rest: unknown[]) => {
        const text = typeof q === 'string' ? q : (q as { text?: string } | null)?.text;
        if (text) ALL_SQL.push(text);
        return origQuery(q, ...rest);
      };
      return client;
    });
  };
  return pool;
}

let pool: Pool; // spied — handed only to the adapter under test
let raw: Pool; // unspied — fixtures, reference queries, mutations
const ctx = (): AdapterContext => ({
  signal: new AbortController().signal,
  mode: 'interactive',
  budgetMs: 5_000,
});

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

const adapter = () => postgresAdapter({ pool, table: T });

function connector(over: Record<string, unknown> = {}) {
  return createConnector({
    secret: TEST_SECRET,
    adapter: adapter(),
    fieldMapping,
    attributes,
    clock: () => NOW,
    ...over,
  });
}

function signed(path: string, body?: unknown) {
  return signedRequest(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? '' : JSON.stringify(body),
    timestamp: NOW,
  });
}

const d = available ? describe : describe.skip;

beforeAll(async () => {
  if (!available) return;
  raw = new Pool({ connectionString: DSN, max: 5 });
  pool = spy(new Pool({ connectionString: DSN, max: 5 }));
  await raw.query(`DROP VIEW IF EXISTS ${SLEEP_VIEW}`);
  await raw.query(`DROP TABLE IF EXISTS ${T}`);
  await raw.query(`
    CREATE TABLE ${T} (
      user_id       text PRIMARY KEY,
      email_addr    text NOT NULL,
      seg           text,
      created       timestamptz,
      active        boolean,
      plan          text,
      region        text,
      secret_note   text,
      internal_flag boolean
    )`);
  await raw.query(`
    INSERT INTO ${T}
    SELECT
      'u_' || lpad(i::text, 4, '0'),
      'u' || i || '@example.com',
      CASE WHEN i % 3 = 0 THEN 'pro' ELSE 'free' END,
      timestamptz '2020-01-01 00:00:00+00' + (i || ' hours')::interval,
      i % 2 = 0,
      CASE WHEN i % 4 = 0 THEN 'pro' ELSE 'basic' END,
      (ARRAY['eu','us','apac'])[i % 3 + 1],
      'NOTE_' || i,
      i % 5 = 0
    FROM generate_series(0, 999) AS g(i)`);
  await raw.query(
    `CREATE VIEW ${SLEEP_VIEW} AS
       SELECT 'u_x'::text AS user_id, 'x@example.com'::text AS email_addr
         FROM (SELECT pg_sleep(10)) AS _s`,
  );
  ALL_SQL.length = 0; // ignore fixture DDL
});

afterAll(async () => {
  if (!available) return;
  await raw.query(`DROP VIEW IF EXISTS ${SLEEP_VIEW}`);
  await raw.query(`DROP TABLE IF EXISTS ${T}`);
  await raw.end();
  await pool.end();
});

d('S6.6 — identifier injection is refused at construction', () => {
  for (const bad of ['bad name', 'a"b', 'drop;', '1col', 'col-dash']) {
    it(`fieldMapping value ${JSON.stringify(bad)} → createConnector throws`, () => {
      expect(() =>
        createConnector({
          secret: TEST_SECRET,
          adapter: adapter(),
          fieldMapping: { externalId: 'user_id', email: bad },
        }),
      ).toThrow();
    });
  }
});

d('S6.7 — count matches a hand-written reference query', () => {
  const cases: Array<{ name: string; criteria: Query }> = [
    { name: 'empty', criteria: { all: [] } },
    { name: 'segment in [pro]', criteria: { all: [{ field: 'segment', op: 'in', values: ['pro'] }] } },
    { name: 'isActive eq true', criteria: { all: [{ field: 'isActive', op: 'eq', value: true }] } },
    {
      name: 'signupAt range (first 240h)',
      criteria: {
        all: [
          {
            field: 'signupAt',
            op: 'between',
            from: '2020-01-01T00:00:00.000Z',
            to: '2020-01-10T23:59:59.000Z',
          },
        ],
      },
    },
    { name: 'attr.plan eq pro', criteria: { all: [{ field: 'attr.plan', op: 'eq', value: 'pro' }] } },
    {
      name: 'segment in [free] AND isActive eq false',
      criteria: {
        all: [
          { field: 'segment', op: 'in', values: ['free'] },
          { field: 'isActive', op: 'eq', value: false },
        ],
      },
    },
  ];
  const refWhere: Record<string, string> = {
    empty: 'TRUE',
    'segment in [pro]': "seg = 'pro'",
    'isActive eq true': 'active = true',
    'signupAt range (first 240h)':
      "created >= '2020-01-01T00:00:00Z' AND created <= '2020-01-10T23:59:59Z'",
    'attr.plan eq pro': "plan = 'pro'",
    'segment in [free] AND isActive eq false': "seg = 'free' AND active = false",
  };

  for (const c of cases) {
    it(c.name, async () => {
      const got = await adapter().count(plan(c.criteria), ctx());
      const ref = await raw.query(`SELECT count(*)::int AS n FROM ${T} WHERE ${refWhere[c.name]}`);
      expect(got).toBe(ref.rows[0].n);
    });
  }
});

d('S6.3 — unmapped columns never leave the connector', () => {
  it('no returned row has secret_note / internal_flag, over count+search', async () => {
    const c = connector();
    const res = await c.fetch(
      signed('/candidates/search', { criteria: { all: [] }, mapping: {}, limit: 50 }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('secret_note');
    expect(body).not.toContain('internal_flag');
    expect(body).not.toContain('NOTE_');
    for (const row of JSON.parse(body).rows) {
      expect(Object.keys(row).sort()).not.toContain('secret_note');
      expect(Object.keys(row).sort()).not.toContain('internal_flag');
    }
  });
});

d('S6.9 — attribute filter works and is not returned unless mapped for display', () => {
  it('filter on region (not returnable) → region absent from rows', async () => {
    const { rows } = await adapter().search(
      plan({ all: [{ field: 'attr.region', op: 'in', values: ['eu'] }] }, { limit: 20 }),
      ctx(),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.attributes?.region).toBeUndefined();
    }
  });
  it('filter on plan (returnable) → plan present under attributes', async () => {
    const { rows } = await adapter().search(
      plan({ all: [{ field: 'attr.plan', op: 'eq', value: 'pro' }] }, { limit: 20 }),
      ctx(),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.attributes?.plan).toBe('pro');
  });
});

d('S6.5 — DSL values are bound parameters, not SQL', () => {
  it("a value of \"'); DROP TABLE ...\" is inert", async () => {
    const evil = "x'); DROP TABLE " + T + '; --';
    const { rows } = await adapter().search(
      plan({ all: [{ field: 'segment', op: 'in', values: [evil] }] }, { limit: 10 }),
      ctx(),
    );
    expect(rows).toEqual([]); // no such segment
    const still = await raw.query(`SELECT count(*)::int AS n FROM ${T}`);
    expect(still.rows[0].n).toBe(1000);
  });
});

d('S6.8 — suppressExternalIds excludes exactly the named ids, at scale', () => {
  it('1000-id suppression list is an array parameter', async () => {
    const suppress = Array.from({ length: 1000 }, (_, i) => `u_${String(i).padStart(4, '0')}`).slice(
      0,
      500,
    );
    const criteria: Query = { all: [], suppressExternalIds: suppress };
    const n = await adapter().count(plan(criteria), ctx());
    expect(n).toBe(500);
    const { rows } = await adapter().search(plan(criteria, { limit: 1000 }), ctx());
    const returned = new Set(rows.map((r) => r.externalId));
    for (const id of suppress) expect(returned.has(id)).toBe(false);

    const allIds = Array.from({ length: 1000 }, (_, i) => `u_${String(i).padStart(4, '0')}`);
    const nZero = await adapter().count(
      plan({ all: [], suppressExternalIds: allIds }),
      ctx(),
    );
    expect(nZero).toBe(0);
  });
});

d('S6.10 / S6.11 — pagination is complete, gap-free and stable', () => {
  it('paging 1000 rows at limit 100: union is the full set, no dupes, page 10 has no cursor', async () => {
    const a = adapter();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const p = plan({ all: [] }, { limit: 100, cursor });
      const { rows, nextCursor } = await a.search(p, ctx());
      seen.push(...rows.map((r) => r.externalId));
      pages++;
      if (!nextCursor) break;
      cursor = nextCursor;
      if (pages > 20) throw new Error('pagination did not terminate');
    }
    expect(pages).toBe(10);
    expect(new Set(seen).size).toBe(1000);
    expect(seen.length).toBe(1000);
  });

  it('the same cursor requested twice returns identical rows', async () => {
    const a = adapter();
    const first = await a.search(plan({ all: [] }, { limit: 100 }), ctx());
    const again1 = await a.search(plan({ all: [] }, { limit: 100, cursor: first.nextCursor }), ctx());
    const again2 = await a.search(plan({ all: [] }, { limit: 100, cursor: first.nextCursor }), ctx());
    expect(again1.rows.map((r) => r.externalId)).toEqual(again2.rows.map((r) => r.externalId));
  });
});

d('S6.12 — a concurrent insert does not resurface an already-returned row', () => {
  it('inserting rows between pages 3 and 4', async () => {
    const a = adapter();
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; page <= 4; page++) {
      const { rows, nextCursor } = await a.search(plan({ all: [] }, { limit: 100, cursor }), ctx());
      for (const r of rows) {
        expect(seen.has(r.externalId)).toBe(false);
        seen.add(r.externalId);
      }
      cursor = nextCursor;
      if (page === 3) {
        await raw.query(`
          INSERT INTO ${T}
          SELECT 'x_' || i, 'x' || i || '@e.com', 'free', now(), true, 'basic', 'eu', 'n', false
          FROM generate_series(1, 50) AS g(i)`);
      }
    }
    await raw.query(`DELETE FROM ${T} WHERE user_id LIKE 'x\\_%'`);
  });
});

d('S6.13 — the 1,000-row cap is in the SQL and enforced defensively', () => {
  it('limit 1000 on a 1,050-row table returns at most 1000', async () => {
    await raw.query(`
      INSERT INTO ${T}
      SELECT 'y_' || i, 'y' || i || '@e.com', 'free', now(), true, 'basic', 'eu', 'n', false
      FROM generate_series(1, 50) AS g(i)`);
    try {
      const { rows } = await adapter().search(plan({ all: [] }, { limit: 1000 }), ctx());
      expect(rows.length).toBeLessThanOrEqual(1000);
      expect(ALL_SQL.some((s) => /LIMIT \$\d+/i.test(s))).toBe(true);
    } finally {
      await raw.query(`DELETE FROM ${T} WHERE user_id LIKE 'y\\_%'`);
    }
  });
});

d('S6.14 — statement_timeout fires and the connection returns to the pool', () => {
  it('pg_sleep(10) with an ~800ms budget → timeout, pool idle recovers', async () => {
    const p = new Pool({ connectionString: DSN, max: 2 });
    try {
      const slow = postgresAdapter({ pool: p, table: SLEEP_VIEW });
      const shortCtx: AdapterContext = {
        signal: new AbortController().signal,
        mode: 'interactive',
        budgetMs: 800,
      };
      await expect(slow.count(plan({ all: [] }), shortCtx)).rejects.toMatchObject({
        code: 'timeout',
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(p.idleCount).toBe(p.totalCount);
      expect(p.totalCount).toBeGreaterThan(0);
    } finally {
      await p.end();
    }
  });
});

d('S6.15 — a dead pool surfaces adapter_error with nothing leaked in the response', () => {
  it('pointing at a closed port', async () => {
    const dead = new Pool({
      connectionString: 'postgres://nouser:sekritpw@127.0.0.1:1/nodb',
      connectionTimeoutMillis: 500,
    });
    try {
      const c = createConnector({
        secret: TEST_SECRET,
        adapter: postgresAdapter({ pool: dead, table: T }),
        fieldMapping,
        attributes,
        clock: () => NOW,
      });
      const res = await c.fetch(signed('/candidates/count', { criteria: { all: [] }, mapping: {} }));
      expect(res.status).toBe(502);
      const body = await res.text();
      expect(JSON.parse(body).error.code).toBe('adapter_error');
      for (const secret of ['sekritpw', 'nouser', 'nodb', '127.0.0.1', ':1']) {
        expect(body).not.toContain(secret);
      }
    } finally {
      await dead.end().catch(() => undefined);
    }
  });
});

d('S6.16 — schema() returns every real column with a type', () => {
  it('includes unmapped columns', async () => {
    const { columns } = await adapter().schema(ctx());
    const names = columns.map((c) => c.name);
    for (const expected of [
      'user_id',
      'email_addr',
      'seg',
      'created',
      'active',
      'plan',
      'region',
      'secret_note',
      'internal_flag',
    ]) {
      expect(names).toContain(expected);
    }
    for (const c of columns) expect(typeof c.type).toBe('string');
  });
});

d('S6.1 — a cursor round-trips through search() and stays query-bound', () => {
  it('the emitted cursor decodes to this query hash and seed', async () => {
    const p = plan({ all: [] }, { limit: 100 });
    const { nextCursor } = await adapter().search(p, ctx());
    expect(nextCursor).toBeDefined();
    const decoded = decodeCursor(nextCursor!);
    expect(decoded.qh).toBe(p.queryHash);
    expect(decoded.seed).toBe(p.seed);
  });
});

// ---- SQL-shape assertions run last, over everything issued above ----------

d('S6.2 / S6.4 — every statement is read-only and never SELECT *', () => {
  it('no captured statement is a SELECT *', () => {
    expect(ALL_SQL.length).toBeGreaterThan(10);
    for (const s of ALL_SQL) expect(s).not.toMatch(/select\s+\*/i);
  });

  it('every statement is BEGIN / SELECT / SET LOCAL / COMMIT / ROLLBACK only', () => {
    for (const s of ALL_SQL) {
      expect(s.trimStart()).toMatch(/^(BEGIN|SELECT|SET LOCAL|COMMIT|ROLLBACK)\b/i);
    }
  });

  it('no statement contains a write keyword', () => {
    for (const s of ALL_SQL) {
      expect(s).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|copy|grant|create)\b/i);
    }
  });
});
