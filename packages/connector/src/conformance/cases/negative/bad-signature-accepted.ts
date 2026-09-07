// N2 — a connector FAILS conformance if it "answers a request with an expired
// or malformed signature" (docs/conformance-spec.md, negative item 2).
//
// ┌─ INVERTED POLARITY — READ THIS before "fixing" the pass/fail below ─────┐
// │ Like N1, N2 PASSES only when the connector REFUSES. It sends two kinds  │
// │ of bad request against each input endpoint:                            │
// │   1. a byte-wrong signature — well-formed `v1=<64 hex>`, does not       │
// │      verify (`postWithBadSignature`);                                   │
// │   2. signatures computed CORRECTLY over the body, but over a timestamp  │
// │      outside the ±300s replay window — well-formed yet "expired".       │
// │      Probed at THREE skews: ~330s in the past (just outside the         │
// │      window), ~1000s in the past (well outside), and ~330s in the       │
// │      future (`postWithSkewedSignature`). The ~330s probes exercise the  │
// │      boundary: a connector with a lax window (say ±600s) rejects the    │
// │      1000s probe yet accepts a 330s-stale replay, and would otherwise   │
// │      pass N2 while being non-conformant.                               │
// │ Every probe must come back as a 401 in the documented error envelope.  │
// │ Anything else means the connector *answered* a badly-signed caller →   │
// │ FAIL, with a `detail` naming which probe it answered.                  │
// └───────────────────────────────────────────────────────────────────────┘

import type { ConformanceCase } from '../../runner';
import { isDocumented401, excerpt } from './_shared';

// Body shape is irrelevant here — every request is rejected at the signature
// gate, before the body is parsed or the route is chosen.
const PROBE_BODY = { criteria: { all: [] }, mapping: {} };
const PROBE_PATHS = ['/candidates/count', '/candidates/search'];

// The contract's replay window is ±300s (verify-request.ts). `skew` is the
// number of seconds SUBTRACTED from `now` when the signature is minted:
// positive → timestamp in the past, negative → timestamp in the future. The
// ±330s probes sit just outside the window; 1000s is far outside it.
const SKEW_PROBES: ReadonlyArray<{ skew: number; label: string }> = [
  { skew: 330, label: 'timestamped ~330s in the past (just outside the +300s replay window)' },
  { skew: 1000, label: 'timestamped ~1000s in the past (well outside the replay window)' },
  { skew: -330, label: 'timestamped ~330s in the future (just outside the -300s replay window)' },
];

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

      for (const { skew, label } of SKEW_PROBES) {
        const res = await client.postWithSkewedSignature(path, PROBE_BODY, skew);
        const check = isDocumented401(res);
        if (!check.ok) {
          return {
            id: 'N2',
            pass: false,
            detail: `connector answered POST ${path} carrying a well-formed signature ${label}: ${check.reason}; body was "${excerpt(res.bodyText)}"`,
          };
        }
      }
    }
    return { id: 'N2', pass: true };
  },
};
