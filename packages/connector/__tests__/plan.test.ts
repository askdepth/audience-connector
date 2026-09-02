import { describe, it, expect } from 'vitest';
import type { Query } from '@askdepth/audience-contract';
import {
  buildPlan,
  encodeCursor,
  decodeCursor,
  shuffleHash,
  ROW_CAP,
  type QueryPlan,
  type BuildPlanInput,
} from '../src/plan';
import { createConnector } from '../src/handler';
import { ConnectorError } from '../src/errors';
import { pageInMemory, type MemRow } from './_mem-adapter';
import { memAdapter } from './_mem-adapter';

const fieldMapping = {
  externalId: 'user_id',
  email: 'email_addr',
  name: 'full_name',
  segment: 'seg',
  signupAt: 'created',
  isActive: 'active',
} as const;

const FILTERABLE = ['plan', 'region'];
const RETURNABLE = ['plan'];

function plan(criteria: Query, opts: Partial<BuildPlanInput> = {}): QueryPlan {
  return buildPlan({
    criteria,
    requestMapping: opts.requestMapping ?? {},
    fieldMapping: opts.fieldMapping ?? fieldMapping,
    filterableAttributes: opts.filterableAttributes ?? FILTERABLE,
    returnableAttributes: opts.returnableAttributes ?? RETURNABLE,
    limit: opts.limit,
    cursor: opts.cursor,
    sample: opts.sample,
  });
}

function expectMalformed(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as ConnectorError).code).toBe('malformed_request');
    return;
  }
  throw new Error('expected malformed_request');
}

describe('S5.1 — each criterion shape compiles to the expected PlannedFilter', () => {
  it('segment IN', () => {
    const [f] = plan({ all: [{ field: 'segment', op: 'in', values: ['pro'] }] }).filters;
    expect(f).toMatchObject({ canonical: 'segment', column: 'seg', kind: 'in', values: ['pro'], isAttribute: false });
  });
  it('signupAt BETWEEN', () => {
    const [f] = plan({
      all: [{ field: 'signupAt', op: 'between', from: '2027-01-01T00:00:00.000Z', to: '2027-02-01T00:00:00.000Z' }],
    }).filters;
    expect(f).toMatchObject({ canonical: 'signupAt', column: 'created', kind: 'between', from: '2027-01-01T00:00:00.000Z', to: '2027-02-01T00:00:00.000Z' });
  });
  it('isActive EQ', () => {
    const [f] = plan({ all: [{ field: 'isActive', op: 'eq', value: true }] }).filters;
    expect(f).toMatchObject({ canonical: 'isActive', column: 'active', kind: 'eq', value: true });
  });
  it('externalId IN', () => {
    const [f] = plan({ all: [{ field: 'externalId', op: 'in', values: ['u_1', 'u_2'] }] }).filters;
    expect(f).toMatchObject({ canonical: 'externalId', column: 'user_id', kind: 'in', values: ['u_1', 'u_2'] });
  });
  it('attr.* EQ', () => {
    const [f] = plan({ all: [{ field: 'attr.plan', op: 'eq', value: 'pro' }] }).filters;
    expect(f).toMatchObject({ canonical: 'attr.plan', column: 'plan', kind: 'eq', value: 'pro', isAttribute: true });
  });
  it('attr.* IN', () => {
    const [f] = plan({ all: [{ field: 'attr.region', op: 'in', values: ['eu', 'us'] }] }).filters;
    expect(f).toMatchObject({ canonical: 'attr.region', column: 'region', kind: 'in', values: ['eu', 'us'], isAttribute: true });
  });
});

describe('S5.2 — a criterion on an unmapped canonical field is rejected', () => {
  it('segment not in fieldMapping → malformed_request', () => {
    const { segment: _omit, ...noSegment } = fieldMapping;
    expectMalformed(() =>
      plan({ all: [{ field: 'segment', op: 'in', values: ['pro'] }] }, { fieldMapping: noSegment }),
    );
  });
});

describe('S5.3 — an attr.* not in filterable is rejected', () => {
  it('attr.unknown → malformed_request', () => {
    expectMalformed(() => plan({ all: [{ field: 'attr.unknown', op: 'eq', value: 1 }] }));
  });
});

describe('S5.4 / S5.5 — attributes are filter-only unless returnable', () => {
  it('attr.region (filterable, not returnable): in filters, not in select', () => {
    const p = plan({ all: [{ field: 'attr.region', op: 'in', values: ['eu'] }] });
    expect(p.filters.map((f) => f.canonical)).toContain('attr.region');
    expect(p.select.map((s) => s.canonical)).not.toContain('attr.region');
  });
  it('attr.plan (returnable): in both filters and select', () => {
    const p = plan({ all: [{ field: 'attr.plan', op: 'eq', value: 'pro' }] });
    expect(p.filters.map((f) => f.canonical)).toContain('attr.plan');
    expect(p.select).toContainEqual({ canonical: 'attr.plan', column: 'plan' });
  });
});

