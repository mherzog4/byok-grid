# Verify a release

Treat the GitHub Release's `IMAGE_DIGESTS.txt` as the authoritative mapping from
component names to immutable OCI digests. Do not deploy a floating tag when a
digest is available.

Download the release assets, then verify their checksums from the directory
containing them:

```text
sha256sum --check SHA256SUMS
```

Verify a downloaded chart or SDK package against the repository identity:

```text
gh attestation verify byok-grid-0.1.0-rc.1.tgz \
  --repo mherzog4/byok-grid
```

Verify a GHCR image at the exact digest recorded in `IMAGE_DIGESTS.txt` and fetch
its registry-linked bundle:

```text
gh attestation verify \
  oci://ghcr.io/mherzog4/byok-grid-web@sha256:REPLACE_WITH_DIGEST \
  --repo mherzog4/byok-grid \
  --bundle-from-oci
```

Download the seven `release-smoke-<target>` workflow artifacts and verify that
each contains exactly one `linux/amd64` and one `linux/arm64`
`BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED` record for the same digest manifest.
Then follow [`MULTI_ARCH_IMAGE_SMOKE.md`](MULTI_ARCH_IMAGE_SMOKE.md) to repeat
the isolated smoke on native hosts for both architectures before stable
promotion.

After cryptographic verification, render the chart with image tags replaced by
the verified digests. The release includes `values.digests.yaml`, generated
from the same complete `IMAGE_DIGESTS.txt` manifest after every image scan
passes. It sets the five chart-owned repositories and digests and clears any
tag values so Helm cannot render an ambiguous image reference:

```text
helm template byok-grid ./byok-grid-0.1.0-rc.1.tgz \
  --namespace byok-grid \
  --values values.production.yaml \
  --values values.digests.yaml
```

Supply the generated digest file last so it takes precedence over operator
image tags. Confirm that every rendered workload uses `repository@sha256:...`,
then run the preflight, migration, readiness, workflow, backup, and restore
checks described in the operator guides. Provenance proves origin and build
identity; it does not prove that a release is free of vulnerabilities or
operational defects.

Once the digest-pinned release is reachable through its canonical HTTPS
ingress, run the read-only checks in
[`docs/VERIFY_DEPLOYMENT.md`](VERIFY_DEPLOYMENT.md). Preserve its structured
success marker with the digest manifest and operator evidence.
