# GitHub hosted-state evidence — 2026-08-03

Audit time: `2026-08-03T16:16:41Z`. Scope: the public
`mherzog4/byok-grid` repository before promotion of the local release-candidate
commit. The audited remote default branch was `main` at
`a0ddc521f55f1959cb423958791b439ffb2e5262`.

## Passing hosted evidence

- The repository was public, active, and had Issues enabled.
- The `main` push CI run
  [`30811928973`](https://github.com/mherzog4/byok-grid/actions/runs/30811928973)
  completed successfully for the audited remote commit.
- GitHub secret scanning and push protection were enabled, and the open
  secret-alert count was zero.
- Dependabot version-update automation was active. Two open update PRs had
  passing CI; the TypeScript 7 and ESLint 10 major-version PRs failed their own
  compatibility checks and were not merged into `main`.

## Hosted gates not yet satisfied

- The remote contained only the ordinary CI workflow and GitHub's dynamic
  Dependabot update workflow. The local CodeQL/security and release workflows
  had not been promoted, so neither had hosted run evidence.
- Code scanning had no analysis. Dependabot vulnerability alerts, Dependabot
  security updates, and automated security fixes were disabled.
- No repository ruleset or `main` branch protection was configured.
- Actions allowed all actions and did not require SHA pinning at the repository
  policy layer. The local workflow sources pin third-party actions by full
  commit SHA, but the host did not enforce that invariant.
- The repository had no GitHub Releases. No seven-image release matrix,
  checksums, SBOM/provenance, or attestations had been published and verified.
- GitHub classified the remote root license as `Other`. The local candidate
  replaces the abbreviated notice with GNU's canonical AGPL-3.0 text; license
  detection must be rechecked after promotion.

This audit was read-only. It did not push the candidate, enable security
features, create a ruleset, publish a tag, or create a release.
