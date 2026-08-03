# ADR 0053: Digest-bound multi-architecture image smoke

- Status: Accepted
- Date: 2026-08-03

## Context

The release workflow built OCI indexes for `linux/amd64` and `linux/arm64`, but
successful layer production and manifest inspection did not prove that each
platform-specific entrypoint could execute. Native dependencies, executable
format, copied runtime files, or target-specific entrypoints could fail only
after publication. Full application startup cannot be used as a generic image
smoke because it requires deployment secrets and external state.

## Decision

Every release target implements `--image-smoke`. It loads the packaged runtime
or application module graph, performs no external or persistent work, and emits
one exact target-bound marker. Normal entrypoint configuration behavior is
unchanged.

After an image is pushed and scanned at its immutable digest, the release matrix
runs that digest for both supported platforms under QEMU where necessary. The
container has no network, a read-only root, no Linux capabilities, no privilege
escalation, a process limit, and a 30-second deadline. A dependency-free bounded
parser binds the inner response to target, platform, and digest and creates two
JSONL evidence records per image. Those artifacts are uploaded before image
attestation and version-tag publication can proceed.

The shared TypeScript worker image disables the `tsx` disk cache. This makes
its entrypoints independent of a writable `/tmp` and preserves the read-only
smoke boundary without granting a test-only filesystem exception.

Stable promotion still requires native `amd64` and native `arm64` confirmation;
emulation is strong release-CI evidence but not proof of host-specific runtime
behavior.

## Consequences

- A broken platform image blocks the complete image matrix before any version
  tag is created.
- Smoke mode becomes a small public image contract and must remain
  side-effect-free.
- The release workflow produces structured evidence that can be hashed into the
  stable promotion manifest.
- External-service and full deployment startup remain separate gates.
