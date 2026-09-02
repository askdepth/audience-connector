import { z } from 'zod';

const CriterionSchema = z.discriminatedUnion('field', [
  z.object({
    field: z.literal('segment'),
    op: z.literal('in'),
    values: z.array(z.string()).min(1),
  }),
  z.object({
    field: z.literal('signupAt'),
    op: z.literal('between'),
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  z.object({
    field: z.literal('isActive'),
    op: z.literal('eq'),
    value: z.boolean(),
  }),
  z.object({
    field: z.literal('externalId'),
    op: z.literal('in'),
    values: z.array(z.string()).min(1),
  }),
  // attr.* is not a literal — validated by the .startsWith check below, not
  // by the discriminated union, since z.discriminatedUnion needs a literal
  // per branch and `attr.${string}` isn't one.
]);

const AttrCriterionSchema = z.object({
  field: z.string().refine((f) => f.startsWith('attr.'), 'must start with "attr."'),
  op: z.enum(['eq', 'in']),
  value: z.unknown().optional(),
  values: z.array(z.unknown()).optional(),
});

export const QuerySchema = z.object({
  all: z.array(z.union([CriterionSchema, AttrCriterionSchema])),
  suppressExternalIds: z.array(z.string()).optional(), // §4.4
  sample: z
    .object({ method: z.literal('random'), size: z.number().int().positive() })
    .optional(), // §4.5
});
export type Query = z.infer<typeof QuerySchema>;
