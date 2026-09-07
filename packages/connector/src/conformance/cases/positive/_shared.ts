// Small helpers shared by the positive conformance cases. Kept intentionally
// tiny: a case file should still read top-to-bottom as "what the platform
// sends, and what a correct connector must answer".

import type { WireResponse } from '../../client';

/** Structural shape of a Zod `safeParse` failure — typed here so this file
 *  needs no direct `zod` dependency (the contract package owns that). */
type ParseError = { issues: Array<{ path: Array<PropertyKey>; message: string }> };

/**
 * Request `mapping` used by the search-shaped cases. Keys are the client's own
 * source columns (arbitrary labels here); values are canonical fields.
 *
 * Identity-only on purpose: `externalId` and `email` are the only two canonical
 * fields *every* conformant connector must map (`email` is non-optional in
 * `CanonicalFieldSchema`; every other field — `name`, `segment`, `signupAt`, …
 * — is `.optional()`). `conformance-spec.md` never requires a connector to map
 * an optional field, so a search-shaped positive case must not project one: a
 * connector that legitimately does not map `name` answers `malformed_request`
 * for a `name` projection target, and that is spec-correct behaviour, not a
 * conformance failure. Cases that need to prove a *display* projection do so
 * with their own tolerant probe.
 */
export const STANDARD_MAPPING: Record<string, string> = {
  src_external_id: 'externalId',
  src_email: 'email',
};

/** Flatten a Zod error into a single-line "path: message; …" string. */
export function formatIssues(error: ParseError): string {
  return error.issues
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Parse a wire body as JSON, or return a failure detail instead of throwing. */
export function readJson(res: WireResponse): { ok: true; body: any } | { ok: false; detail: string } {
  try {
    return { ok: true, body: res.json() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** `expected 200, observed <status>: <body excerpt>` — for a non-200 response. */
export function statusDetail(res: WireResponse, expected = 200): string {
  const excerpt = res.bodyText.length > 200 ? `${res.bodyText.slice(0, 200)}…` : res.bodyText;
  return `expected ${expected}, observed ${res.status}: ${excerpt}`;
}
