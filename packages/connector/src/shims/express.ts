// Express shim.
//
// The one hazard: Express with `express.json()` has already parsed and
// discarded the raw body, and re-stringifying it changes bytes so every
// signature fails. This shim therefore needs the raw bytes and refuses,
// loudly, if it can only see a parsed body:
//
//   app.use(express.raw({ type: 'application/json' }));   // <- required
//   app.all('/askdepth/*', expressHandler(connector));
//
// or capture `req.rawBody` yourself via an `express.json({ verify })` callback.

import type { Request as ExpressRequest, Response as ExpressResponse, RequestHandler } from 'express';
import { headerPairs, readStream, toPlainResponse, toWebRequest, type Connector } from './_common';

const PARSED_BODY_MESSAGE =
  'audience-connector: the Express request body was already parsed (express.json()?), ' +
  'so the exact signed bytes are gone and every signature would fail. Mount ' +
  '`express.raw({ type: "application/json" })` before this handler, or capture the raw ' +
  'bytes as `req.rawBody` via an `express.json({ verify })` callback.';

function looksParsed(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (Buffer.isBuffer(body) || typeof body === 'string') return false;
  // express.json() leaves `{}` for an empty/absent body and an object/array otherwise.
  return typeof body === 'object';
}

async function rawBytesOf(req: ExpressRequest): Promise<Uint8Array> {
  const withRaw = req as ExpressRequest & { rawBody?: unknown };
  if (Buffer.isBuffer(withRaw.rawBody)) return new Uint8Array(withRaw.rawBody);
  if (Buffer.isBuffer(req.body)) return new Uint8Array(req.body);
  if (typeof req.body === 'string') return new TextEncoder().encode(req.body);
  if (looksParsed(req.body)) throw new Error(PARSED_BODY_MESSAGE);
  // No body parser mounted — the stream is still ours to read.
  return readStream(req as unknown as AsyncIterable<Uint8Array>);
}

export function expressHandler(connector: Connector): RequestHandler {
  return function askdepthExpressHandler(req: ExpressRequest, res: ExpressResponse): void {
    void (async () => {
      try {
        const rawBody =
          req.method === 'GET' || req.method === 'HEAD'
            ? new Uint8Array()
            : await rawBytesOf(req);

        const host = req.headers.host ?? 'localhost';
        const request = toWebRequest({
          method: req.method,
          url: `${req.protocol}://${host}${req.originalUrl}`,
          headers: headerPairs(req.headers),
          rawBody,
        });

        const { status, headers, body } = await toPlainResponse(await connector.fetch(request));
        res.status(status);
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.send(body);
      } catch (err) {
        // A misconfiguration (parsed body) surfaces here on the first request,
        // naming the cause — never a silent 401 storm. This is a deploy-time
        // shim error, deliberately descriptive; it is not a connector wire
        // error and carries no request data.
        const message = err instanceof Error ? err.message : 'shim error';
        console.error(`[audience-connector/express] ${message}`);
        res.status(500).setHeader('content-type', 'application/json');
        res.send(JSON.stringify({ error: { code: 'shim_misconfigured', message } }));
      }
    })();
  };
}
