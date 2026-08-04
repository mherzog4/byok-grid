# ADR 0062: Require anonymous GHCR access before release publication

## Status

Accepted.

## Context

GHCR creates a personal-account container package with private visibility on
its first push. A package linked to a public repository inherits repository
access permissions, but not public visibility. The release workflow previously
verified version-tag digests using `GITHUB_TOKEN`, so a correct but private
package could satisfy every registry check while an open-source installer could
not pull it.

GitHub documents package visibility changes through the package settings UI.
Making a package public is irreversible, and the supported Packages REST API
does not expose a visibility mutation for this bootstrap operation.

## Decision

The aggregate image-publication job retains its authenticated, conflict-safe
version-tag publisher. Immediately afterward it runs a separate dependency-free
verifier that accepts no registry credential. For each of the exact seven
release records, the verifier:

1. obtains an anonymous GHCR pull token;
2. reads the version tag with an OCI `HEAD` request;
3. reads the immutable digest reference with a second `HEAD` request; and
4. requires both `Docker-Content-Digest` headers to equal the checksummed
   release digest.

The GitHub Release job depends on this result. On the first release, the initial
run can create private commit-scoped packages and version tags but stops before
creating a GitHub Release. The owner changes all seven packages to public in the
GitHub UI, then reruns the same idempotent workflow. Subsequent releases pass in
one run while the packages remain public.

The post-publication release-protection verifier performs the anonymous checks
again alongside its authenticated digest checks. Stable evidence therefore
cannot be produced from private packages.

## Consequences

- Open-source consumers receive a machine-proven anonymous pull path.
- Registry credentials cannot conceal private package visibility.
- First-release bootstrap requires seven explicit, irreversible owner actions
  after the packages exist.
- A first attempt may expose public version tags briefly before the GitHub
  Release is created; the immutable digest manifest remains authoritative and
  the workflow can only resume with identical tag digests.
