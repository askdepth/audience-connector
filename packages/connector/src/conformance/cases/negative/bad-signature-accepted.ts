// N2 — a connector FAILS conformance if it "answers a request with an expired
// or malformed signature" (docs/conformance-spec.md, negative item 2).
//
// ┌─ INVERTED POLARITY — READ THIS before "fixing" the pass/fail below ─────┐
// │ Like N1, N2 PASSES only when the connector REFUSES. It sends two kinds  │
// │ of bad request against each input endpoint:                            │
// │   1. a byte-wrong signature — well-formed `v1=<64 hex>`, does not       │
// │      verify (`postWithBadSignature`);                                   │
// │   2. a signature computed CORRECTLY over the body, but over a timestamp │
// │      ~1000s in the past — well-formed yet outside the ±300s replay      │
// │      window, i.e. "expired" (`postWithExpiredSignature`).              │
// │ Both must come back as a 401 in the documented error envelope. Anything │
// │ else means the connector *answered* a badly-signed caller → FAIL.      │
// └───────────────────────────────────────────────────────────────────────┘

import type { ConformanceCase } from '../../runner';
import { isDocumented401, excerpt } from './_shared';

// Body shape is irrelevant here — every request is rejected at the signature
// gate, before the body is parsed or the route is chosen.
const PROBE_BODY = { criteria: { all: [] }, mapping: {} };
const PROBE_PATHS = ['/candidates/count', '/candidates/search'];

export const badSignatureAcceptedCase: ConformanceCase = {
  id: 'N2',
  kind: 'negative',
  async run(client) {
    for (const path of PROBE_PATHS) {
      const wrongBytes = await client.postWithBadSignature(path, PROBE_BODY);
      const c1 = isDocumented401(wrongBytes);
      if (!c1.ok) {
        return {
          id: 'N2',
          pass: false,
          detail: `connector answered POST ${path} carrying a byte-wrong signature: ${c1.reason}; body was "${excerpt(wrongBytes.bodyText)}"`,
        };
      }

      const expired = await client.postWithExpiredSignature(path, PROBE_BODY);
      const c2 = isDocumented401(expired);
      if (!c2.ok) {
        return {
          id: 'N2',
          pass: false,
          detail: `connector answered POST ${path} carrying a well-formed but expired (out-of-window) signature: ${c2.reason}; body was "${excerpt(expired.bodyText)}"`,
        };
      }
    }
    return { id: 'N2', pass: true };
  },
};
