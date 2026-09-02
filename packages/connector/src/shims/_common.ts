// Shared plumbing for the framework shims. Each shim is only an adaptation to
// and from the Web `Request`/`Response`; the single real hazard is body bytes,
// so that logic lives here.

export type Connector = { fetch: (request: Request) => Promise<Response> };

const BODYLESS = new Set(['GET', 'HEAD']);

// Framework-supplied framing headers that must not be forwarded verbatim onto
// the reconstructed Request — the runtime recomputes them from the body we set,
// and a stale value can make `new Request` throw.
const DROP_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

/** Build a Web `Request` from the pieces every framework can give us. `rawBody`
 *  must be the *exact bytes received* — re-serialised JSON breaks the HMAC. */
export function toWebRequest(args: {
  method: string;
  url: string;
  headers: Iterable<[string, string]>;
  rawBody: Uint8Array;
}): Request {
  const method = args.method.toUpperCase();
  const headers = new Headers();
  for (const [k, v] of args.headers) {
    if (DROP_HEADERS.has(k.toLowerCase())) continue;
    headers.append(k, v);
  }
  const init: RequestInit = { method, headers };
  if (!BODYLESS.has(method)) {
    // Pass the bytes through untouched.
    init.body = args.rawBody;
  }
  return new Request(args.url, init);
}

/** Flatten a Node-style header bag (string | string[] | undefined) to pairs. */
export function* headerPairs(
  bag: Record<string, string | string[] | number | undefined>,
): Iterable<[string, string]> {
  for (const [k, v] of Object.entries(bag)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const one of v) yield [k, String(one)];
    } else {
      yield [k, String(v)];
    }
  }
}

export interface PlainResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Read a Web `Response` into the plain shape a framework wants back. */
export async function toPlainResponse(response: Response): Promise<PlainResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

/** Collect a Node Readable stream into one Buffer. */
export function readStream(
  stream: AsyncIterable<Uint8Array | string>,
): Promise<Uint8Array> {
  return (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    }
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  })();
}
