# ADR 0059: Idempotent immutable GitHub Release publication

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0054

## Context

GitHub CLI release creation is a multi-request operation: it creates a draft,
uploads assets, and then publishes the release. Repository immutability protects
the associated tag and assets only after publication. The workflow independently
reads the published release back and verifies its immutable metadata and exact
asset bytes.

The previous workflow invoked `gh release create` unconditionally. If GitHub
successfully published the release but the subsequent API readback failed
transiently, rerunning the exact workflow stopped because the immutable release
already existed. The release might be correct, but the retry could not complete
the repository's own verification contract. Treating every failed lookup as
absence would be worse because authorization, rate-limit, or provider failures
could trigger an unsafe creation attempt.

## Decision

GitHub Release publication uses a dependency-free repository command with a
closed state machine:

- the Helm chart is packaged from a link-free, sorted staging copy with fixed
  timestamps, and hosted integration tests require two real Helm/npm builds to
  produce the same six asset bytes;
- the complete local six-asset bundle is independently verified before API
  access or mutation;
- only an authenticated `404` from the exact tag endpoint means absent;
- an absent release is created once through `gh release create --verify-tag`;
- an existing release is accepted without mutation only when the existing
  verifier proves it is published, immutable, version-bound, note-identical,
  and byte-identical for the exact closed asset set;
- unexpected statuses, timeouts, malformed or oversized responses, drafts,
  mutable releases, and metadata or digest conflicts fail closed.

After a creation command reports failure, the publisher performs bounded
readback. It may recover only if an exact immutable release appeared, covering
the case where publication succeeded but the client lost the final response.
The verified API response is recorded with exclusive creation and passed to a
separate workflow step that runs the immutable published-release verifier again.
Credentials remain scoped to the publication step, and provider output is not
copied into diagnostics.

## Consequences

- A workflow rerun after complete publication performs no release mutation and
  can still finish the independent verification contract.
- A remote release can never be accepted merely because its tag exists.
- Partial draft recovery remains an explicit operator action; automation does
  not edit or delete drafts.
- A correction to any published immutable byte requires a new release-candidate
  version rather than replacement.
- `BYOK_GRID_GITHUB_RELEASE_PUBLICATION_VERIFIED` records created, existing,
  recovered, immutable, and version state before the independent final marker.
