# ADR 0052: Machine-verifiable stable promotion evidence

- Status: Accepted
- Date: 2026-08-03

## Context

BYOK Grid has repository verifiers and environment-specific production drills,
but the stable gate was a prose checklist. A stable tag could therefore publish
with a missing drill record, an unobserved candidate, an accidental optional
adapter claim, or evidence gathered from different source revisions. Requiring
the evidence manifest to name its own containing commit would be impossible:
changing that SHA field changes the commit SHA again.

## Decision

Every stable version requires
`docs/evidence/<version>-production.json` using schema version 1. The closed
manifest binds one prerelease candidate commit and its digest-manifest hash to
the exact stable version. It requires all production gate IDs exactly once,
exact structured markers for repository-owned drills, content digests,
credential-free HTTPS references, canonical timestamps, a blocker-free
observation window of at least 24 hours, an in-window rollback test, and named
post-window operator acceptance.

Optional Airbyte and ClickHouse support is explicit. Each claimed adapter adds
one mandatory E2E evidence record; an unclaimed adapter cannot smuggle in an
ambiguous record.

The stable tag commit is allowed to follow the observed candidate because it
must add evidence and change prerelease version metadata. Release verification
uses Git ancestry and a closed path allowlist to prove that the intervening diff
contains only the root/lock/chart version contract, the versioned manifest,
the readiness ledger, and the supported-version security policy. Any runtime,
dependency, deployment, workflow, or verifier change requires a new RC and
observation window.

The verifier is dependency-free, rejects symbolic links and evidence files over
128 KiB, does not fetch references, and emits no supplied values on failure.
Stable release checkout fetches candidate history so ancestry is provable.
Prerelease verification does not require a production manifest.

## Consequences

- Stable promotion fails closed on incomplete, duplicated, mistimed, or
  revision-mismatched evidence.
- Evidence contents still require independent artifact retrieval, digest
  verification, and human assessment; schema validity cannot prove an external
  system behaved correctly.
- A release-only correction may add another allowlisted promotion commit.
- A code or release-machinery correction invalidates source equivalence and
  requires a new candidate.
- A deliberately invalid template documents the schema without manufacturing
  passing production evidence in the repository.
