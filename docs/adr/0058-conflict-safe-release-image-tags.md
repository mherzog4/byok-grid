# ADR 0058: Conflict-safe release image version tags

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0053

## Context

The release workflow builds, scans, smokes, and attests seven images at immutable
digests before an aggregate job adds the human-readable application version tag.
That ordering prevents a failed image matrix entry from publishing an approved
version tag.

The aggregate job previously invoked `docker buildx imagetools create --tag`
unconditionally. OCI tags are mutable references, so rerunning the workflow
could move an existing version tag to a different digest even though repository
tags and GitHub Releases are immutable. A late conflict could also be discovered
after other image tags had already been created.

## Decision

Release image version tags use a dependency-free repository publisher with a
closed three-state policy:

- an absent tag is eligible for creation from the verified digest;
- an existing tag at the exact expected digest is an idempotent no-op;
- an existing tag at another digest is a release conflict and fails closed.

The publisher validates the exact `release-images.json` digest-record inventory
and preflights all seven registry tags before its first mutation. It rechecks an
absent tag immediately before creation and reads every created tag back through
the OCI Distribution API. It then revalidates the complete seven-tag set,
requiring every exact top-level `Docker-Content-Digest`. Unexpected responses,
timeouts, malformed data, and authorization failures are errors rather than
evidence that a tag is absent.

The GitHub token is not job-wide: it is passed only to the GHCR login and tag
publication steps. Provider failures are wrapped in fixed diagnostics so
credentials and response bodies are not written to logs. Repository workflow
concurrency serializes runs for one Git tag, but the digest manifest remains
authoritative because GHCR tag updates do not provide a portable
conditional-write primitive.

## Consequences

- Rerunning a release after identical image publication performs no tag writes.
- A pre-existing conflicting version tag blocks the complete tag set before
  publication begins.
- A concurrent tag change is checked immediately before creation and after the
  write, with the complete set checked once more before success; this narrows
  but does not claim to eliminate a registry-level race.
- `BYOK_GRID_RELEASE_IMAGE_TAGS_VERIFIED` records the created, existing, and
  total image counts after successful verification.
- Operators continue to deploy and attest the immutable digests in
  `IMAGE_DIGESTS.txt`, never the version tag alone.
