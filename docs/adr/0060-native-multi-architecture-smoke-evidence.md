# ADR 0060: Native multi-architecture image-smoke evidence

- Status: Accepted
- Date: 2026-08-04
- Amends: ADR 0053

## Context

The release workflow executes every `linux/amd64` and `linux/arm64` image under
QEMU on an amd64 runner and packages fourteen digest-bound smoke records. That
is strong publication evidence, but it is not proof that both platform
manifests execute on their native hardware. Stable promotion therefore requires
native-host repetition. The previous runbook described manual single-image
commands, while the stable manifest accepted a hash and the generic release
smoke marker. No repository command proved that the retained native bundle
contained every published digest on both matching host architectures.

## Decision

Native image-smoke evidence uses two dependency-free commands:

- a host collector refuses non-Linux or unsupported Node.js hosts, checks the
  clean Git `HEAD` against the claimed candidate, checks the Docker server OS
  and architecture through structured `docker version` fields, and runs all
  seven exact release digests with the same isolation flags and deadline as the
  tag workflow;
- an offline combiner requires one canonical host record for each architecture,
  binds both to the candidate, release version, and digest-manifest hash,
  verifies all fourteen records against `IMAGE_SMOKE.jsonl`, and requires the
  two collections to finish within 24 hours.

Host records are exclusively created with mode `0600`. Diagnostics never copy
Docker stderr, registry/provider errors, hostnames, credentials, or input paths.
The combined artifact emits
`BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED`. Stable production evidence
requires that marker alongside `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED` so the
native proof and the attested publication proof remain distinct.

## Consequences

- A single successful image or one native architecture cannot close the gate.
- QEMU release evidence remains necessary but cannot impersonate native-host
  evidence.
- Docker OS/architecture fields and all image outputs are claims produced by
  the controlled collector; operators still retain host/runtime ownership and
  the immutable evidence artifacts for review.
- Any candidate, version, digest, target, platform, timestamp, or release-smoke
  mismatch fails without producing a combined success record.