describe('S5.6 — the filterable-attribute cap is enforced at construction', () => {
  const base = {
    secret: 's',
    adapter: memAdapter([]),
    fieldMapping: { externalId: 'id', email: 'e' },
  };
  it('11 filterable attributes → createConnector throws', () => {
    expect(() =>
      createConnector({
        ...base,
        attributes: { filterable: Array.from({ length: 11 }, (_, i) => `a${i}`) },
      }),
    ).toThrow();
  });
  it('10 filterable attributes → ok', () => {
    expect(() =>
      createConnector({
        ...base,
        attributes: { filterable: Array.from({ length: 10 }, (_, i) => `a${i}`) },
      }),
    ).not.toThrow();
  });
});

describe('S5.7 — select never contains a column absent from fieldMapping', () => {
  it('a plan touching every canonical field', () => {
    const p = plan(
      {
        all: [
          { field: 'segment', op: 'in', values: ['pro'] },
          { field: 'isActive', op: 'eq', value: true },
          { field: 'externalId', op: 'in', values: ['u_1'] },
          { field: 'attr.plan', op: 'eq', value: 'pro' },
        ],
      },
      { requestMapping: { user_id: 'externalId', email_addr: 'email', full_name: 'name', seg: 'segment' } },
    );
    const allowed = new Set<string>([...Object.values(fieldMapping), ...RETURNABLE]);
    for (const s of p.select) expect(allowed.has(s.column)).toBe(true);
  });
});

describe('S5.8 — an empty `all` is match-all, not match-none', () => {
  it('produces zero filters and does not throw', () => {
    const p = plan({ all: [] });
    expect(p.filters).toEqual([]);
  });
});

describe('S5.9 — cursor round-trips', () => {
  it('encode → decode is identity', () => {
    const token = encodeCursor({ h: 'abc123', id: 'u_42' }, 'qh-deadbeef', 'seed-0f0f');
    expect(decodeCursor(token)).toEqual({
      v: 1,
      after: { h: 'abc123', id: 'u_42' },
      qh: 'qh-deadbeef',
      seed: 'seed-0f0f',
    });
  });
});

describe('S5.10 — the cursor is bound to its query', () => {
  const criteriaA: Query = { all: [{ field: 'segment', op: 'in', values: ['pro'] }] };
  const criteriaB: Query = { all: [{ field: 'segment', op: 'in', values: ['free'] }] };

  it('a cursor from query A presented with query B → invalid_cursor', () => {
    const a = plan(criteriaA, { limit: 10 });
    const forgedCursor = encodeCursor({ h: 'x', id: 'y' }, a.queryHash, a.seed);
    try {
      plan(criteriaB, { limit: 10, cursor: forgedCursor });
    } catch (e) {
      expect((e as ConnectorError).code).toBe('invalid_cursor');
      return;
    }
    throw new Error('expected invalid_cursor');
  });

  it('queryHash is stable across criterion key ordering', () => {
    const ordered: Query = { all: [{ field: 'segment', op: 'in', values: ['pro'] }] };
    const shuffled: Query = { all: [{ values: ['pro'], op: 'in', field: 'segment' } as never] };
    expect(plan(ordered).queryHash).toBe(plan(shuffled).queryHash);
  });

  it('queryHash is independent of value order within an IN clause', () => {
    const a: Query = { all: [{ field: 'segment', op: 'in', values: ['a', 'b', 'c'] }] };
    const b: Query = { all: [{ field: 'segment', op: 'in', values: ['c', 'a', 'b'] }] };
    expect(plan(a).queryHash).toBe(plan(b).queryHash);
  });

  it('queryHash is independent of the order of two filters on the same field', () => {
    const a: Query = {
      all: [
        { field: 'attr.region', op: 'in', values: ['eu'] },
        { field: 'attr.region', op: 'in', values: ['us'] },
      ],
    };
    const b: Query = {
      all: [
        { field: 'attr.region', op: 'in', values: ['us'] },
        { field: 'attr.region', op: 'in', values: ['eu'] },
      ],
    };
    expect(plan(a).queryHash).toBe(plan(b).queryHash);
  });

  it('queryHash still separates genuinely different criteria', () => {
    expect(plan({ all: [{ field: 'segment', op: 'in', values: ['a'] }] }).queryHash).not.toBe(
      plan({ all: [{ field: 'segment', op: 'in', values: ['b'] }] }).queryHash,
    );
  });
});

