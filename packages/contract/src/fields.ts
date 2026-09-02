import { z } from 'zod';

export const CanonicalFieldSchema = z.object({
  externalId: z.string().min(1),
  email: z.string().email(),
  name: z.string().optional(),
  segment: z.string().optional(),
  signupAt: z.string().datetime().optional(),
  isActive: z.boolean().optional(),
  contactable: z.boolean().optional(), // §5.2 — required only when mapped
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type CanonicalField = z.infer<typeof CanonicalFieldSchema>;
