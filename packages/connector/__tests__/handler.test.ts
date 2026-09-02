import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONTRACT_VERSION,
  HealthResponseSchema,
  type CapabilityFlag,
} from '@askdepth/audience-contract';
import { createConnector } from '../src/handler';
import type { Adapter, AdapterContext } from '../src/types';
import { signedRequest, TEST_SECRET } from './_util';

const NOW = 1_700_000_000;
const BASE = 'http://connector.test/askdepth/v1';

// `Response.json()` is typed as `unknown` under the bundled undici types.
// Tests assert on wire shapes we already know; narrow once here.
const j = async (res: Response): Promise<any> => res.json();

const ALL_CAPS: CapabilityFlag[] = [
  'externalIdIn',
  'attributeFilters',
  'dateRanges',
  'randomSample',
];

function stubAdapter(overrides: Partial<Adapter> = {}): Adapter {
  return {
    kind: 'rest',
    capabilities: overrides.capabilities ?? ALL_CAPS,
    schema: overrides.schema ?? (async () => ({ columns: [{ name: 'user_id', type: 'text' }] })),
    count: overrides.count ?? (async () => 7),
    search: overrides.search ?? (async () => ({ rows: [], nextCursor: undefined })),
  };
}

function connectorWith(adapter: Adapter, extra: Record<string, unknown> = {}) {
  return createConnector({
    secret: TEST_SECRET,
    adapter,
    fieldMapping: { externalId: 'user_id', email: 'email_addr' },
    clock: () => NOW,
    ...extra,
  });
}

const COUNT_BODY = JSON.stringify({ criteria: { all: [] }, mapping: {} });
const SEARCH_BODY = JSON.stringify({ criteria: { all: [] }, mapping: {}, limit: 100 });

function signed(path: string, opts: Parameters<typeof signedRequest>[1] = {}) {
  return signedRequest(`${BASE}${path}`, { timestamp: NOW, ...opts });
}

afterEach(() => vi.useRealTimers());

describe('S4.1 — the four routes answer 200 on a valid signed request', () => {
  const c = connectorWith(stubAdapter());
  it('GET /health', async () => {
    expect((await c.fetch(signed('/health', { method: 'GET' }))).status).toBe(200);
  });
  it('GET /schema', async () => {
    expect((await c.fetch(signed('/schema', { method: 'GET' }))).status).toBe(200);
  });
  it('POST /candidates/count', async () => {
    const res = await c.fetch(signed('/candidates/count', { method: 'POST', body: COUNT_BODY }));
    expect(res.status).toBe(200);
    expect(await j(res)).toEqual({ count: 7 });
  });
  it('POST /candidates/search', async () => {
    const res = await c.fetch(signed('/candidates/search', { method: 'POST', body: SEARCH_BODY }));
    expect(res.status).toBe(200);
    expect(await j(res)).toEqual({ rows: [], nextCursor: undefined });
  });
});

describe('S4.2 — /health body', () => {
  it('validates against HealthResponseSchema with the contract-sourced version', async () => {
    const c = connectorWith(stubAdapter());
    const body = await j(await c.fetch(signed('/health', { method: 'GET' })));
    expect(HealthResponseSchema.safeParse(body).success).toBe(true);
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.ok).toBe(true);
  });
});

describe('S4.3 — capability intersection', () => {
  const adapter = stubAdapter({ capabilities: ['externalIdIn', 'randomSample'] });
  const c = connectorWith(adapter, { capabilities: { randomSample: false } });

  it('/health advertises only the non-disabled capability', async () => {
    const body = await j(await c.fetch(signed('/health', { method: 'GET' })));
    expect(body.capabilities).toEqual(['externalIdIn']);
  });

  it('a search requesting a sample of a disabled capability → unsupported_capability', async () => {
    const body = JSON.stringify({
      criteria: { all: [] },
      mapping: {},
      limit: 10,
      sample: { method: 'random', size: 5 },
    });
    const res = await c.fetch(signed('/candidates/search', { method: 'POST', body }));
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('unsupported_capability');
  });
});

describe('S4.4 — routing happens after authentication', () => {
  const c = connectorWith(stubAdapter());
  it('unknown path, correctly signed → 404', async () => {
    const res = await c.fetch(signed('/does-not-exist', { method: 'GET' }));
    expect(res.status).toBe(404);
    expect((await j(res)).error.code).toBe('not_found');
  });
  it('unknown path, unsigned → 401 (auth is checked first)', async () => {
    const res = await c.fetch(new Request(`${BASE}/does-not-exist`, { method: 'GET' }));
    expect(res.status).toBe(401);
  });
});

describe('S4.5 — wrong method on a known path → 405', () => {
  it('GET /candidates/count', async () => {
    const c = connectorWith(stubAdapter());
    const res = await c.fetch(signed('/candidates/count', { method: 'GET' }));
    expect(res.status).toBe(405);
    expect((await j(res)).error.code).toBe('method_not_allowed');
  });
});

