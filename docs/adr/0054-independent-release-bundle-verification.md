# ADR 0054: Independent release bundle verification

- Status: Accepted
- Date: 2026-08-03

## Context

The atomic release packager creates checksums, but producer success is not an
independent proof that the final directory is complete or internally
consistent. A packaging regression could create self-consistent checksums over
incorrect digest values or smoke evidence. Workflow artifacts also cross job
boundaries before becoming release assets.

## Decision

A dependency-free verifier reads the completed release directory after
packaging and before release-file attestation. It requires exactly the versioned
Helm chart, connector SDK archive, `IMAGE_DIGESTS.txt`, `IMAGE_SMOKE.jsonl`,
`values.digests.yaml`, and `SHA256SUMS`.

The verifier rejects symlinks, empty or oversized files, extra assets,
noncanonical or incomplete checksum records, and any streamed hash mismatch.
It independently parses the seven immutable image records, regenerates the
digest-pinned Helm values byte for byte, and validates the complete canonical
fourteen-record image-smoke manifest. Success emits one bounded
`BYOK_GRID_RELEASE_BUNDLE_VERIFIED` record.

Operators run the same command against downloaded assets from the matching
release source. Artifact attestations and registry scans remain separate proofs
of origin and vulnerability posture.

## Consequences

- Attestation cannot proceed for a bundle that fails independent verification.
- Checksums cannot legitimize semantically invalid release metadata.
- Downloaded releases have one reproducible machine-verification command.
- The verifier intentionally rejects directories containing unrelated files.
