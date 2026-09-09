import { z } from 'zod';
import { QuerySchema } from './criteria';
import { CAPABILITY_FLAGS } from './capabilities';
import { CanonicalFieldSchema } from './fields';

/**
 * The hard cap on rows returned by `POST /candidates/search`, and the ceiling
 * `SearchRequestSchema.limit` accepts. Added to the contract in 0.1.2 so the
 * platform can size its own page requests without hardcoding a second copy of
 * the number the connector's `plan.ts` already enforces.
 */
export const ROW_CAP = 1_000;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  contractVersion: z.string(), // semver
  capabilities: z.array(z.enum(CAPABILITY_FLAGS)),
});

export const SchemaResponseSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string() })),
});

export const CountRequestSchema = z.object({
  criteria: QuerySchema,
  mapping: z.record(z.string(), z.string()),
});
export const CountResponseSchema = z.object({ count: z.number().int().nonnegative() });

export const SearchRequestSchema = CountRequestSchema.extend({
  limit: z.number().int().positive().max(ROW_CAP), // hard cap, §6.3
  cursor: z.string().optional(),
  sample: z
    .object({ method: z.literal('random'), size: z.number().int().positive() })
    .optional(),
});

/**
 * A single candidate row as returned by `POST /candidates/search`.
 * Structurally identical to `CanonicalFieldSchema` — named separately so the
 * response side of the contract reads as a response, and so a future
 * divergence (a display-only field, say) has somewhere to land without
 * changing what a *request* means by a canonical field.
 */
export const CandidateRowSchema = CanonicalFieldSchema;

/**
 * `POST /candidates/search` response envelope.
 *
 * Added in contract package 0.1.2. Additive: it describes what the handler has
 * emitted since 0.1.0 and changes no wire behaviour. It exists so the
 * *platform* validates a third-party connector's response against the same
 * definition the connector was built from, instead of trusting `unknown`.
 *
 * The default (stripping) object mode is deliberate for the platform's use — an
 * unexpected extra key is dropped rather than propagated inward. Detecting an
 * unmapped column is a *conformance* concern and stays in the suite's own check
 * (negative case 3), which must not be weakened to lean on this schema.
 */
export const SearchResponseSchema = z.object({
  rows: z.array(CandidateRowSchema),
  nextCursor: z.string().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/**
 * The default route prefix a connector mounts under, and the placeholder the
 * platform's connect wizard offers when a client enters their endpoint URL.
 */
export const DEFAULT_BASE_PATH = '/askdepth/v1';

/**
 * The four endpoint subpaths, relative to the base path. Frozen so the platform
 * does not string-build them.
 */
export const ENDPOINTS = {
  health: '/health',
  schema: '/schema',
  count: '/candidates/count',
  search: '/candidates/search',
} as const;
