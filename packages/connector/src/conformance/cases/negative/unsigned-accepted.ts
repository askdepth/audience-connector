// N1 — a connector FAILS conformance if it "answers an unsigned request"
// (docs/conformance-spec.md, negative item 1).
//
// ┌─ INVERTED POLARITY — READ THIS before "fixing" the pass/fail below ─────┐
// │ P1–P7 pass when the connector *answers correctly*. N1 is the opposite:  │
// │ it sends requests with NO signature and NO timestamp header, and it     │
// │ PASSES only when the connector REFUSES to answer every one — a 401 in   │
// │ the documented error envelope. A 2xx, any other status, or a 401 in the │
// │ wrong shape means the connector *answered an unsigned caller* → the     │
// │ case FAILS. This is intentional. Do not "align" it with the positive    │
// │ cases by inverting the result.                                          │
// │                                                                         │
// │ Both GET routes (`/health`, `/schema`) AND the POST data endpoints      │
// │ (`/candidates/count`, `/candidates/search`) are probed unsigned. An     │
// │ auth middleware that gates GET (or only `/health` / `/schema`) but      │
// │ leaves the data endpoints open is a false green on unauthenticated      │
// │ data access — so the POST probes are not optional.                      │
// └───────────────────────────────────────────────────────────────────────┘

import type { ConformanceCase } from '../../runner';
import { isDocumented401, excerpt } from './_shared';

// `verify-request.ts` runs before routing, so an unsigned request to any path
// must be rejected identically. Probing GET *and* the POST data endpoints
// guards against a connector that only gates a subset of routes.
const GUARDED_GET_PATHS = ['/health', '/schema'];
const GUARDED_POSTS: ReadonlyArray<{ path: string; body: unknown }> = [
  { path: '/candidates/count', body: { criteria: { all: [] }, mapping: {} } },
  { path: '/candidates/search', body: { criteria: { all: [] }, mapping: {}, limit: 10 } },
];

export const unsignedAcceptedCase: ConformanceCase = {
  id: 'N1',
  kind: 'negative',
  async run(client) {
    for (const path of GUARDED_GET_PATHS) {
      const res = await client.getUnsigned(path);
      const check = isDocumented401(res);
      if (!check.ok) {
        return {
          id: 'N1',
          pass: false,
          detail: `connector answered an unsigned GET ${path}: ${check.reason}; body was "${excerpt(res.bodyText)}"`,
        };
      }
    }

    for (const { path, body } of GUARDED_POSTS) {
      const res = await client.postUnsigned(path, body);
      const check = isDocumented401(res);
      if (!check.ok) {
        return {
          id: 'N1',
          pass: false,
          detail: `connector answered an unsigned POST ${path}: ${check.reason}; body was "${excerpt(res.bodyText)}"`,
        };
      }
    }

    return { id: 'N1', pass: true };
  },
};