describe('S4.6 — POST must be application/json', () => {
  it('text/plain → malformed_request', async () => {
    const c = connectorWith(stubAdapter());
    const res = await c.fetch(
      signed('/candidates/count', {
        method: 'POST',
        body: COUNT_BODY,
        extraHeaders: { 'content-type': 'text/plain' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('malformed_request');
  });
});

describe('S4.7 — a schema failure never echoes the submitted values', () => {
  it('unknown criteria field with a tracer value → 400, tracer absent from the body', async () => {
    const c = connectorWith(stubAdapter());
    const body = JSON.stringify({
      criteria: { all: [{ field: 'zzTRACERzz', op: 'in', values: ['zzTRACERzz'] }] },
      mapping: { zzTRACERzz: 'zzTRACERzz' },
    });
    const res = await c.fetch(signed('/candidates/count', { method: 'POST', body }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('zzTRACERzz');
    expect(JSON.parse(text).error.code).toBe('malformed_request');
  });
});

describe('S4.8 — the limit boundary', () => {
  it('limit 1001 → limit_exceeded, adapter never invoked', async () => {
    const search = vi.fn(async () => ({ rows: [], nextCursor: undefined }));
    const c = connectorWith(stubAdapter({ search }));
    const body = JSON.stringify({ criteria: { all: [] }, mapping: {}, limit: 1001 });
    const res = await c.fetch(signed('/candidates/search', { method: 'POST', body }));
    expect(res.status).toBe(400);
    expect((await j(res)).error.code).toBe('limit_exceeded');
    expect(search).not.toHaveBeenCalled();
  });

  it('limit 1000 → accepted', async () => {
    const c = connectorWith(stubAdapter());
    const body = JSON.stringify({ criteria: { all: [] }, mapping: {}, limit: 1000 });
    expect((await c.fetch(signed('/candidates/search', { method: 'POST', body }))).status).toBe(200);
  });

  for (const bad of [0, -5, 10.5]) {
    it(`limit ${bad} → malformed_request`, async () => {
      const c = connectorWith(stubAdapter());
      const body = JSON.stringify({ criteria: { all: [] }, mapping: {}, limit: bad });
      const res = await c.fetch(signed('/candidates/search', { method: 'POST', body }));
      expect(res.status).toBe(400);
      expect((await j(res)).error.code).toBe('malformed_request');
    });
  }
});

describe('S4.9 — a hung adapter times out and its AbortSignal is aborted', () => {
  it('never-resolving search → 504 after the interactive budget', async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const c = connectorWith(
      stubAdapter({
        search: (_p, ctx: AdapterContext) => {
          captured = ctx.signal;
          return new Promise(() => {}); // never settles
        },
      }),
      { timeouts: { interactiveMs: 5_000 } },
    );
    const p = c.fetch(signed('/candidates/search', { method: 'POST', body: SEARCH_BODY }));
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await j(res)).error.code).toBe('timeout');
    expect(captured?.aborted).toBe(true);
  });
});

describe('S4.10 — the mode header selects the budget', () => {
  function slowAdapter(afterMs: number) {
    return stubAdapter({
      search: () =>
        new Promise((resolve) => setTimeout(() => resolve({ rows: [], nextCursor: undefined }), afterMs)),
    });
  }

  it('a 6s adapter times out in interactive mode (5s budget)', async () => {
    vi.useFakeTimers();
    const c = connectorWith(slowAdapter(6_000)); // default budgets
    const p = c.fetch(signed('/candidates/search', { method: 'POST', body: SEARCH_BODY }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await p).status).toBe(504);
  });

  it('the same 6s adapter succeeds in background mode (30s budget)', async () => {
    vi.useFakeTimers();
    const c = connectorWith(slowAdapter(6_000));
    const p = c.fetch(
      signed('/candidates/search', {
        method: 'POST',
        body: SEARCH_BODY,
        extraHeaders: { 'x-askdepth-mode': 'background' },
      }),
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await p).status).toBe(200);
  });
});

describe('S4.11 — a raw adapter throw becomes adapter_error, message fixed', () => {
  it('502 with no leaked text', async () => {
    const c = connectorWith(
      stubAdapter({
        count: async () => {
          throw new Error('boom postgres://u:p@h/db secret=xyz');
        },
      }),
    );
    const res = await c.fetch(signed('/candidates/count', { method: 'POST', body: COUNT_BODY }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('adapter_error');
    expect(text).not.toContain('boom');
    expect(text).not.toContain('xyz');
    expect(text).not.toContain('postgres://');
  });
});

describe('S4.12 — every response is application/json', () => {
  const c = connectorWith(stubAdapter());
  const cases: Array<[string, () => Request]> = [
    ['200 /health', () => signed('/health', { method: 'GET' })],
    ['404 unknown', () => signed('/nope', { method: 'GET' })],
    ['401 unsigned', () => new Request(`${BASE}/health`, { method: 'GET' })],
    ['405 wrong method', () => signed('/candidates/count', { method: 'GET' })],
    [
      '400 bad body',
      () =>
        signed('/candidates/count', {
          method: 'POST',
          body: JSON.stringify({ nope: true }),
        }),
    ],
  ];
  for (const [name, mk] of cases) {
    it(name, async () => {
      const res = await c.fetch(mk());
      expect(res.headers.get('content-type')).toBe('application/json');
    });
  }
});
