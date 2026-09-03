# Askdepth Audience SDK

**We query you.** A research on the Askdepth platform asks *your* connector for
eligible respondents. The connector runs inside your infrastructure, against your
database, and answers with counts and a capped, column-mapped, read-only result
set. Your raw data and your database credentials never leave your perimeter.

This repository is a **pnpm workspace**. It ships the wire contract and the
connector package; a reference connector lands next as a sibling package under
`packages/`.

- **Deploying a connector:** [`docs/deployment.md`](docs/deployment.md)
- **Runtime matrix:** [`docs/runtime-support.md`](docs/runtime-support.md)
- **Conformance coverage:** [`docs/conformance-self-check.md`](docs/conformance-self-check.md)
  maps every [`docs/conformance-spec.md`](docs/conformance-spec.md) case to its tests.

## Packages

| Package | Status | Role |
|---|---|---|
| [`@askdepth/audience-contract`](packages/contract) | v0.1.0 | zod schemas for the wire format, the AND-only criteria DSL, capability flags, the HMAC-SHA256 signing/verification helper, and version-negotiation logic. Imported by both the connector and the platform. Source published. |
| [`@askdepth/audience-connector`](packages/connector) | v0.1.0 | the deployable connector: a Web-standard `Request → Response` handler, mandatory HMAC verification, the four endpoints, `postgres` + `rest` adapters, and Express/Fastify/Lambda shims. Zero runtime dependencies in core. |
| reference connector | planned | a real connector over a seeded synthetic user base — CI fixture, demo, reference implementation. |

## Runtimes

The multi-runtime claim is demonstrated in CI, not asserted. See
[`docs/runtime-support.md`](docs/runtime-support.md) for the per-runtime
evidence. Summary: **Node.js**, **Next.js** route handlers, **Google Cloud
Functions gen2**, **Deno** and **Bun** are verified; **Cloudflare Workers** is
verified with the `nodejs_compat` flag (the contract's signer uses
`node:crypto`).

## Where the platform side lives

The code that *calls* a connector — the Askdepth platform side — lives in a
separate repository. This repo is the client-deployed connector and the shared
wire contract only.

## Publishing

`@askdepth/audience-contract` is published **only** by the tag-driven
`.github/workflows/release.yml` (push a `v*` tag). That workflow publishes with
npm provenance via GitHub Actions OIDC. **Do not `npm publish` from a local
machine** — provenance attestation is tied to the workflow, and a local publish
silently turns it off. The version in `packages/contract/package.json` and the
git tag must agree.

The **first ever** publish of the package is a one-time manual step by the npm
org owner (`npm login` + `npm publish --access public --provenance`), because npm
Trusted Publishing can only be configured on a package that already exists on the
registry. Every publish after that goes through the workflow.

## Contributing

Changes go through a feature branch and a pull request. The wire contract in
`@askdepth/audience-contract` is versioned: any change to the request/response
bodies, the criteria DSL, the signing scheme, or the capability flags is a
released breaking change — every deployed connector must redeploy — not a
routine commit.
