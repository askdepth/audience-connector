// The postgres adapter compiles a QueryPlan into parameterised, read-only SQL
// over mapped columns only.
//
// Three independent guarantees, so no single mistake removes the safety:
//   (a) the builder can only emit SELECT — there is no code path that produces
//       INSERT/UPDATE/DELETE/DDL/`;`;
//   (b) every statement runs inside `BEGIN READ ONLY` / `COMMIT`;
//   (c) a transaction-local `statement_timeout` (set via a parameterised
//       `set_config(...)`) bounds each query to the request budget.
// Identifiers are allowlist-validated (`^[A-Za-z_][A-Za-z0-9_$]*$`) and quoted;
// values are *always* `$n` parameters, never interpolated.
//
// The client passes their own `pg.Pool`. This package never constructs one and
// never sees a connection string.

import type { Pool, PoolClient } from 'pg';
import { ConnectorError } from '../errors';
import type { Adapter, AdapterContext, CanonicalRow, SchemaResponse } from '../types';
import { encodeCursor, ROW_CAP, type PlannedFilter, type QueryPlan } from '../plan';

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const ORDER_ALIAS = '_askdepth_ord';
const ATTR_PREFIX = '_askdepth_attr_';

export interface PostgresAdapterOptions {
  /** The client's own connection pool. */
  pool: Pool;
  table: string;
  /** Postgres schema. Default `public`. */
  schema?: string;
  /** Source column for `externalId`, if the plan does not carry one. */
  externalIdColumn?: string;
  /** Hard ceiling for the per-query `statement_timeout`, ms. Default 60000. */
  maxStatementTimeoutMs?: number;
}

function assertIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`postgresAdapter: ${JSON.stringify(name)} is not a valid SQL identifier`);
  }
  return name;
}

const qi = (name: string): string => `"${assertIdent(name)}"`;

