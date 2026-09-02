import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { sign } from '@askdepth/audience-contract';
import { verifyRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/verify-request';
import { ConnectorError } from '../src/errors';
import {
  signedHeaders,
  TEST_SECRET,
  TEST_PREVIOUS_SECRET,
  OTHER_SECRET,
} from './_util';

const NOW = 1_700_000_000; // seconds
const clock = () => NOW;
const config = { secret: TEST_SECRET, clock };

/** Minimal harness: verify, then "reach an adapter". Mirrors the ordering the
 *  real router (S4) guarantees — the adapter spy proves the gate ran first. */
function gate(
  method: string,
  headers: Headers,
  body: string,
  cfg = config,
): { adapter: ReturnType<typeof vi.fn> } {
  const adapter = vi.fn();
  verifyRequest(method, headers, body, cfg);
  adapter(); // unreachable if verifyRequest threw
  return { adapter };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as ConnectorError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ConnectorError('${code}') but nothing was thrown`);
}

const ROUTES = [
  { method: 'GET', path: '/askdepth/v1/health', body: '' },
  { method: 'GET', path: '/askdepth/v1/schema', body: '' },
  { method: 'POST', path: '/askdepth/v1/candidates/count', body: '{"criteria":{"all":[]},"mapping":{}}' },
  { method: 'POST', path: '/askdepth/v1/candidates/search', body: '{"criteria":{"all":[]},"mapping":{},"limit":100}' },
] as const;

describe('S3.1 — a valid signature passes the gate on every endpoint', () => {
  for (const r of ROUTES) {
    it(`${r.method} ${r.path}`, () => {
      const headers = signedHeaders({ method: r.method, body: r.body, timestamp: NOW });
      const { adapter } = gate(r.method, headers, r.body);
      expect(adapter).toHaveBeenCalledTimes(1);
    });
  }
});

describe('S3.2 / S3.3 — a missing header is rejected before the adapter', () => {
  it('no signature header → unauthorized, adapter never invoked', () => {
    const headers = signedHeaders({ timestamp: NOW });
    headers.delete(SIGNATURE_HEADER);
    const adapter = vi.fn();
    expectCode(() => {
      verifyRequest('POST', headers, '', config);
      adapter();
    }, 'unauthorized');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('no timestamp header → unauthorized, adapter never invoked', () => {
    const headers = signedHeaders({ timestamp: NOW });
    headers.delete(TIMESTAMP_HEADER);
    const adapter = vi.fn();
    expectCode(() => {
      verifyRequest('POST', headers, '', config);
      adapter();
    }, 'unauthorized');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('empty-string headers are treated as missing', () => {
    const headers = new Headers({ [SIGNATURE_HEADER]: '', [TIMESTAMP_HEADER]: '' });
    expectCode(() => verifyRequest('POST', headers, '', config), 'unauthorized');
  });
});

describe('S3.4 / S3.5 — body/signature must agree', () => {
  it('signature computed over a different body → invalid_signature, adapter not invoked', () => {
    const sent = '{"criteria":{"all":[]},"mapping":{}}';
    const headers = signedHeaders({ body: sent, signOverBody: sent + 'X', timestamp: NOW });
    const adapter = vi.fn();
    expectCode(() => {
      verifyRequest('POST', headers, sent, config);
      adapter();
    }, 'invalid_signature');
    expect(adapter).not.toHaveBeenCalled();
  });

  it('body mutated by one byte after signing → invalid_signature', () => {
    const body = '{"criteria":{"all":[]},"mapping":{}}';
    const headers = signedHeaders({ body, timestamp: NOW });
    expectCode(() => verifyRequest('POST', headers, body + ' ', config), 'invalid_signature');
  });
});

describe('S3.6 — 300s replay window, inclusive, both directions', () => {
  const body = '{"criteria":{"all":[]},"mapping":{}}';
  const at = (skew: number) => {
    // Sign at NOW - skew (past) or NOW + |skew| ... express as: signed timestamp
    const signedTs = NOW - skew;
    const headers = signedHeaders({ body, timestamp: signedTs });
    return () => verifyRequest('POST', headers, body, config);
  };

  it('299s old → passes', () => expect(at(299)).not.toThrow());
  it('300s old → passes (boundary inclusive)', () => expect(at(300)).not.toThrow());
  it('301s old → expired_timestamp', () => expectCode(at(301), 'expired_timestamp'));
  it('299s in the future → passes', () => expect(at(-299)).not.toThrow());
  it('300s in the future → passes (boundary inclusive)', () => expect(at(-300)).not.toThrow());
  it('301s in the future → expired_timestamp', () => expectCode(at(-301), 'expired_timestamp'));
});

describe('S3.7 — a non-numeric timestamp never crashes, always 401', () => {
  const body = '';
  for (const ts of ['not-a-number', '', 'NaN', 'Infinity', '-Infinity', '1e400', '   ']) {
    it(`timestamp=${JSON.stringify(ts)}`, () => {
      const headers = signedHeaders({ body, timestamp: NOW });
      headers.set(TIMESTAMP_HEADER, ts);
      let thrown: unknown;
      try {
        verifyRequest('POST', headers, body, config);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConnectorError);
      expect([401]).toContain((thrown as ConnectorError).httpStatus);
    });
  }
});

describe('S3.8 — signature length/compare path', () => {
  it('correct length, wrong bytes → invalid_signature (timingSafeEqual path)', () => {
    const body = '{"x":1}';
    const headers = signedHeaders({ body, timestamp: NOW });
    const good = headers.get(SIGNATURE_HEADER)!;
    const flipped = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
    headers.set(SIGNATURE_HEADER, flipped);
    expectCode(() => verifyRequest('POST', headers, body, config), 'invalid_signature');
  });

  it('wrong length → invalid_signature, no throw from timingSafeEqual', () => {
    const headers = signedHeaders({ timestamp: NOW });
    headers.set(SIGNATURE_HEADER, 'v1=deadbeef');
    expect(() => verifyRequest('POST', headers, '', config)).not.toThrow(TypeError);
    expectCode(() => verifyRequest('POST', headers, '', config), 'invalid_signature');
  });
});

describe('S3.9 / S3.10 — secret rotation', () => {
  const rotating = { secret: TEST_SECRET, previousSecret: TEST_PREVIOUS_SECRET, clock };
  const body = '{"criteria":{"all":[]},"mapping":{}}';

  it('signed with previousSecret → accepted', () => {
    const headers = signedHeaders({ body, secret: TEST_PREVIOUS_SECRET, timestamp: NOW });
    expect(() => verifyRequest('POST', headers, body, rotating)).not.toThrow();
  });

  it('signed with an unrelated third secret → invalid_signature', () => {
    const headers = signedHeaders({ body, secret: OTHER_SECRET, timestamp: NOW });
    expectCode(() => verifyRequest('POST', headers, body, rotating), 'invalid_signature');
  });

  it('the active and the previous secret both verify (rotation overlap)', () => {
    const a = signedHeaders({ body, secret: TEST_SECRET, timestamp: NOW });
    const b = signedHeaders({ body, secret: TEST_PREVIOUS_SECRET, timestamp: NOW });
    expect(() => verifyRequest('POST', a, body, rotating)).not.toThrow();
    expect(() => verifyRequest('POST', b, body, rotating)).not.toThrow();
    // verifyRequest returns void on success — there is no channel by which
    // "which secret matched" could reach the wire.
    expect(verifyRequest('POST', a, body, rotating)).toBeUndefined();
    expect(verifyRequest('POST', b, body, rotating)).toBeUndefined();
  });

  it('previousSecret not configured + request signed with the old secret → invalid_signature', () => {
    const headers = signedHeaders({ body, secret: TEST_PREVIOUS_SECRET, timestamp: NOW });
    expectCode(() => verifyRequest('POST', headers, body, config), 'invalid_signature');
  });
});

describe('S3.11 — GET endpoints are not exempt from signing', () => {
  for (const path of ['/askdepth/v1/health', '/askdepth/v1/schema']) {
    it(`unsigned GET ${path} → unauthorized`, () => {
      expectCode(() => verifyRequest('GET', new Headers(), '', config), 'unauthorized');
    });
    it(`correctly signed GET ${path} → passes`, () => {
      const headers = signedHeaders({ method: 'GET', body: '', timestamp: NOW });
      expect(() => verifyRequest('GET', headers, '', config)).not.toThrow();
    });
  }

  it('a GET signature is computed over `${ts}.` (empty body)', () => {
    const secret = Buffer.from(TEST_SECRET, 'utf8');
    const headers = new Headers({
      [SIGNATURE_HEADER]: sign('', NOW, secret),
      [TIMESTAMP_HEADER]: String(NOW),
    });
    expect(() => verifyRequest('GET', headers, 'this body is ignored for GET', config)).not.toThrow();
  });
});

describe('S3.12 — replay inside the window is accepted again (documented v1 behaviour)', () => {
  it('the same authentic request verifies twice within 300s', () => {
    const body = '{"criteria":{"all":[]},"mapping":{}}';
    const headers = signedHeaders({ body, timestamp: NOW });
    const at5 = { secret: TEST_SECRET, clock: () => NOW + 5 };
    const at60 = { secret: TEST_SECRET, clock: () => NOW + 60 };
    expect(() => verifyRequest('POST', headers, body, at5)).not.toThrow();
    expect(() => verifyRequest('POST', headers, body, at60)).not.toThrow();
    // …and stops once the window has passed.
    const at400 = { secret: TEST_SECRET, clock: () => NOW + 400 };
    expectCode(() => verifyRequest('POST', headers, body, at400), 'expired_timestamp');
  });
});

describe('S3.13 — no verification-skip escape hatch in the build', () => {
  const distDir = resolve(__dirname, '..', 'dist');
  const built = existsSync(distDir);
  const FORBIDDEN = ['NODE_ENV', 'SKIP_SIGNATURE', 'DISABLE_AUTH', 'bypass'];

  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = join(dir, d.name);
      if (d.isDirectory()) return walk(p);
      return /\.(c?js|d\.c?ts)$/.test(d.name) ? [p] : [];
    });
  }

  it.skipIf(!built)('dist/ contains none of the skip-flag strings', () => {
    for (const file of walk(distDir)) {
      const text = readFileSync(file, 'utf8');
      for (const needle of FORBIDDEN) {
        expect(text.includes(needle), `${needle} found in ${file}`).toBe(false);
      }
    }
  });

  it('fails in CI if dist/ was not built before the test step', () => {
    if (process.env.CI) expect(built).toBe(true);
  });
});
