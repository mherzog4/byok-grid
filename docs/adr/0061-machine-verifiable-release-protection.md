# ADR 0061: Machine-verifiable release protection evidence

## Status

Accepted — 2026-08-04

## Context

Stable promotion required evidence for `release-tag-protection`, but that gate
accepted an empty marker array. A retained file could therefore claim ruleset
or GHCR protection without a repository-defined producer proving the actual
Git tag, release, and image identities. The publication workflow already
preflights and reads back version tags, but its process marker does not prove
the later repository protection configuration or signed tag binding.

## Decision

Provide a dependency-free, read-only verifier that:

- discovers active repository tag rules rather than trusting configured IDs;
- requires one no-bypass mutation rule and one exact owner-only creation rule
  for `refs/tags/v*`;
- confirms repository-level immutable releases and the immutable published RC;
- requires a GitHub-verified signed annotated tag that peels to the claimed
  candidate commit;
- reconstructs the exact seven-image inventory from the checksummed canonical
  `IMAGE_DIGESTS.txt` asset and reads every GHCR version tag at that digest;
- binds the retained output to the digest-manifest SHA-256, immutable release
  ID, and signed tag-object SHA;
- uses bounded, versioned, redirect-rejecting GitHub and OCI reads without
  logging credentials or provider response bodies; and
- creates one exclusive mode-`0600` evidence file carrying
  `BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED`.

Stable production evidence now requires that exact marker for
`release-tag-protection`.

## Consequences

- Stable promotion cannot rely on screenshots or an unstructured ruleset note.
- The verifier requires an administrator-readable GitHub token and a
  `read:packages` GHCR token, but neither credential enters the evidence.
- The evidence is a point-in-time state proof. GHCR digest identity remains
  authoritative because registry version tags are pointers unless the service
  independently exposes and enforces tag immutability.
- Any change to this verifier after an observed RC is a verifier change and
  therefore requires a new RC under the stable source-equivalence allowlist.
