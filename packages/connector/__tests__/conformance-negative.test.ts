// S3 — the four wire-provable negative conformance cases (N1, N2, N4, N8 of
// docs/conformance-spec.md, "a connector fails if it…").
//
// Two obligations, mirroring S2:
//   1. a correct in-process connector makes every one PASS;
//   2. an ad-hoc fixture that commits exactly one of the violations makes the
//      matching case FAIL, with a detail that names what went wrong.
// Plus: a populated registry still honours `--case` selection, and an unknown
// id is still a runner error.
//
// The broken fixtures here are LOCAL to this file — hand-built fetch seams, not
// the shared S5 fixtures. None of them lives under `src/`.

import { describe, it, expect } from 'vitest';
import { sign, verify } from '@askdepth/audience-contract';
import { createConnector } from '../src/index';
import {
  createConformanceClient,
  type ConformanceClient,
} from '../src/conformance/client';
import { CONFORMANCE_CASES, RunnerError, runConformance } from '../src/conformance/runner';
import type { ConformanceCase } from '../src/conformance/runner';
import { memAdapter } from './_mem-adapter';
import {
  FIXTURE_FIELD_MAPPING,
  FIXTURE_SECRET,
  correctClient,
  syntheticUsers,
} from './_conformance-fixtures';

// Mirrors the private constants in `_conformance-fixtures.ts`.
const BASE_URL = 'http://connector.fixture/askdepth/v1';
const ATTRIBUTES = { filterable: ['plan', 'tier'], returnable: ['tier'] };
const COLUMNS = [
  { name: 'user_id', type: 'text' },
  { name: 'email_addr', type: 'text' },
];

const secretBuf = () => Buffer.from(FIXTURE_SECRET, 'utf8');

/** A genuine in-process connector over the synthetic base. */
function refConnector() {
  return createConnector({
    secret: FIXTURE_SECRET,
    adapter: memAdapter(syntheticUsers(), { columns: COLUMNS }),
    fieldMapping: FIXTURE_FIELD_MAPPING,
    attributes: ATTRIBUTES,
  });
}

const NEG_IDS = ['N1', 'N2', 'N4', 'N8'] as const;

