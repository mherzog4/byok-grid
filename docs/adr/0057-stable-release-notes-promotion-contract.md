# ADR 0057: Stable release notes promotion contract

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0052

## Context

ADR 0052 made stable promotion depend on an exact six-path diff from the
observed release candidate. Separately, release verification requires curated,
version-bound notes at `docs/releases/v<version>.md` for every tag, including a
stable tag.

Those requirements were contradictory for the first promotion from an RC. The
stable notes do not exist in the RC candidate, so omitting them fails release
verification. Adding them after the observation window fails the six-path
source-equivalence allowlist. No stable promotion commit could satisfy both
contracts.

## Decision

The exact promotion-only path set includes
`docs/releases/v<stable-version>.md`. Stable promotion must now change exactly
seven paths: the root and lockfile version entries, Helm chart metadata,
versioned production evidence manifest, production-readiness ledger, exact
stable release notes, and supported-version security policy.

The notes path is derived from the verified stable semantic version. General
documentation paths remain forbidden, as do all application, dependency,
container, chart template/value, workflow, deployment, and verifier changes.
The stable notes still pass the existing release-note structure and version
binding checks before the source-equivalence check runs.

## Consequences

- A stable promotion can satisfy both curated-note publication and candidate
  source equivalence.
- Omitting the exact stable notes file fails with a dedicated diagnostic.
- Notes for another version or changes to general documentation remain outside
  the closed allowlist.
- Runtime or release-machinery corrections still require a new RC and a new
  observation window.
