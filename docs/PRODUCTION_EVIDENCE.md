# Assemble stable production evidence

Stable promotion requires a versioned, machine-verifiable manifest at
`docs/evidence/<stable-version>-production.json`. The stable release certifies
the product BYOK Grid ships by default: a fork-first, single-node Next.js
application with the SQLite-native workflow worker. It does not require a
maintainer to operate Kubernetes, Hatchet, remote libSQL, Airbyte, ClickHouse,
or a public SaaS deployment.

Use
[`production-release.template.json`](evidence/production-release.template.json)
as the schema and gate-ID reference. Its placeholders are intentionally invalid
so the template cannot be mistaken for production evidence.

## Trust model

The candidate commit is the source that passed the RC workflow and default
runtime drills. The evidence manifest is committed later, so stable verification
proves the relationship instead of trying to make a commit name itself:

1. `candidate.commit` is an ancestor of the stable tag commit;
2. `candidate.version` is a prerelease of the exact stable version;
3. the candidate image-digest manifest is retained by SHA-256;
4. every universal gate appears once with an artifact hash and canonical HTTPS
   reference;
5. repository-owned drills carry their exact structured markers;
6. named operator acceptance occurs after every retained evidence record; and
7. candidate-to-stable changes touch only the seven release metadata files.

The exact promotion-only path set is:

- `package.json`;
- root entries in `package-lock.json`;
- `deploy/helm/byok-grid/Chart.yaml`;
- `docs/evidence/<stable-version>-production.json`;
- `docs/PRODUCTION_READINESS.md`;
- `docs/releases/v<stable-version>.md`; and
- `SECURITY.md`.

All seven files must change, and no other path may change. Any runtime,
dependency, workflow, deployment template, verifier, or general documentation
change requires a new RC.

## Required evidence

Each `artifactSha256` hashes the retained evidence object, not the web page that
links to it. References are not fetched during verification, keeping the stable
gate deterministic and credential-free.

| Gate ID                        | Required proof                                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `candidate-source-equivalence` | Human review of the closed candidate-to-stable metadata diff                                                            |
| `code-security`                | Passing required CI, CodeQL, dependency review, and repository security controls                                        |
| `multi-architecture-smoke`     | The release workflow's checksummed, attested image-smoke asset for all published `linux/amd64` and `linux/arm64` images |
| `release-assets`               | Independently verified immutable GitHub Release assets, image digests, chart, SDK, checksums, SBOMs, and attestations   |
| `release-tag-protection`       | Signed candidate tag, immutable release state, protected version tags, and anonymous access to every published image    |
| `single-node-runtime`          | Default SQLite-native worker drain plus compiled Next.js listener drain while in-flight work completes                  |
| `sqlite-backup-restore`        | Online backup, integrity check, isolated restore, and digest equality for the default local database                    |

Marker arrays are exact:

- `multi-architecture-smoke`: `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED`;
- `release-assets`: `BYOK_GRID_PUBLISHED_RELEASE_VERIFIED` and
  `BYOK_GRID_RELEASE_BUNDLE_VERIFIED`;
- `release-tag-protection`:
  `BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED`; and
- `single-node-runtime`: `BYOK_GRID_DRAIN_DRILL_PASSED`,
  `BYOK_GRID_DRAIN_SIGNAL_COMPLETE`, and
  `BYOK_GRID_WEB_DRAIN_DRILL_PASSED`.

The other required records use an empty `markers` array. A generic `passed`
string is rejected because it has no repository-defined producer.

Native-host smoke, Kubernetes rollout/rollback, authenticated Hatchet drain,
remote libSQL recovery, public ingress, and deployment capacity remain useful
operator evidence. They are deployment-specific claims, not universal
requirements for publishing the default open-source application.

## Optional adapter claims

`supportedOptionalAdapters` is a sorted unique array containing `airbyte`,
`clickhouse`, both, or neither. Claiming `airbyte` adds a required `airbyte-e2e`
record. Claiming `clickhouse` adds a required `clickhouse-e2e` record. These
records use empty marker arrays. An adapter not listed must not have an evidence
record.

## Assemble and verify

1. Publish and independently verify the RC release.
2. Run the default SQLite-native workflow drain, web drain, and SQLite
   backup/restore drills against that candidate.
3. Retain the required CI/security, release, image-smoke, and tag-protection
   artifacts. Add optional-adapter records only for adapters the release claims
   as supported.
4. Hash each retained artifact and create the stable version's schema-v2
   manifest. Use millisecond UTC timestamps such as
   `2026-08-05T12:34:56.789Z` and credential-free HTTPS references without
   query strings or fragments.
5. Record operator acceptance only after every evidence item has been verified.
6. Change only the seven promotion files, commit them, and verify the committed
   state.

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

The second command proves candidate ancestry and the exact promotion-only diff.
Do not add a stable tag while either verifier fails. A runtime or release-tool
change discovered during promotion requires a new RC; an evidence-only mistake
may be corrected within the closed promotion path set.
