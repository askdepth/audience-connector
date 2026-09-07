import { describe, it, expect, afterEach } from 'vitest';
import { verify } from '@askdepth/audience-contract';
import { createConformanceClient } from '../src/conformance/client';
import { startStubConnector, unreachableUrl, type StubConnector } from './_conformance-stub';

const SECRET = 'conformance-client-secret';

let stub: StubConnector | undefined;
afterEach(async () => {
  await stub?.close();
  stub = undefined;
});

describe('S1 conformance client — pure over-the-wire', () => {
  it('client.get(/health) succeeds against a signed-and-verifying stub', async () => {
    stub = await startStubConnector(SECRET);
    const client = createConformanceClient({ url: stub.url, secret: SECRET });

    const res = await client.get('/health');

    expect(res.status).toBe(200);
    expect(res.json<{ ok: boolean }>().ok).toBe(true);
    expect(stub.requests.at(-1)).toMatchObject({ method: 'GET', path: '/health', signed: true });
  });

  it('client.get(/health) is structurally fine against an unsigned-only stub (client enforces nothing)', async () => {
    stub = await startStubConnector(SECRET, { enforceSignature: false });
    const client = createConformanceClient({ url: stub.url, secret: SECRET });

    const res = await client.get('/health');

    expect(res.status).toBe(200);
  });

  it('getUnsigned(path) omits both signature headers — asserted on the outgoing request', async () => {
    const seen: { url: string; method: string; headers: Headers }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createConformanceClient({
      url: 'http://stub.local/askdepth/v1',
      secret: SECRET,
      fetchImpl,
    });

    await client.getUnsigned('/health');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://stub.local/askdepth/v1/health');
    expect(seen[0].headers.has('x-askdepth-signature')).toBe(false);
    expect(seen[0].headers.has('x-askdepth-timestamp')).toBe(false);

    // Contrast: the signed variant through the same client DOES carry them —
    // proves the assertion above is meaningful.
    await client.get('/health');
    expect(seen[1].headers.get('x-askdepth-signature')).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(Number(seen[1].headers.get('x-askdepth-timestamp'))).toBeGreaterThan(0);
  });

  it('postWithBadSignature sends a well-formed signature that does not verify', async () => {
    let captured: { sig: string | null; ts: string | null; body: string } | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      captured = {
        sig: headers.get('x-askdepth-signature'),
        ts: headers.get('x-askdepth-timestamp'),
        body: String(init?.body ?? ''),
      };
      return new Response('{"error":"invalid_signature"}', { status: 401 });
    };
    const client = createConformanceClient({ url: 'http://stub.local', secret: SECRET, fetchImpl });

    await client.postWithBadSignature('/candidates/count', { criteria: { all: [] }, mapping: {} });

    expect(captured).toBeDefined();
    expect(captured!.sig).toMatch(/^v1=[0-9a-f]{64}$/); // correctly formatted
    const result = verify(captured!.body, captured!.ts!, captured!.sig!, Buffer.from(SECRET, 'utf8'));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('mismatch'); // well-formed but wrong, not 'malformed'
  });

  it('post(path, body) signs over the exact JSON body it sends', async () => {
    let captured: { sig: string | null; ts: string | null; body: string; ct: string | null } | undefined;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      captured = {
        sig: headers.get('x-askdepth-signature'),
        ts: headers.get('x-askdepth-timestamp'),
        ct: headers.get('content-type'),
        body: String(init?.body ?? ''),
      };
      return new Response('{}', { status: 200 });
    };
    const client = createConformanceClient({ url: 'http://stub.local', secret: SECRET, fetchImpl });

    await client.post('/candidates/count', { criteria: { all: [] }, mapping: {} });

    expect(captured!.ct).toBe('application/json');
    const result = verify(captured!.body, captured!.ts!, captured!.sig!, Buffer.from(SECRET, 'utf8'));
    expect(result.valid).toBe(true);
  });

  it('a refused connection surfaces as ConnectionError, not a raw fetch failure', async () => {
    const dead = await unreachableUrl();
    const client = createConformanceClient({ url: dead, secret: SECRET, timeoutMs: 2000 });
    await expect(client.get('/health')).rejects.toMatchObject({ name: 'ConnectionError' });
  });
});
