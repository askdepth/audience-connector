# Conformance spec — v1

Written in P1, executed by the P3 conformance runner. This is the checklist a
client's connector implementation is graded against before it can activate
(master doc §7.1).

A connector **fails** conformance if it:

1. Answers an unsigned request.
2. Answers a request with an expired or malformed signature.
3. Returns unmapped columns.
4. Leaks credentials or row data in an error response.
5. Returns non-deterministic cursor pagination.
6. Exceeds the 1,000-row result cap.
7. Returns a non-random subsample when `randomSample` is advertised.
8. Exposes any write path.

A connector **must pass**, to activate:

1. `GET /health` returns 200 with a valid `HealthResponseSchema` body.
2. `GET /schema` returns `columns` (postgres) or the hand-declared schema (rest).
3. `POST /candidates/count` returns a non-negative integer for a valid query.
4. `POST /candidates/search` respects `limit` and returns a `cursor` when more
   rows exist.
5. `externalId IN [...]` criteria return the correct intersection.
6. Attribute filters (`attr.*`) filter without the attribute appearing in the
   response, unless separately mapped for display (§4.3).
7. `suppressExternalIds` excludes the named ids from results.