const byId = (id: string): ConformanceCase => {
  const c = CONFORMANCE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no such case ${id}`);
  return c;
};

// ---------------------------------------------------------------------------
// Ad-hoc broken fixtures
// ---------------------------------------------------------------------------

/**
 * N1 violation: answers unsigned requests. Implemented as a seam that re-signs
 * whatever arrives before handing it to a real connector — so the frozen
 * `verify-request.ts` always passes and the connector effectively enforces
 * nothing.
 */
function unsignedAcceptingClient(): ConformanceClient {
  const connector = refConnector();
  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const raw = hasBody ? await src.clone().text() : '';
    const ts = Math.floor(Date.now() / 1000);
    const headers = new Headers(src.headers);
    headers.set('x-askdepth-timestamp', String(ts));
    headers.set('x-askdepth-signature', sign(hasBody ? raw : '', ts, secretBuf()));
    return connector.fetch(
      new Request(String(input), { method, headers, body: hasBody ? raw : undefined }),
    );
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

/**
 * N4 violation: echoes the raw adapter/driver failure — fake connection string
 * and a row fragment included — straight into the error body, bypassing the
 * fixed code table. Signature verification is still real.
 */
const LEAK_DSN = 'postgres://svc_reader:hunter2@prod-db.internal:5432/candidates';
const LEAK_ROW = 'email=victim@real-user.example';

function leakyErrorClient(): ConformanceClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const raw = hasBody ? await src.clone().text() : '';
    const ts = src.headers.get('x-askdepth-timestamp') ?? '';
    const sig = src.headers.get('x-askdepth-signature') ?? '';
    const jsonHeaders = { 'content-type': 'application/json' };

    if (!ts || !sig || !verify(hasBody ? raw : '', ts, sig, secretBuf()).valid) {
      return new Response(
        JSON.stringify({ error: { code: 'unauthorized', message: 'Request is not authorized.' } }),
        { status: 401, headers: jsonHeaders },
      );
    }

    const url = new URL(String(input));
    if (url.pathname.endsWith('/candidates/count') || url.pathname.endsWith('/candidates/search')) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'adapter_error',
            message: `query failed: connection to ${LEAK_DSN} refused while filtering ${raw}; last row seen: { ${LEAK_ROW} }`,
          },
        }),
        { status: 502, headers: jsonHeaders },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, contractVersion: '1.0.0', capabilities: [] }),
      { status: 200, headers: jsonHeaders },
    );
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

/**
 * N8 violation: an extra `DELETE /candidates/:id` route beside the real
 * connector that answers 200. Everything else falls through to the connector.
 */
function writePathClient(): ConformanceClient {
  const connector = refConnector();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'DELETE' && /\/candidates\/\d+$/.test(url.pathname)) {
      return new Response(JSON.stringify({ deleted: url.pathname.split('/').pop() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return connector.fetch(new Request(String(input), init as RequestInit));
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

/**
 * D-1 violation: signature IS enforced on GET, but an UNSIGNED POST to the
 * data endpoints is served anyway (the connector's auth middleware gates GET
 * routes only). A request that already carries signature headers is passed
 * through untouched, so the real gate still rejects a bad/expired signature —
 * only the "unauthenticated data access" half of N1 gets through.
 */
function getOnlyAuthClient(): ConformanceClient {
  const connector = refConnector();
  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const url = new URL(src.url);
    const isDataPost =
      method === 'POST' &&
      (url.pathname.endsWith('/candidates/count') || url.pathname.endsWith('/candidates/search'));
    const hasSig =
      src.headers.has('x-askdepth-signature') && src.headers.has('x-askdepth-timestamp');
    if (isDataPost && !hasSig) {
      // THE VIOLATION: mint a signature for the unsigned data request.
      const raw = await src.clone().text();
      const ts = Math.floor(Date.now() / 1000);
      const headers = new Headers(src.headers);
      headers.set('x-askdepth-timestamp', String(ts));
      headers.set('x-askdepth-signature', sign(raw, ts, secretBuf()));
      return connector.fetch(new Request(src.url, { method, headers, body: raw }));
    }
    return connector.fetch(new Request(String(input), init as RequestInit));
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

/**
 * D-2 violation: signature verification is present, but the replay window is
 * ±600s instead of the contract's ±300s. A request inside the lax window is
 * re-signed fresh and handed to a genuine connector; an unsigned request is
 * still refused, so only the "expired signature accepted" half of N2 gets
 * through — and only at the ~330s boundary, not at 1000s.
 */
function laxWindowClient(): ConformanceClient {
  const connector = refConnector();
  const secret = secretBuf();
  const LAX_WINDOW = 600;
  const j = { 'content-type': 'application/json' };
  const deny = (code: string) =>
    new Response(JSON.stringify({ error: { code, message: 'Request is not authorized.' } }), {
      status: 401,
      headers: j,
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const src = new Request(String(input), init as RequestInit);
    const method = src.method.toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const raw = hasBody ? await src.clone().text() : '';
    const signed = hasBody ? raw : '';
    const sig = src.headers.get('x-askdepth-signature') ?? '';
    const tsHeader = src.headers.get('x-askdepth-timestamp') ?? '';
    if (!sig || !tsHeader) return deny('unauthorized');
    const ts = Number(tsHeader);
    if (!Number.isFinite(ts)) return deny('invalid_signature');
    // THE VIOLATION: ±600s, not ±300s.
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > LAX_WINDOW) return deny('expired_timestamp');
    if (sign(signed, ts, secret) !== sig) return deny('invalid_signature');
    const freshTs = Math.floor(Date.now() / 1000);
    const headers = new Headers(src.headers);
    headers.set('x-askdepth-timestamp', String(freshTs));
    headers.set('x-askdepth-signature', sign(signed, freshTs, secret));
    return connector.fetch(
      new Request(src.url, { method, headers, body: hasBody ? raw : undefined }),
    );
  };
  return createConformanceClient({ url: BASE_URL, secret: FIXTURE_SECRET, fetchImpl });
}

// ---------------------------------------------------------------------------
// 1. a correct connector passes every negative case
// ---------------------------------------------------------------------------

describe('S3 — a correct connector passes every wire negative case', () => {
  for (const id of NEG_IDS) {
    it(`${id} passes`, async () => {
      const result = await byId(id).run(correctClient());
      expect(result, JSON.stringify(result)).toMatchObject({ id, pass: true });
    });
  }
});

// ---------------------------------------------------------------------------
// 2–4. each broken fixture is caught by exactly its case
// ---------------------------------------------------------------------------

describe('S3 — a broken fixture fails the matching case', () => {
  it('N1: a connector that answers unsigned requests → pass:false, clear detail', async () => {
    const result = await byId('N1').run(unsignedAcceptingClient());
    expect(result.id).toBe('N1');
    expect(result.pass).toBe(false);
    expect(result.detail ?? '').toMatch(/unsigned/i);
    expect(result.detail ?? '').toMatch(/\/health|\/schema/);
  });

  it('N4: a connector that echoes a raw adapter error → pass:false, detail quotes the leak', async () => {
    const result = await byId('N4').run(leakyErrorClient());
    expect(result.id).toBe('N4');
    expect(result.pass).toBe(false);
    // The detail must quote the leaked substring it found.
    expect(result.detail ?? '').toMatch(/zzTRACERzz|postgres:\/\/|svc_reader|victim@real-user/);
  });

  it('N8: a connector exposing DELETE /candidates/:id → pass:false, detail names method+path', async () => {
    const result = await byId('N8').run(writePathClient());
    expect(result.id).toBe('N8');
    expect(result.pass).toBe(false);
    expect(result.detail ?? '').toMatch(/DELETE/);
    expect(result.detail ?? '').toMatch(/\/candidates\/1\b/);
  });
});

// ---------------------------------------------------------------------------
// N2 has no "wrapper" fixture — the violation is a connector that skips the
// timestamp-window / signature check. The unsigned-accepting seam above (which
// re-signs with a fresh timestamp) is exactly such a connector, so it also
// trips N2. That doubles as proof N2 catches a "signature not enforced" build.
// ---------------------------------------------------------------------------

describe('S3 — N2 catches a connector that does not enforce the signature', () => {
  it('the unsigned-accepting seam also fails N2', async () => {
    const result = await byId('N2').run(unsignedAcceptingClient());
    expect(result).toMatchObject({ id: 'N2', pass: false });
    expect(result.detail ?? '').toMatch(/signature/i);
  });
});

// ---------------------------------------------------------------------------
// D-1 / D-2 — coverage gaps closed by security review
// ---------------------------------------------------------------------------

describe('S3 — D-1: N1 probes unsigned POST to the data endpoints', () => {
  it('a connector that authenticates GET but serves unsigned POST /candidates/* → N1 pass:false naming the POST path', async () => {
    const result = await byId('N1').run(getOnlyAuthClient());
    expect(result).toMatchObject({ id: 'N1', pass: false });
    expect(result.detail ?? '').toMatch(/unsigned POST \/candidates\/(count|search)/);
  });

  it('that same fixture still passes N2 (it does enforce the signature when one is present)', async () => {
    const result = await byId('N2').run(getOnlyAuthClient());
    expect(result, JSON.stringify(result)).toMatchObject({ id: 'N2', pass: true });
  });

  it('the correct in-process connector still passes N1', async () => {
    const result = await byId('N1').run(correctClient());
    expect(result, JSON.stringify(result)).toMatchObject({ id: 'N1', pass: true });
  });
});

describe('S3 — D-2: N2 exercises the ±300s replay-window boundary', () => {
  it('a connector with a ±600s window → N2 pass:false on the ~330s probe', async () => {
    const result = await byId('N2').run(laxWindowClient());
    expect(result).toMatchObject({ id: 'N2', pass: false });
    expect(result.detail ?? '').toMatch(/330s/);
    expect(result.detail ?? '').toMatch(/signature/i);
  });

  it('the correct in-process connector still passes N2 (rejects every skew probe)', async () => {
    const result = await byId('N2').run(correctClient());
    expect(result, JSON.stringify(result)).toMatchObject({ id: 'N2', pass: true });
  });
});

// ---------------------------------------------------------------------------
// broken fixtures are wrong ONLY for their own case
// ---------------------------------------------------------------------------

describe('S3 — a broken fixture does not trip unrelated negative cases', () => {
  it('the write-path fixture still passes N1, N2, N4', async () => {
    for (const id of ['N1', 'N2', 'N4'] as const) {
      const result = await byId(id).run(writePathClient());
      expect(result, `${id}: ${result.detail}`).toMatchObject({ id, pass: true });
    }
  });

  it('the leaky-error fixture still passes N1', async () => {
    const result = await byId('N1').run(leakyErrorClient());
    expect(result).toMatchObject({ id: 'N1', pass: true });
  });
});

// ---------------------------------------------------------------------------
// 5. registry / selection regression
// ---------------------------------------------------------------------------

describe('S3 — populated registry still honours --case selection', () => {
  it('only:["N1","N4"] runs exactly those two, both pass against a correct connector', async () => {
    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: BASE_URL,
      timeoutMs: 5000,
      only: ['N1', 'N4'],
    });
    expect(summary.cases.map((c) => c.id)).toEqual(['N1', 'N4']);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
  });

  it('an id that is in no stage registry → RunnerError (maps to exit 2)', async () => {
    await expect(
      runConformance(correctClient(), CONFORMANCE_CASES, {
        url: BASE_URL,
        timeoutMs: 5000,
        only: ['N9'],
      }),
    ).rejects.toBeInstanceOf(RunnerError);
  });

  it('N3 is now wired (S4) — --case N3 selects it and it runs', async () => {
    const summary = await runConformance(correctClient(), CONFORMANCE_CASES, {
      url: BASE_URL,
      timeoutMs: 5000,
      only: ['N3'],
    });
    expect(summary.cases.map((c) => c.id)).toEqual(['N3']);
    expect(summary.cases[0]).toMatchObject({ id: 'N3', pass: true });
  });
});
