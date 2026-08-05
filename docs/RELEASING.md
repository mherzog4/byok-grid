# Release process

BYOK Grid uses one application version for the repository and Helm chart. The
Apache-licensed connector SDK keeps an independent package version. Tagged
application releases publish seven multi-platform GHCR images, a Helm chart,
the connector SDK package, checksums, an exact image-digest manifest, and the
validated fourteen-record image-smoke manifest.

## Release contract

The root `package.json`, root entries in `package-lock.json`, Helm `version`, and
Helm `appVersion` must match the tag without its leading `v`. Artifact Hub's
prerelease annotation must be `true` for a prerelease and `false` for a stable
version. A reviewed, version-bound release note must exist at
`docs/releases/v<VERSION>.md`; the verifier checks its exact title, machine
marker, required operator-facing sections, and final newline. Validate the
contract locally with:

```text
npm run release:verify-version -- 0.1.0-rc.2
```

`release-images.json` is the single list of published image targets. The
verification script proves every target exists in the Dockerfile and every
chart-owned runtime points at its official GHCR repository. The publish job
also converts the complete digest manifest into `values.digests.yaml`; the
generator rejects missing, duplicate, mutable, or unexpected image records.
The same atomic packager used by GitHub Actions builds the chart and SDK,
creates portable SHA-256 checksums, and exposes no final output directory until
every artifact succeeds:

```text
npm run release:package -- \
  --version 0.1.0-rc.2 \
  --digests-dir release-digests \
  --smoke-dir release-smoke \
  --output-dir dist/release
```

The digest directory must contain exactly one `<target>.txt` record for each
entry in `release-images.json`. The smoke directory must contain exactly one
two-record `<target>.jsonl` file for each entry, bound to the same digest and
covering `linux/amd64` and `linux/arm64` once each. The output directory must
not already exist; this prevents a retry from mixing artifacts from different
attempts.

Independently verify the assembled bytes with the same dependency-free command
that runs before release-file attestation:

```text
npm run release:verify-bundle -- \
  --version 0.1.0-rc.2 \
  --directory dist/release
```

Success emits `BYOK_GRID_RELEASE_BUNDLE_VERIFIED` with the exact asset, image,
and smoke-record counts. The verifier streams archive hashing and rejects any
extra asset, checksum drift, digest/value mismatch, or noncanonical smoke
evidence.

The repository has immutable GitHub Releases enabled. After the CLI assembles
the release as a draft, uploads every file, and publishes it, the workflow reads
the public release back and runs `release:verify-published`. That verifier
requires GitHub's `immutable: true` state, the exact version/title/prerelease
identity, the reviewed release-note body, exactly six uploaded assets, matching
byte sizes, canonical download URLs, and a server-computed SHA-256 digest equal
to every packaged file. A failure requires a new release-candidate version;
never alter or delete an immutable published release.

Release assembly is reproducible across fresh checkouts of the same source.
Before Helm packaging, the packager copies the reviewed chart into a private
tree, rejects symbolic links and special files, sorts traversal, preserves
reviewed modes, and normalizes file and directory timestamps to a fixed release
epoch. Hosted CI packages the real chart and SDK twice with an elapsed-time
boundary and requires every one of the six resulting assets—including
`SHA256SUMS`—to be byte-identical. This reproducibility is what allows an
immutable release rerun to compare exact bytes rather than weakening the
verification contract.

GitHub Release publication is retry-safe without editing an existing release.
The publisher verifies the complete local bundle before its first API request,
then treats only an authenticated API `404` as absence. An existing release is
an idempotent no-op only when the independent verifier proves it is published,
immutable, version-bound, note-identical, and contains the exact same six asset
names, sizes, download identities, and GitHub-computed SHA-256 digests. Any
draft, mutable, incomplete, or byte-conflicting release fails closed. If the CLI
reports a creation failure after GitHub actually published the release, a
bounded readback may recover only by proving that same immutable identity.
Success emits `BYOK_GRID_GITHUB_RELEASE_PUBLICATION_VERIFIED`; the separate
workflow step then verifies the recorded response again.

Maintainers can exercise the real local Helm/npm packaging toolchain without
publishing anything:

```text
BYOK_GRID_RELEASE_INTEGRATION=1 npm run test:release-tools
```

## Candidate procedure

1. Work from a clean, reviewed commit on `main` with required CI checks green.
2. Set the version contract and retain the prerelease annotation for an RC.
   Draft the matching curated release note before review; the release workflow
   publishes that committed file verbatim rather than inferring product status
   from the pull-request history.
3. Run all repository checks plus the backup/restore, migration, rollout,
   rollback-compatibility, signal-drain, and external-service failure drills.
   For the local Compose drain gate, start the app profile and run
   `npm run drill:workflow-drain`; retain its three structured marker lines in
   the dated release evidence. After the production web build, also run
   `npm run drill:web-drain` and retain its
   `BYOK_GRID_WEB_DRAIN_DRILL_PASSED` record; this separately proves the
   standalone Next.js listener and in-flight request behavior used by the Helm
   rollout contract.
   Multi-host candidates must also retain both successful markers from
   `docs/REMOTE_LIBSQL_DRILL.md` after a provider backup is restored into an
   isolated database. Retain the authenticated Kubernetes worker marker from
   `docs/KUBERNETES_WORKER_DRAIN_DRILL.md` after signalling an in-flight run in
   the isolated reference deployment. For stable promotion, retain the passing
   declared-envelope record and supporting provider/ingress metrics from
   `docs/PRODUCTION_CAPACITY_DRILL.md`. Retain the sanitized
   verification/recovery delivery and DNS-authentication marker from
   `docs/SMTP_PRODUCTION_DRILL.md` with the separate provider monitoring
   record.
