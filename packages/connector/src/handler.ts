// The Web-standard `Request → Response` router.
//
// Order of operations, and why it is this order:
//   1. read the raw body exactly once (re-serialising JSON changes bytes and
//      breaks the HMAC);
//   2. verify the signature — before routing, before body parsing, so an
//      unauthenticated caller cannot tell a 404 from a 400 from a parse error;
//   3. route on `basePath` + method;
//   4. validate the body against the frozen contract schemas;
//   5. run the adapter inside a time budget with a cancellable `AbortSignal`.

import {
  CONTRACT_VERSION,
  CountRequestSchema,
  SearchRequestSchema,
  HealthResponseSchema,
  type Query,
} from '@askdepth/audience-contract';
import { ConnectorError, toResponse } from './errors';
import { verifyRequest } from './verify-request';
import { buildPlan, ROW_CAP } from './plan';
import {
  DEFAULT_BASE_PATH,
  DEFAULT_BACKGROUND_MS,
  DEFAULT_INTERACTIVE_MS,
  type AdapterContext,
  type ConnectorConfig,
  type ResolvedConfig,
} from './types';

const MODE_HEADER = 'x-askdepth-mode';

export function createConnector(config: ConnectorConfig): {
  fetch: (request: Request) => Promise<Response>;
} {
  const resolved = resolveConfig(config);
  return { fetch: (request: Request) => handle(request, resolved) };
}

// Config problems fail loudly at construction, as plain Errors — they are for
// the operator reading a stack trace, never rendered to the wire.
const SPECIAL_CATEGORY =
  /(health|medical|diagnos|\bnhs\b|religio|\bfaith\b|political|ethnic|\brace\b|racial|sexual.?orientation|gender.?identity|biometr|genetic|trade.?union|disabilit)/i;

function resolveConfig(config: ConnectorConfig): ResolvedConfig {
  if (!config.adapter) throw new Error('createConnector: `adapter` is required');
  if (!config.secret) throw new Error('createConnector: `secret` is required');

  const basePath = config.basePath ?? DEFAULT_BASE_PATH;
  if (!basePath.startsWith('/')) {
    throw new Error('createConnector: `basePath` must start with "/"');
  }

  const fieldMapping = config.fieldMapping ?? {};
  const filterable = config.attributes?.filterable ?? [];
  const returnable = config.attributes?.returnable ?? [];

  if (filterable.length > 10) {
    throw new Error('createConnector: at most 10 filterable attributes are allowed (master §4.3)');
  }
  for (const r of returnable) {
    if (!filterable.includes(r)) {
      throw new Error(`createConnector: returnable attribute "${r}" is not in \`filterable\``);
    }
  }

  // Special-category data is refused at field mapping — no health, religion,
  // political opinion, sexual orientation, or biometric fields (privacy
  // invariants). Heuristic name match; a false positive is fixed by renaming
  // the column.
  const names = [
    ...Object.keys(fieldMapping),
    ...(Object.values(fieldMapping) as string[]),
    ...filterable,
    ...returnable,
  ];
  for (const name of names) {
    if (SPECIAL_CATEGORY.test(name)) {
      throw new Error(
        `createConnector: "${name}" looks like special-category data, which is refused at field mapping`,
      );
    }
  }

  // Adapter-specific identifier safety (postgres: the SQL identifier allowlist)
  // — fail at deploy, not at query time.
  if (config.adapter.assertColumnSafe) {
    for (const col of [...(Object.values(fieldMapping) as string[]), ...filterable, ...returnable]) {
      config.adapter.assertColumnSafe(col);
    }
  }

  return {
    secret: config.secret,
    previousSecret: config.previousSecret,
    adapter: config.adapter,
    fieldMapping,
    attributes: { filterable, returnable },
    capabilities: config.capabilities ?? {},
    basePath,
    timeouts: {
      interactiveMs: config.timeouts?.interactiveMs ?? DEFAULT_INTERACTIVE_MS,
      backgroundMs: config.timeouts?.backgroundMs ?? DEFAULT_BACKGROUND_MS,
    },
    clock: config.clock,
  };
}

async function handle(request: Request, config: ResolvedConfig): Promise<Response> {
  try {
    return await route(request, config);
  } catch (err) {
    return toResponse(err);
  }
}

async function route(request: Request, config: ResolvedConfig): Promise<Response> {
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const rawBody = hasBody ? await request.text() : '';

  // (2) authentication gate — nothing below runs for an unsigned caller.
  verifyRequest(method, request.headers, rawBody, config);

  // (3) routing — only now may the caller learn which routes exist.
  const url = new URL(request.url);
  if (!url.pathname.startsWith(config.basePath)) throw new ConnectorError('not_found');
  const sub = url.pathname.slice(config.basePath.length) || '/';

  switch (sub) {
    case '/health':
      requireMethod(method, 'GET');
      return json(healthBody(config), 200);

    case '/schema':
      requireMethod(method, 'GET');
      return runWithBudget(request, config, async (ctx) => {
        const schema = await config.adapter.schema(ctx);
        return json(schema, 200);
      });

    case '/candidates/count':
      requireMethod(method, 'POST');
      return handleCount(request, rawBody, config);

    case '/candidates/search':
      requireMethod(method, 'POST');
      return handleSearch(request, rawBody, config);

    default:
      throw new ConnectorError('not_found');
  }
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) throw new ConnectorError('method_not_allowed');
}

