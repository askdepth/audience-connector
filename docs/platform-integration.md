# What the platform imports from `@askdepth/audience-contract`

The Askdepth platform talks to a deployed connector over HTTP: it signs
requests, sends `count` and `search`, parses responses and errors, and
paginates. Every fact it needs about the wire comes from
`@askdepth/audience-contract` — nothing is hardcoded a second time.

As of contract package **0.1.2** the platform-side client imports:

| export | module | what it is |
|---|---|---|
| `signedBodyFor(method, rawBody)` | `signing` | the body that gets signed for a method. **GET and HEAD sign the empty string** (so the signed payload is `${timestamp}.`); every other method signs the exact raw body. A GET that signs anything else fails every request with `401`, silently. |
| `SIGNATURE_HEADER` / `TIMESTAMP_HEADER` | `signing` | `x-askdepth-signature` / `x-askdepth-timestamp`. The signature header value is the return of `sign()` verbatim — it already includes the `v1=` prefix; do not add one. |
| `REPLAY_WINDOW_SECONDS` | `signing` | `300`. The ±window a timestamp is accepted in. An `expired_timestamp` response is worth retrying with a fresh timestamp; anything else is not. |
| `SearchResponseSchema` / `CandidateRowSchema` | `endpoints` | the `{ rows, nextCursor? }` envelope of `POST /candidates/search`. Validate a connector's response against this instead of trusting `unknown`. |
| `ROW_CAP` | `endpoints` | `1000`. The hard cap on rows per search page — size page requests against it. |
| `DEFAULT_BASE_PATH` | `endpoints` | `/askdepth/v1`. The default/placeholder route prefix for the connect wizard. |
| `ENDPOINTS` | `endpoints` | `{ health, schema, count, search }` subpaths, relative to the base path. |
| `CONNECTOR_ERROR_CODES` / `ConnectorErrorCode` / `ErrorResponseSchema` | `errors` | the closed set of twelve error codes and the `{ error: { code, message } }` envelope. Map `code` onto the platform's own error taxonomy. |

None of these change wire behaviour — they describe what the connector has
emitted since `0.1.0`.

## `sample` precedence in a search request

`SearchRequestSchema` accepts `sample` in **two** places:

- top level: `{ …, sample: { method: 'random', size } }`
- inside `criteria`: `{ criteria: { …, sample: { method: 'random', size } } }`

When both are present the connector uses **the top-level field**;
`criteria.sample` is only a fallback. The handler resolves it as
`parsed.data.sample ?? parsed.data.criteria.sample`. Send the sample at the top
level; treat `criteria.sample` as a compatibility fallback, not a second knob.
