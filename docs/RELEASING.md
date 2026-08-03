# Release process

BYOK Grid uses one application version for the repository and Helm chart. The
Apache-licensed connector SDK keeps an independent package version. Tagged
application releases publish seven multi-platform GHCR images, a Helm chart,
the connector SDK package, checksums, and an exact image-digest manifest.

## Release contract

The root `package.json`, root entries in `package-lock.json`, Helm `version`, and
Helm `appVersion` must match the tag without its leading `v`. Artifact Hub's
prerelease annotation must be `true` for a prerelease and `false` for a stable
version. Validate the contract locally with:

```text
npm run release:verify-version -- 0.1.0-rc.1
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
  --version 0.1.0-rc.1 \
  --digests-dir release-digests \
  --output-dir dist/release
```

The digest directory must contain exactly one `<target>.txt` record for each
entry in `release-images.json`. The output directory must not already exist;
this prevents a retry from mixing artifacts from different attempts.

Maintainers can exercise the real local Helm/npm packaging toolchain without
publishing anything:

```text
BYOK_GRID_RELEASE_INTEGRATION=1 npm run test:release-tools
```

## Candidate procedure

1. Work from a clean, reviewed commit on `main` with required CI checks green.
2. Set the version contract and retain the prerelease annotation for an RC.
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
   the isolated reference deployment.
4. Create and push a signed annotated tag such as `v0.1.0-rc.1`.
5. Let `.github/workflows/release.yml` verify source, build images, publish
   attestations, and create the GitHub Release. Do not manually replace failed
   assets or move the tag.
6. Verify every released file and image using `docs/VERIFY_RELEASE.md`, then
   install a digest-pinned candidate in the reference environment by applying
   the release's generated `values.digests.yaml` after operator values.
7. Run the read-only public deployment verifier from
   `docs/VERIFY_DEPLOYMENT.md` against the canonical TLS origin and retain its
   structured success record with the deployment evidence.

The image job initially publishes only commit-scoped staging tags. Each image
is scanned at its immutable digest and attested only after the scan passes. A
separate aggregate job creates version tags only when all seven images pass, so
one failed matrix entry cannot leave a partially approved version set. Fixable
High and Critical vulnerabilities and end-of-life base operating systems block
the release. Review and update `docs/PRODUCTION_READINESS.md` with the resulting
run and deployment evidence.

Protect release tags with a repository ruleset and enable GHCR tag immutability
when the registry supports it. The digest manifest is authoritative regardless
of tag policy. A failed partial release must be investigated; never point an
existing version tag at a different commit.

## Stable release gate

Remove the Artifact Hub prerelease annotation only when all production drills
have current evidence, supported upgrade and rollback paths are documented, the
security policy names supported versions, and the release candidate has run
through its observation window without an unresolved release blocker.
