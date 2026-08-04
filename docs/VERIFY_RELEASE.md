# Verify a release

Treat the GitHub Release's `IMAGE_DIGESTS.txt` as the authoritative mapping from
component names to immutable OCI digests. Do not deploy a floating tag when a
digest is available.

Download the release assets, then verify their checksums from the directory
containing them:

```text
sha256sum --check SHA256SUMS
```

`IMAGE_SMOKE.jsonl` is the durable release-CI runtime evidence. It must contain
exactly fourteen `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED` records: one
`linux/amd64` and one `linux/arm64` record for each target in
`IMAGE_DIGESTS.txt`, with matching immutable digests. The atomic release
packager reconstructs and validates this file from the seven matrix artifacts
before checksumming and attesting it.

From the matching release source, run the complete bundle verifier against a
directory containing only the six downloaded release assets:

```text
npm run release:verify-bundle -- \
  --version 0.1.0-rc.1 \
  --directory /path/to/downloaded-release
```

The `BYOK_GRID_RELEASE_BUNDLE_VERIFIED` result proves the exact asset set,
canonical checksums, archive hashes, seven-image digest manifest, generated
Helm values, and fourteen digest-bound smoke records. It complements—not
replaces—the GitHub attestations and registry vulnerability scan.

The release workflow also emits `BYOK_GRID_PUBLISHED_RELEASE_VERIFIED` only
after reading the published GitHub Release back. That marker proves GitHub
reported the release immutable, retained the reviewed notes, and reported the
same byte length and SHA-256 digest for each of the exact six locally packaged
assets. Confirm the public release API still reports `immutable: true`; an
immutable release or its tag must never be replaced to correct a failure.

The preceding `BYOK_GRID_GITHUB_RELEASE_PUBLICATION_VERIFIED` marker records
whether the workflow created the release or safely reused an already-identical
immutable release during a rerun. Reuse never uploads, edits, or replaces remote
state: it succeeds only after comparing the rebuilt local bundle and reviewed
notes with the complete public release response. A conflicting or draft release
is a hard failure and requires operator investigation rather than mutation.

Before release-file publication, the workflow emits
`BYOK_GRID_RELEASE_IMAGE_TAGS_VERIFIED` only after preflighting all seven GHCR
version tags, reading every newly created tag back, and verifying the complete
tag set in a final digest pass. A rerun accepts an existing version tag only
when its registry digest is already identical; any conflicting digest stops
publication without moving the tag. This marker protects the publication
process, while `IMAGE_DIGESTS.txt` remains the authoritative identity operators
must verify and deploy.

After the immutable release exists, run the read-only protection verifier in
[`VERIFY_RELEASE_PROTECTION.md`](VERIFY_RELEASE_PROTECTION.md). Its
`BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED` evidence proves that the active
repository rules prevent release-tag mutation without bypass, restrict creation
to the repository owner, and that the GitHub-verified signed annotated tag
peels to the candidate commit. It also confirms immutable GitHub Release state
and reads every GHCR version tag back at the exact digest in
`IMAGE_DIGESTS.txt`. This is a point-in-time protection and identity proof;
digest references remain the deployment authority.

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

Cross-check `IMAGE_SMOKE.jsonl` against the seven `release-smoke-<target>`
workflow artifacts while they remain available. Then follow
[`MULTI_ARCH_IMAGE_SMOKE.md`](MULTI_ARCH_IMAGE_SMOKE.md) to repeat the isolated
smoke on native hosts for both architectures and produce the exact
`BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED` combined record before
stable promotion.

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
