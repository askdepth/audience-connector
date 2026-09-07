// Shared test helper: a throwaway HTTP connector stub for the conformance
// client/CLI tests. Not a `*.test.ts` file, so vitest does not collect it.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verify } from '@askdepth/audience-contract';

const SIGNATURE_HEADER = 'x-askdepth-signature';
const TIMESTAMP_HEADER = 'x-askdepth-timestamp';

export interface StubConnector {
  url: string;
  requests: { method: string; path: string; signed: boolean }[];
  close(): Promise<void>;
}

export interface StubOptions {
  /**
   * When true (default) the stub verifies the signature like a real connector
   * and answers 401 to anything unsigned or badly signed. When false it
   * ignores signatures entirely and always answers 200 — the "unsigned-only"
   * connector from S1 test 4.
   */
  enforceSignature?: boolean;
}

/**
 * A loopback URL whose port had a listener that has since closed — connecting
 * to it fails with ECONNREFUSED. (Do not use port 1: it is on the Fetch spec
 * "bad ports" list and `fetch` refuses it before any connection attempt.)
 */
export async function unreachableUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export async function startStubConnector(
  secret: string,
  options: StubOptions = {},
): Promise<StubConnector> {
  const enforce = options.enforceSignature ?? true;
  const requests: StubConnector['requests'] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const sig = req.headers[SIGNATURE_HEADER] as string | undefined;
      const ts = req.headers[TIMESTAMP_HEADER] as string | undefined;
      requests.push({ method: req.method ?? '', path: req.url ?? '', signed: Boolean(sig && ts) });

      res.setHeader('content-type', 'application/json');

      if (enforce) {
        if (!sig || !ts) {
          res.statusCode = 401;
          res.end('{"error":"unsigned"}');
          return;
        }
        const signedBody = req.method === 'GET' || req.method === 'HEAD' ? '' : raw;
        const result = verify(signedBody, ts, sig, Buffer.from(secret, 'utf8'));
        if (!result.valid) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: result.reason ?? 'invalid_signature' }));
          return;
        }
      }

      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, contractVersion: '1.0.0', capabilities: [] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