describe('S5.11 — a broken cursor never crashes, always invalid_cursor', () => {
  const good = encodeCursor({ h: 'abc', id: 'u_1' }, 'qh', 'seed');
  const cases: Record<string, string> = {
    'flipped char': good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A'),
    truncated: good.slice(0, good.length - 5),
    empty: '',
    'not base64': '!!!not-b64!!!',
    'v=2': Buffer.from(
      JSON.stringify({ v: 2, after: { h: 'a', id: 'b' }, qh: 'q', seed: 's' }),
    ).toString('base64url'),
    'missing after': Buffer.from(JSON.stringify({ v: 1, qh: 'q', seed: 's' })).toString('base64url'),
  };
  for (const [name, token] of Object.entries(cases)) {
    it(name, () => {
      let err: unknown;
      try {
        decodeCursor(token);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConnectorError);
      expect((err as ConnectorError).code).toBe('invalid_cursor');
    });
  }
});

describe('S5.12 — the shuffle seed is generated once per pull', () => {
  const rows: MemRow[] = Array.from({ length: 25 }, (_, i) => ({
    externalId: `u_${String(i).padStart(3, '0')}`,
    email: `u${i}@x.com`,
  }));

  it('page 2, decoded from page 1s cursor, reuses page 1s seed', () => {
    const p1 = plan({ all: [] }, { limit: 10 });
    const { nextCursor } = pageInMemory(rows, p1);
    expect(nextCursor).toBeDefined();
    const p2 = plan({ all: [] }, { limit: 10, cursor: nextCursor });
    expect(p2.seed).toBe(p1.seed);
    expect(decodeCursor(nextCursor!).seed).toBe(p1.seed);
  });
});

// --- sampling / ordering properties ---------------------------------------

function makeFixture(n: number): MemRow[] {
  // signupAt strictly increasing with insertion order.
  return Array.from({ length: n }, (_, i) => ({
    externalId: `u_${String(i).padStart(4, '0')}`,
    email: `u${i}@x.com`,
    signupAt: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString(),
  }));
}

function planWithSeed(seed: string, limit: number): QueryPlan {
  return {
    select: [{ canonical: 'externalId', column: 'user_id' }, { canonical: 'signupAt', column: 'created' }],
    filters: [],
    suppress: [],
    seed,
    externalIdColumn: 'user_id',
    limit,
    queryHash: 'fixed-qh',
  };
}

function drain(rows: MemRow[], seed: string, want: number, pageSize: number): string[] {
  const ids: string[] = [];
  let cursor: string | undefined;
  while (ids.length < want) {
    const p = planWithSeed(seed, pageSize);
    if (cursor) {
      const dec = decodeCursor(cursor);
      p.after = dec.after;
    }
    const { rows: page, nextCursor } = pageInMemory(rows, p);
    for (const r of page) {
      ids.push(r.externalId);
      if (ids.length >= want) break;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return ids;
}

describe('S5.13 — the random subsample is not biased toward the oldest users', () => {
  const rows = makeFixture(1000);
  const seeds = ['00', 'a1b2', 'deadbeef', '0f0f0f0f', 'cafe1234'];

  for (const seed of seeds) {
    it(`seed=${seed}: mean signupAt percentile of 100 sampled rows is ~0.5`, () => {
      const ids = drain(rows, seed, 100, 37);
      expect(ids.length).toBe(100);
      const indices = ids.map((id) => Number(id.slice(2)));
      const meanPct = indices.reduce((a, b) => a + b, 0) / indices.length / 999;
      expect(meanPct).toBeGreaterThan(0.35);
      expect(meanPct).toBeLessThan(0.65);
      const firstHundred = new Set(Array.from({ length: 100 }, (_, i) => `u_${String(i).padStart(4, '0')}`));
      expect(ids.every((id) => firstHundred.has(id))).toBe(false);
    });
  }
});

describe('S5.14 / S5.15 — ordering is reproducible per seed and varies across seeds', () => {
  const rows = makeFixture(200);

  it('same seed → identical ordering across two builds', () => {
    const a = pageInMemory(rows, planWithSeed('seed-x', ROW_CAP)).rows.map((r) => r.externalId);
    const b = pageInMemory(rows, planWithSeed('seed-x', ROW_CAP)).rows.map((r) => r.externalId);
    expect(a).toEqual(b);
  });

  it('different seeds → different orderings', () => {
    const seeds = ['s1', 's2', 's3', 's4', 's5'];
    const orders = seeds.map((s) =>
      pageInMemory(rows, planWithSeed(s, ROW_CAP)).rows.map((r) => r.externalId).join(','),
    );
    expect(new Set(orders).size).toBe(seeds.length);
  });
});
