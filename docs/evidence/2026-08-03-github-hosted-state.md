# GitHub hosted-state evidence — 2026-08-03

Post-promotion audit time: `2026-08-04T02:23:00Z`. Scope: the public
`mherzog4/byok-grid` repository after promotion and hosted repair of the
release-candidate source. The audited default branch was `main` at
`dfeebe2bc704d05c4c3599cc4dbfc1d8ddfdf3fc`.

## Passing hosted evidence

- The repository was public, active, had Issues enabled, and GitHub detected
  the root license as `AGPL-3.0`.
- The `main` push CI run
  [`30870858941`](https://github.com/mherzog4/byok-grid/actions/runs/30870858941)
  completed successfully in 10 minutes 29 seconds on the audited commit. It
  passed the locked install, migrations, formatting, release metadata, lint,
  TypeScript, Node and Rust tests, PostgreSQL compatibility tests, production
  Next.js build, signal drain, all seven production container builds,
  SQLite-only runtime assertions, connector SDK packaging, Compose and Helm
  validation, and dependency audit.
- The `main` push Security run
  [`30870858945`](https://github.com/mherzog4/byok-grid/actions/runs/30870858945)
  completed successfully on the same commit. The dependency-free workflow
  policy, CodeQL JavaScript/TypeScript, and CodeQL Rust jobs all passed. The
  open code-scanning alert count was zero. CodeQL alert
  [`#1`](https://github.com/mherzog4/byok-grid/security/code-scanning/1) was
  fixed in source and recorded by GitHub as `fixed`, not dismissed.
- The public dependency graph was producing Dependabot version-update pull
  requests. Dependabot vulnerability alerts and automated security-update
  pull requests were enabled, and the open vulnerability-alert count was zero.
- GitHub secret scanning and push protection were enabled, the open secret
  alert count was zero, and private vulnerability reporting was enabled.
- Repository Actions remained enabled for all action publishers but required
  every action and reusable workflow reference to use a full commit SHA. The
  repository's pre-install source verifier independently enforces immutable
  action and container references, permissions, triggers, timeouts,
  concurrency, and credential-free checkout.
- Active branch ruleset
  [`20346816`](https://github.com/mherzog4/byok-grid/rules/20346816) protects
  `main` without a bypass actor. It prevents deletion and force-pushes, requires
  pull requests and resolved review threads, requires current-base results from
  the GitHub Actions integration for `verify`, `Workflow policy`, both CodeQL
  languages, and `Dependency review`, and blocks CodeQL errors, warnings, and
  High-or-higher security alerts. The approval count is zero while the project
  has one maintainer.
- Active tag ruleset
  [`20346817`](https://github.com/mherzog4/byok-grid/rules/20346817) protects
  `refs/tags/v*` without a bypass actor and prevents release-tag update,
  deletion, and non-fast-forward movement after creation.

## Hosted gates not yet satisfied

- `Dependency review` runs only for pull requests. The protected pull request
  carrying this evidence record must pass that check before merge; until then,
  the dependency-review and end-to-end ruleset gate remains open.
- The repository has no GitHub Release. No seven-image release matrix,
  checksums, SBOM/provenance, release bundle, or attestations have been
  published and independently verified.
- The release-tag ruleset is active, but the strongest available GHCR tag
  immutability behavior must still be verified against the first candidate
  publication. Digest identity remains authoritative.

The audit did not create or push a release tag and did not publish a release.
