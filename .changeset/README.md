# Changesets

This folder holds pending release notes for publishable packages
(`@askdepth/audience-contract`, `@askdepth/audience-connector`).

## For contributors

1. After changing a publishable package, run:

   ```bash
   pnpm changeset
   ```

2. Select the affected package(s), the bump type (`patch` / `minor` / `major`),
   and write a short changelog summary.
3. Commit the generated `.changeset/<name>.md` with your PR.

Infrastructure-only PRs (docs, CI, examples) can skip this by adding the
`skip-changeset` label.

## Release flow

- Feature work merges into `dev`, then `dev` into `main`.
- On every push to `main`, `.github/workflows/release.yml` either opens/updates
  the `chore(release): version packages` PR, or publishes when that PR is merged.
- Do not publish from a local machine — npm provenance is tied to GitHub Actions.

See the root README “Publishing” section for details.
