// Fastify shim.
//
// A Fastify plugin that (1) installs a content-type parser keeping the raw
// buffer for `application/json`, so the exact signed bytes survive, and
// (2) registers a catch-all route delegating to `connector.fetch`.
//
//   app.register(fastifyPlugin(connector));

import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { headerPairs, toPlainResponse, toWebRequest, type Connector } from './_common';

export function fastifyPlugin(connector: Connector): FastifyPluginAsync {
  return async function askdepthFastifyPlugin(fastify): Promise<void> {
    // Keep the untouched bytes.
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req: FastifyRequest, body: Buffer, done: (err: Error | null, value?: unknown) => void) => {
        done(null, body);
      },
    );

    fastify.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
      const bodyBytes =
        req.body instanceof Buffer
          ? new Uint8Array(req.body)
          : typeof req.body === 'string'
            ? new TextEncoder().encode(req.body)
            : new Uint8Array();

      const host = req.headers.host ?? 'localhost';
      const request = toWebRequest({
        method: req.method,
        url: `${req.protocol}://${host}${req.url}`,
        headers: headerPairs(req.headers),
        rawBody: bodyBytes,
      });

      const { status, headers, body } = await toPlainResponse(await connector.fetch(request));
      reply.status(status);
      for (const [k, v] of Object.entries(headers)) reply.header(k, v);
      reply.send(body);
    });
  };
}