4. Create and push a signed annotated tag such as `v0.1.0-rc.2`.
5. Let `.github/workflows/release.yml` verify source, build images, publish
   attestations, smoke every immutable image on `linux/amd64` and `linux/arm64`,
   revalidate the seven two-record `release-smoke-<target>` artifacts into the
   checksummed `IMAGE_SMOKE.jsonl` release asset, independently verify the
   complete bundle, attest it, and create the GitHub Release. Do not manually
   replace failed assets or move the tag. The final workflow step reads the
   published release back and proves GitHub made it immutable with the exact
   packaged asset bytes.
   On the first release, GHCR creates personal-account packages as private.
   The workflow intentionally stops before the GitHub Release unless all seven
   version tags and immutable digests are anonymously readable. After the
   staging packages exist, the owner must open each package's settings, change
   visibility to **Public**, confirm the irreversible change, and rerun the
   same workflow attempt. Never weaken or skip the anonymous gate; public GHCR
   visibility cannot later be changed back to private.
6. Verify every released file and image using `docs/VERIFY_RELEASE.md`, then
   install a digest-pinned candidate in the reference environment by applying
   the release's generated `values.digests.yaml` after operator values.
7. Run the read-only live Kubernetes verifier from
   `docs/VERIFY_KUBERNETES_RUNTIME.md` while the migration Job is retained, and
   run the read-only External Secrets Operator provenance verifier from
   `docs/VERIFY_KUBERNETES_SECRET_PROVENANCE.md`. Then
   run the isolated CNI enforcement drill from
   `docs/KUBERNETES_NETWORK_POLICY_DRILL.md`. Keep all three exact
   candidate-bound
   structured markers with the reference-deployment evidence. Run the
   read-only public deployment verifier from
   `docs/VERIFY_DEPLOYMENT.md` against the canonical TLS origin and retain its
   structured success record with the deployment evidence.
   Before stable promotion, repeat the isolated image smoke from
   `docs/MULTI_ARCH_IMAGE_SMOKE.md` on native hosts for both architectures,
   then retain the closed fourteen-record
   `BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED` artifact.

The image job initially publishes only commit-scoped staging tags. Each image
is scanned at its immutable digest and attested only after the scan passes. A
separate aggregate job preflights the complete seven-tag set and creates version
tags only when all seven images pass. An absent tag is created from its verified
digest, an existing tag at that same digest is an idempotent no-op, and an
existing tag at any other digest fails before the first write. Each newly
created tag is read back through the OCI registry, and the complete seven-tag
set must report its expected top-level digests in a final pass before the
workflow can publish release files. Success emits
`BYOK_GRID_RELEASE_IMAGE_TAGS_VERIFIED` with the created, existing, and total
image counts. The next credential-free step requests anonymous GHCR pull tokens
and reads every version tag and immutable digest directly. It emits
`BYOK_GRID_PUBLIC_RELEASE_IMAGES_VERIFIED` only when all seven pairs return the
recorded digest; a private package blocks the dependent GitHub Release job.
This makes workflow reruns safe without treating a mutable tag as the image
identity or authenticated access as proof of public distribution;
`IMAGE_DIGESTS.txt` remains authoritative. Fixable High and Critical
vulnerabilities and end-of-life base operating systems block the release.
Review and update `docs/PRODUCTION_READINESS.md` with the resulting run and
deployment evidence.

Protect release tags with a repository ruleset and enable GHCR tag immutability
when the registry supports it. After publication, follow
[`VERIFY_RELEASE_PROTECTION.md`](VERIFY_RELEASE_PROTECTION.md) and retain the
`BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED` record. It requires the exact
no-bypass mutation rule, owner-only creation rule, GitHub-verified signed tag,
immutable release state, and all seven version tags at the release digests.
Each version tag and digest must also be readable through the anonymous GHCR
path used by public self-hosters.
Repository workflow concurrency plus immediate
pre-write and post-write registry checks narrow the non-atomic registry update
window, but registry tags remain pointers unless the registry itself enforces
immutability. A final closed-set readback detects changes during the job but
cannot make mutable registry pointers atomic after that read. The digest
manifest is authoritative regardless of tag policy. A failed partial release
must be investigated; never point an existing version tag at a different
commit.

## Stable release gate

Remove the Artifact Hub prerelease annotation only when all production drills
have current evidence, supported upgrade and rollback paths are documented, the
security policy names supported versions, and the release candidate has run
through its observation window without an unresolved release blocker.

Stable versions additionally require the closed, versioned manifest described
in `docs/PRODUCTION_EVIDENCE.md`. Commit the manifest, the curated
version-bound stable release notes, and only the allowed
version/readiness/security metadata after the observed RC. Then run
`npm run release:verify-production-evidence` and
`npm run release:verify-version -- <stable-version>` from that committed state.
The latter proves candidate ancestry and rejects any runtime, dependency,
workflow, deployment, or verifier change after observation. Prerelease tags do
not require this manifest; a code change discovered during promotion requires a
new RC rather than an expanded allowlist.
