# Production-readiness ledger

This ledger separates repository evidence from environment-specific evidence.
Passing the local and CI gates makes a release candidate reproducible; it does
not by itself prove that a particular deployment is production-ready.

Last repository evidence review: 2026-08-03. Target version: `0.1.0-rc.1`.

## Repository and local-runtime evidence

The following gates have current passing evidence on the release-candidate
working tree:

- locked npm installation with the reviewed lifecycle-script allowlist;
- formatting, linting, TypeScript checks, unit and SQLite integration tests;
- production Next.js build and compiled standalone application E2E covering
  signup, personal workspace provisioning, authenticated grid operations,
  workflow publication, and durable run creation;
- Rust connector-runner formatting, linting, and tests;
- current-schema migration plus an N-1-to-current SQLite upgrade preserving
  tenant data, migration history, foreign keys, and integrity;
- readiness rejection for a database missing the latest required migration;
- online SQLite backup, integrity verification, restore to a new file, and
  digest equality while the web container remained available;
- web startup rejection for absent or malformed runtime secrets and healthy
  startup with canonical runtime configuration;
- worker startup rejection before Hatchet connection when its master key is
  malformed;
- deterministic lifecycle tests plus a real child-process `SIGTERM` proving
  poller abort, Hatchet drain completion, and database-close ordering;
- a reproducible local Compose drain drill that signals a persisted in-flight
  500-row, 100-step workflow, proves every step succeeds, verifies worker exit
  0 and Hatchet drain logs, and restores worker health; the application Node
  process is container PID 1 and the Hatchet REST lifecycle endpoint is
  explicit rather than inherited from its token;
- Hatchet `/metrics` runtime support through the installed `prom-client` peer,
  with container verification that the production dependency is present;
- a separate graceful-lifecycle application metrics endpoint covering
  deployment-wide workflow status, terminal outcomes, active-step age, and
  dispatch backlog without tenant or payload labels;
- Compose rendering and Helm security/health/migration contract verification;
- chart-owned default-deny runtime ingress, trusted web and monitoring peer
  contracts, permanent connector-runner egress denial, opt-in component-scoped
  runtime egress isolation, and render-time rejection of an exposed Ingress
  without a trusted peer;
- local builds of the web, worker, migration, and maintenance image targets;
- release metadata, Helm chart, connector SDK package, and checksum dry run;
- digest-aware Helm rendering plus a tested release-asset generator that
  rejects missing, duplicate, mutable, or unexpected image records;
- atomic, cross-platform release packaging that removes failed staging output
  and creates checksums only after the chart, SDK, digest manifest, and Helm
  digest values all exist;
- full-digest pins for release bases, CI services, and Compose third-party
  images, with registry evidence that each referenced manifest supports both
  `linux/amd64` and `linux/arm64`.

The dated local runtime, drain, SQLite recovery, and ClickHouse projection
record is in
[`docs/evidence/2026-08-03-local-runtime.md`](evidence/2026-08-03-local-runtime.md).
The public repository's pre-promotion CI, security-feature, ruleset, release,
and license-detection state is recorded in
[`docs/evidence/2026-08-03-github-hosted-state.md`](evidence/2026-08-03-github-hosted-state.md).

The tag workflow repeats repository checks, legacy PostgreSQL compatibility
tests, dependency audit, multi-platform image builds, fixable High/Critical
vulnerability and base-OS lifecycle scans, SBOM/provenance generation, digest
attestation, checksums, and release-file attestation. Version tags are created
from digests only after the complete image matrix passes.

## Release-candidate gates still requiring external evidence

Do not describe `0.1.0-rc.1` as a stable production release until each item has
dated evidence linked from a release issue or runbook record:

- run the tag workflow in this public repository and independently verify its
  seven digest-pinned images, chart, SDK package, checksums, and attestations;
- run the SHA-pinned CodeQL JavaScript/TypeScript and Rust jobs plus dependency
  review in the public repository; enable code scanning, dependency graph,
  Dependabot alerts, secret scanning, and push protection, then require the
  applicable CI/security checks through a ruleset;
- run an authenticated Hatchet worker against the supported production Hatchet
  version, prove health registration, then send `SIGTERM` during an in-flight
  workflow and prove lease-safe completion or recovery inside the 90-second
  grace period; the passing auth-disabled local Compose drill does not satisfy
  this environment-specific gate;
- test the chosen remote libSQL provider with at least two application replicas,
  a simulated replica/process loss, provider backup creation, and restore into
  an isolated database before cutover;
- deploy the reference Helm release behind real TLS with an external secret
  manager, default-deny network policy, provider-specific egress, centralized
  logs, metrics, alert routing, and an operator-owned rollback decision path;
- boot and smoke-test both `linux/amd64` and `linux/arm64` release images from
  their published manifest-list digests;
- enable and verify protected release tags or a repository ruleset and the
  strongest available GHCR tag immutability controls;
- measure web/API latency and SQLite/libSQL contention at the intended tenant,
  row, mutation, and workflow concurrency envelope; record a capacity limit and
  alert threshold rather than treating a synthetic benchmark as a guarantee;
- exercise optional Airbyte ingestion and ClickHouse projection end to end in
  the supported environment before listing either adapter in that environment's
  supported production matrix;
- complete a candidate observation window with no unresolved security,
  correctness, restore, or data-loss blocker, then update `SECURITY.md` with the
  stable supported-version policy.

## Promotion decision

An RC can be published after its commit is reviewed, ordinary CI is green, and
the tag workflow passes. Stable promotion additionally requires every external
gate above, a documented rollback point, and named operator acceptance. Never
move or reuse a failed tag; fix the cause and issue a new prerelease version.