function advertisedCapabilities(config: ResolvedConfig): string[] {
  return config.adapter.capabilities.filter((c) => config.capabilities[c] !== false);
}

function healthBody(config: ResolvedConfig): unknown {
  return HealthResponseSchema.parse({
    ok: true,
    contractVersion: CONTRACT_VERSION,
    capabilities: advertisedCapabilities(config),
  });
}

function parseJsonBody(rawBody: string): Record<string, unknown> {
  try {
    const v = JSON.parse(rawBody);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new ConnectorError('malformed_request');
    }
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    throw new ConnectorError('malformed_request');
  }
}

function requireJsonContentType(request: Request): void {
  const ct = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.includes('application/json')) throw new ConnectorError('malformed_request');
}

/** A criterion type / sample the adapter does not advertise → the request
 *  fails with `unsupported_capability`, not a silent partial answer. */
function assertCapabilities(criteria: Query, advertised: string[], hasSample: boolean): void {
  const need = (flag: string) => {
    if (!advertised.includes(flag)) throw new ConnectorError('unsupported_capability');
  };
  for (const c of criteria.all) {
    if (c.field.startsWith('attr.')) need('attributeFilters');
    else if (c.field === 'externalId') need('externalIdIn');
    else if (c.field === 'signupAt') need('dateRanges');
  }
  if (hasSample) need('randomSample');
}

function planInputFor(config: ResolvedConfig, criteria: Query, requestMapping: Record<string, string>) {
  return {
    criteria,
    requestMapping,
    fieldMapping: config.fieldMapping,
    filterableAttributes: config.attributes.filterable,
    returnableAttributes: config.attributes.returnable,
  };
}

async function handleCount(
  request: Request,
  rawBody: string,
  config: ResolvedConfig,
): Promise<Response> {
  requireJsonContentType(request);
  const raw = parseJsonBody(rawBody);
  const parsed = CountRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError('malformed_request', parsed.error.issues);

  assertCapabilities(parsed.data.criteria, advertisedCapabilities(config), false);
  const plan = buildPlan(planInputFor(config, parsed.data.criteria, parsed.data.mapping));

  return runWithBudget(request, config, async (ctx) => {
    const count = await config.adapter.count(plan, ctx);
    return json({ count }, 200);
  });
}

async function handleSearch(
  request: Request,
  rawBody: string,
  config: ResolvedConfig,
): Promise<Response> {
  requireJsonContentType(request);
  const raw = parseJsonBody(rawBody);

  // Distinguish "over the hard cap" (limit_exceeded) from "not a valid limit
  // at all" (malformed_request) — the frozen schema would collapse both into a
  // parse failure.
  const rawLimit = raw.limit;
  if (typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > ROW_CAP) {
    throw new ConnectorError('limit_exceeded');
  }

  const parsed = SearchRequestSchema.safeParse(raw);
  if (!parsed.success) throw new ConnectorError('malformed_request', parsed.error.issues);

  const sample = parsed.data.sample ?? parsed.data.criteria.sample;
  assertCapabilities(parsed.data.criteria, advertisedCapabilities(config), Boolean(sample));

  const plan = buildPlan({
    ...planInputFor(config, parsed.data.criteria, parsed.data.mapping),
    limit: parsed.data.limit,
    cursor: parsed.data.cursor,
    sample,
  });

  return runWithBudget(request, config, async (ctx) => {
    const { rows, nextCursor } = await config.adapter.search(plan, ctx);
    const capped = rows.slice(0, plan.limit ?? ROW_CAP);
    return json({ rows: capped, nextCursor }, 200);
  });
}

async function runWithBudget<T>(
  request: Request,
  config: ResolvedConfig,
  fn: (ctx: AdapterContext) => Promise<T>,
): Promise<T> {
  const mode =
    (request.headers.get(MODE_HEADER) ?? '').toLowerCase() === 'background'
      ? 'background'
      : 'interactive';
  const budgetMs =
    mode === 'background' ? config.timeouts.backgroundMs : config.timeouts.interactiveMs;

  const ac = new AbortController();
  const ctx: AdapterContext = { signal: ac.signal, mode, budgetMs };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new ConnectorError('timeout'));
    }, budgetMs);
  });

  const work = fn(ctx);
  // If the timeout wins the race, `work` may settle (or reject) later; give it
  // a no-op handler so a late rejection is not reported as unhandled.
  work.catch(() => undefined);

  try {
    return await Promise.race([work, timeout]);
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    // A raw throw from the adapter — never rethrow it as-is (it may carry a
    // driver message or a DSN). Wrap; `toResponse` renders the fixed text.
    throw new ConnectorError('adapter_error', e);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
