// Public surface of @askdepth/audience-connector.
//
// Every export here is a compatibility obligation once the package is
// published. Kept deliberately small.
//   S4  createConnector + config/adapter types  ← here
//   S6  postgresAdapter
//   S7  restAdapter
//   S8  expressHandler / fastifyPlugin / lambdaHandler (subpath exports)

export { createConnector } from './handler';
export { postgresAdapter, type PostgresAdapterOptions } from './adapters/postgres';
export {
  restAdapter,
  type RestAdapterOptions,
  type RestQuery,
  type RestFetchContext,
  type RestFetchResult,
} from './adapters/rest';

export type {
  ConnectorConfig,
  Adapter,
  AdapterContext,
  FieldMapping,
  CanonicalRow,
  SchemaResponse,
} from './types';

export type {
  QueryPlan,
  MappedColumn,
  PlannedFilter,
  FilterKind,
  CursorState,
} from './plan';

// Re-exported so a consumer can type `capabilities` / read the wire version
// without adding a direct dependency on the contract package.
export { CONTRACT_VERSION } from '@askdepth/audience-contract';
export type { CapabilityFlag } from '@askdepth/audience-contract';
