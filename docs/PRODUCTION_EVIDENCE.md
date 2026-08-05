# Assemble stable production evidence

Stable promotion requires a versioned, machine-verifiable evidence manifest at
`docs/evidence/<stable-version>-production.json`. The manifest does not replace
review of the retained artifacts. It makes completeness, release binding,
timing, and supported-surface claims fail closed before a stable tag can publish.

Use
[`production-release.template.json`](evidence/production-release.template.json)
as the field and gate-ID reference. Its placeholders are intentionally invalid;
the template is not production evidence and cannot pass the verifier.

## Trust model

The observed candidate commit is the runtime source that passed the RC workflow,
deployment drills, capacity envelope, and observation window. The evidence
manifest is necessarily committed later, so it cannot contain the SHA of the
commit that contains itself. Stable verification instead proves all of these
properties:

1. `candidate.commit` is an available ancestor of the stable tag commit;
2. `candidate.version` is a prerelease of the exact stable version;
3. the candidate digest-manifest hash is retained;
4. every required gate appears exactly once with a content hash and canonical
   HTTPS evidence reference;
5. drill-backed gates carry their exact structured success markers;
6. observation lasts at least 24 hours and has zero unresolved blockers;
7. rollback and exact candidate restoration produce the repository-defined
   marker during the observation window;
8. named operator acceptance follows rollback and observation; and
9. candidate-to-stable changes touch only release metadata and evidence files.

The final required path set is deliberately narrow:

- `package.json`;
- root entries in `package-lock.json`;
- `deploy/helm/byok-grid/Chart.yaml`;
- `docs/evidence/<stable-version>-production.json`;
- `docs/PRODUCTION_READINESS.md`;
- `docs/releases/v<stable-version>.md`; and
- `SECURITY.md`.

All seven files must change and no other path may change. This proves the stable
version contract, manifest, readiness record, curated version-bound release
notes, and supported-version policy were actually updated. Any application,
dependency, container, chart template/value, workflow, verifier, or general
documentation change requires a new RC, deployment, and observation window. The
`candidate-source-equivalence` record retains the human review of the allowed
promotion-only diff; the Git path check independently enforces its boundary.

## Required evidence gates

Each record's `artifactSha256` hashes the exact retained evidence object—not the
HTML page that links to it. One immutable evidence bundle may support multiple
records, in which case the digest may repeat. References are not fetched during
verification so the release gate remains deterministic and credential-free;
reviewers must independently retrieve the object, verify its digest, and assess
its contents.

| Gate ID                        | Evidence that must be retained                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `release-assets`               | Passing RC tag workflow, seven image digests, chart, SDK, checksums, SBOM/provenance, and attestations                                                 |
| `code-security`                | CodeQL JavaScript/TypeScript and Rust results, dependency review, enabled repository security features, and required checks                            |
| `authenticated-worker-drain`   | Authenticated Hatchet in-flight Kubernetes drain record                                                                                                |
| `remote-libsql-recovery`       | Provider backup/loss/restore operation and both remote-drill markers                                                                                   |
| `reference-deployment`         | Exact Kubernetes runtime, external-secret provenance, and NetworkPolicy enforcement markers plus centralized telemetry, alerts, and rollback ownership |
| `public-ingress-and-proxy`     | Canonical deployment marker plus preserved security headers, request IDs, fresh CSP nonces, and an operator-controlled access boundary                 |
| `multi-architecture-smoke`     | Attested fourteen-record release asset plus native-host boot records for published `linux/amd64` and `linux/arm64` digests                             |
| `release-tag-protection`       | Exact tag rules, signed candidate tag, immutable GitHub Release state, and seven authenticated plus anonymous GHCR tag/digest checks                   |
| `production-capacity`          | Passing declared-envelope marker, provider/ingress metrics, supported limit, alert threshold, and saturation response                                  |
| `observation-window`           | Start/end record and zero unresolved security, correctness, restore, or data-loss blockers                                                             |
| `candidate-source-equivalence` | Reviewed diff from observed candidate to the proposed stable commit                                                                                    |

These marker arrays are exact:

- `release-assets`: `BYOK_GRID_PUBLISHED_RELEASE_VERIFIED` and
  `BYOK_GRID_RELEASE_BUNDLE_VERIFIED`;
- `release-tag-protection`:
  `BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED`;
- `authenticated-worker-drain`:
  `BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED`;
- `multi-architecture-smoke`:
  `BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED` and
  `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED`;
- `remote-libsql-recovery`:
  `BYOK_GRID_REMOTE_LIBSQL_DRILL_PREPARED` and
  `BYOK_GRID_REMOTE_LIBSQL_RESTORE_VERIFIED`;
- `public-ingress-and-proxy`:
  `BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED`;
- `reference-deployment`:
  `BYOK_GRID_KUBERNETES_EXTERNAL_SECRET_PROVENANCE_VERIFIED`,
  `BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED`, and
  `BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED`; and
- `production-capacity`: `BYOK_GRID_PRODUCTION_CAPACITY_VERIFIED`.

The top-level `rollback` object separately requires
`BYOK_GRID_KUBERNETES_ROLLBACK_VERIFIED` from the controlled live drill. Its
artifact hash and reference bind the marker-bearing output to the in-window
`testedAt` timestamp.

All other required records use an empty `markers` array. The release-assets
record requires both existing producers: bundle verification alone cannot prove
that GitHub published the same immutable files, while publication readback alone
does not replace the independent semantic bundle check. A generic “passed”
string is rejected because it has no repository-defined producer contract.

Produce the release-tag protection record only after RC publication by following
[`VERIFY_RELEASE_PROTECTION.md`](VERIFY_RELEASE_PROTECTION.md). The verifier is
read-only: it proves the current repository rules, signed annotated tag,
immutable release state, and exact GHCR version-tag digests without attempting
an overwrite. It also proves that every tag and immutable digest is anonymously
readable. Digest references remain authoritative because registry tags are
pointers unless the registry independently enforces immutability.

## Optional production surface

`supportedOptionalAdapters` is a sorted unique array containing `airbyte`,
`clickhouse`, both, or neither. Claiming `airbyte` requires an `airbyte-e2e`
record; claiming `clickhouse` requires a `clickhouse-e2e` record. Omitting an
adapter from the production matrix requires omitting its evidence record too.
This keeps experimental or unverified integrations from becoming accidental
stable support promises.

## Assemble and verify

1. Publish and independently verify the RC release.
2. Deploy its immutable digests and complete every environment gate.
3. Start the observation window only after the intended production topology is
   healthy. Retain at least 24 hours with zero unresolved blockers.
4. Run the documented Kubernetes rollback-and-restoration drill during that
   window and retain its exact marker-bearing record.
5. Hash each retained artifact and create the stable version's manifest from the
   template. Use canonical millisecond UTC timestamps such as
   `2026-08-03T12:34:56.789Z` and credential-free HTTPS URLs without query
   strings or fragments.
6. Record operator acceptance only after the window and rollback test finish.
7. Bump only the root/lock/chart version contract, set Artifact Hub prerelease
   to `false`, add the curated stable release notes, update the readiness ledger
   and `SECURITY.md`, and add the manifest. Do not change runtime or release
   machinery.
8. Commit those promotion-only files, then verify the committed state.

Verify the manifest directly:

```text
npm run release:verify-production-evidence -- \
  docs/evidence/0.1.0-production.json \
  0.1.0 \
  <observed-rc-commit>
```

Success emits one credential-free JSON record with marker
`BYOK_GRID_PRODUCTION_EVIDENCE_VERIFIED`. Then run the complete stable contract:

```text
npm run release:verify-version -- 0.1.0
```

The second command checks Git ancestry and the candidate-to-stable path
allowlist in addition to the manifest. It must run from the committed stable
promotion commit with candidate history available. The release workflow uses a
full checkout for this reason.

Do not add a stable tag when either verifier fails. Correct evidence-only or
version metadata mistakes with another promotion-only commit. If any runtime,
dependency, workflow, deployment, or verification behavior must change, issue
a new RC and repeat the affected evidence and observation window.
