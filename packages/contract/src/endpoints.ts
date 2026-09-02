import { z } from 'zod';
import { QuerySchema } from './criteria';
import { CAPABILITY_FLAGS } from './capabilities';

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
  limit: z.number().int().positive().max(1000), // hard cap, §6.3
  cursor: z.string().optional(),
  sample: z
    .object({ method: z.literal('random'), size: z.number().int().positive() })
    .optional(),
});