export function postgresAdapter(opts: PostgresAdapterOptions): Adapter {
  const schema = opts.schema ?? 'public';
  assertIdent(schema);
  assertIdent(opts.table);
  if (opts.externalIdColumn) assertIdent(opts.externalIdColumn);
  const relation = `${qi(schema)}.${qi(opts.table)}`;
  const maxTimeout = opts.maxStatementTimeoutMs ?? 60_000;

  function externalIdColumn(plan: QueryPlan): string {
    const col = plan.externalIdColumn || opts.externalIdColumn;
    if (!col) throw new ConnectorError('adapter_error');
    return assertIdent(col);
  }

  function statementTimeoutMs(ctx: AdapterContext): number {
    const budget = Number.isInteger(ctx.budgetMs) && ctx.budgetMs > 0 ? ctx.budgetMs : 30_000;
    // Fire ~100ms before the handler's own timer, so the DB cancels cleanly
    // (a 57014 leaves the connection reusable) rather than us dropping it.
    return Math.max(250, Math.min(budget - 100, maxTimeout));
  }

  async function withReadOnly<T>(
    ctx: AdapterContext,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let poisoned = false;
    const onAbort = () => {
      poisoned = true;
    };
    try {
      client = await opts.pool.connect();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      await client.query('BEGIN READ ONLY');
      // `set_config(..., is_local => true)` is the parameterised equivalent of
      // `SET LOCAL` — so the whole builder emits zero string-interpolated SQL,
      // even for this trusted clamped integer.
      await client.query('SELECT set_config($1, $2, true)', [
        'statement_timeout',
        String(statementTimeoutMs(ctx)),
      ]);
      const out = await run(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          poisoned = true;
        }
      }
      const code = (err as { code?: string } | null)?.code;
      if (code === '57014') throw new ConnectorError('timeout'); // statement_timeout
      if (err instanceof ConnectorError) throw err;
      // Never rethrow the raw driver error — it can carry host/DSN/params.
      throw new ConnectorError('adapter_error', err);
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      if (client) client.release(poisoned || undefined);
    }
  }

  function buildWhere(plan: QueryPlan, params: unknown[]): string {
    const extIdCol = externalIdColumn(plan);
    const clauses: string[] = [];

    for (const f of plan.filters as PlannedFilter[]) {
      const col = qi(f.column);
      if (f.kind === 'in') {
        clauses.push(`${col} = ANY($${params.push([...(f.values ?? [])])})`);
      } else if (f.kind === 'eq') {
        clauses.push(`${col} = $${params.push(f.value)}`);
      } else {
        clauses.push(`${col} >= $${params.push(f.from)} AND ${col} <= $${params.push(f.to)}`);
      }
    }

    if (plan.suppress.length > 0) {
      clauses.push(`NOT (${qi(extIdCol)}::text = ANY($${params.push([...plan.suppress])}))`);
    }

    return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  }

  function selectList(plan: QueryPlan): string {
    const parts: string[] = [];
    for (const s of plan.select) {
      if (s.canonical.startsWith('attr.')) {
        const name = s.canonical.slice('attr.'.length);
        parts.push(`${qi(s.column)} AS ${qi(ATTR_PREFIX + name)}`);
      } else {
        parts.push(`${qi(s.column)} AS ${qi(s.canonical)}`);
      }
    }
    return parts.join(', ');
  }

  function projectRow(raw: Record<string, unknown>, plan: QueryPlan): CanonicalRow {
    const row: CanonicalRow = {
      externalId: String(raw.externalId),
      email: String(raw.email ?? ''),
    };
    for (const s of plan.select) {
      if (s.canonical === 'externalId' || s.canonical === 'email') continue;
      if (s.canonical.startsWith('attr.')) {
        const name = s.canonical.slice('attr.'.length);
        const v = raw[ATTR_PREFIX + name];
        if (v !== undefined && v !== null) {
          row.attributes = { ...(row.attributes ?? {}), [name]: v };
        }
      } else {
        const v = raw[s.canonical];
        if (v !== undefined && v !== null) {
          (row as unknown as Record<string, unknown>)[s.canonical] = v;
        }
      }
    }
    return row;
  }

  return {
    kind: 'postgres',
    capabilities: ['externalIdIn', 'attributeFilters', 'dateRanges', 'randomSample'],

    assertColumnSafe(column: string): void {
      assertIdent(column);
    },

    async schema(ctx): Promise<SchemaResponse> {
      return withReadOnly(ctx, async (client) => {
        const res = await client.query(
          `SELECT column_name, data_type
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position`,
          [schema, opts.table],
        );
        return {
          columns: res.rows.map((r) => ({
            name: String(r.column_name),
            type: String(r.data_type),
          })),
        };
      });
    },

    async count(plan, ctx): Promise<number> {
      const params: unknown[] = [];
      const where = buildWhere(plan, params);
      const sql = `SELECT count(*)::bigint AS n FROM ${relation}${where}`;
      return withReadOnly(ctx, async (client) => {
        const res = await client.query(sql, params);
        return Number(res.rows[0].n);
      });
    },

    async search(plan, ctx) {
      const extIdCol = externalIdColumn(plan);
      const params: unknown[] = [];

      const cols = selectList(plan);
      const seedParam = `$${params.push(plan.seed)}`;
      // The postgres adapter has its own ordering key — Postgres `md5()` — and
      // stores its hex output in the cursor's `after.h`. It deliberately does
      // NOT use `plan.ts`'s `shuffleHash` (that is the in-memory path). Cursors
      // are adapter-scoped and never crossed between adapter kinds; only the
      // query-binding `qh` and the `seed` in the cursor are shared machinery.
      const orderExpr = `md5(${seedParam} || ${qi(extIdCol)}::text)`;

      let where = buildWhere(plan, params);
      if (plan.after) {
        const hP = `$${params.push(plan.after.h)}`;
        const idP = `$${params.push(plan.after.id)}`;
        const keyset = `(${orderExpr}, ${qi(extIdCol)}::text) > (${hP}, ${idP})`;
        where = where ? `${where} AND ${keyset}` : ` WHERE ${keyset}`;
      }

      const limit = Math.min(plan.limit ?? ROW_CAP, ROW_CAP);
      const limParam = `$${params.push(limit + 1)}`;
      const sql =
        `SELECT ${cols}, ${orderExpr} AS ${qi(ORDER_ALIAS)} ` +
        `FROM ${relation}${where} ` +
        `ORDER BY ${orderExpr}, ${qi(extIdCol)}::text ` +
        `LIMIT ${limParam}`;

      return withReadOnly(ctx, async (client) => {
        const res = await client.query(sql, params);
        const hasMore = res.rows.length > limit;
        const pageRows = res.rows.slice(0, limit);
        const rows = pageRows.map((r) => projectRow(r as Record<string, unknown>, plan));

        let nextCursor: string | undefined;
        if (hasMore && pageRows.length > 0) {
          const last = pageRows[pageRows.length - 1] as Record<string, unknown>;
          nextCursor = encodeCursor(
            { h: String(last[ORDER_ALIAS]), id: String(last.externalId) },
            plan.queryHash,
            plan.seed,
          );
        }
        return { rows, nextCursor };
      });
    },
  };
}
