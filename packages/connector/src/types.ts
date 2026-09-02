// Config and adapter contracts. These types are the public seam a client
// touches when writing a custom adapter or typing their `createConnector`
// call; keep the surface small.

import type { CapabilityFlag } from '@askdepth/audience-contract';
import type { QueryPlan } from './plan';

/** A canonical result row — the connector's mapped, capped output shape. */
export interface CanonicalRow {
  externalId: string;
  email: string;
  name?: string;
  segment?: string;
  signupAt?: string;
  isActive?: boolean;
  contactable?: boolean;
  attributes?: Record<string, unknown>;
}

/** `GET /schema` payload — the client's real (postgres) or declared (rest)
 *  columns. Introspection breadth is independent of what `select` returns. */
export interface SchemaResponse {
  columns: Array<{ name: string; type: string }>;
}

/** Per-request execution context handed to every adapter method. The adapter
 *  never sees the raw HTTP request, the secret, or anything authorisation
 *  related — those are consumed in the handler before an adapter is reached. */
export interface AdapterContext {
  /** Aborted when the request's time budget expires. Adapters must observe it
   *  and stop work; the handler surfaces `timeout` (504) regardless. */
  signal: AbortSignal;
  mode: 'interactive' | 'background';
  /** The whole budget for this request, in milliseconds. */
  budgetMs: number;
}

export interface Adapter {
  readonly kind: 'postgres' | 'rest';
  /** Capabilities this adapter can serve, before the connector config narrows
   *  them. Never widened by config. */
  readonly capabilities: CapabilityFlag[];
  /** Optional construction-time guard: `createConnector` calls this for every
   *  mapped column / attribute name so an unsafe identifier fails at deploy,
   *  not at query time. The postgres adapter implements it (identifier
   *  allowlist); the rest adapter does not need to. */
  assertColumnSafe?(column: string): void;
  schema(ctx: AdapterContext): Promise<SchemaResponse>;
  count(plan: QueryPlan, ctx: AdapterContext): Promise<number>;
  search(
    plan: QueryPlan,
    ctx: AdapterContext,
  ): Promise<{ rows: CanonicalRow[]; nextCursor?: string }>;
}

/** Canonical field → the client's own column/key. This is the whitelist: a
 *  canonical field absent here does not exist as far as the connector is
 *  concerned (master §4.3). */
export type FieldMapping = Partial<Record<keyof CanonicalRow, string>>;

export interface ConnectorConfig {
  /** Active signing secret. */
  secret: string | Buffer;
  /** Previous secret, accepted during a rotation overlap (master §6.4). */
  previousSecret?: string | Buffer;
  adapter: Adapter;
  fieldMapping: FieldMapping;
  /** Attributes usable in criteria as `attr.*`. Filter-only unless also listed
   *  in `returnable`. `filterable` is capped at 10 (master §4.3). */
  attributes?: {
    filterable: string[];
    returnable?: string[];
  };
  /** Narrows the adapter's advertised capabilities. A flag set to `false` is
   *  removed; it cannot add a capability the adapter lacks. */
  capabilities?: Partial<Record<CapabilityFlag, boolean>>;
  /** Route prefix. Default `/askdepth/v1`. */
  basePath?: string;
  timeouts?: {
    interactiveMs?: number;
    backgroundMs?: number;
  };
  /** Test seam: current time in **seconds**. */
  clock?: () => number;
}

/** `ConnectorConfig` after defaults and validation are applied. Internal. */
export interface ResolvedConfig {
  secret: string | Buffer;
  previousSecret?: string | Buffer;
  adapter: Adapter;
  fieldMapping: FieldMapping;
  attributes: { filterable: string[]; returnable: string[] };
  capabilities: Partial<Record<CapabilityFlag, boolean>>;
  basePath: string;
  timeouts: { interactiveMs: number; backgroundMs: number };
  clock?: () => number;
}

export const DEFAULT_BASE_PATH = '/askdepth/v1';
export const DEFAULT_INTERACTIVE_MS = 5_000;
export const DEFAULT_BACKGROUND_MS = 30_000;
