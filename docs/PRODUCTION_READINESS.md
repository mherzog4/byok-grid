# Production-readiness ledger

This ledger separates repository evidence from environment-specific evidence.
Passing the local and CI gates makes a release candidate reproducible; it does
not by itself prove that a particular deployment is production-ready.

Last repository evidence review: 2026-08-05. Stable promotion target: `0.1.0`
from signed candidate `0.1.0-rc.3`, containing the SQLite-native default
topology and schema-v2 stable evidence contract.

## Repository and local-runtime evidence

The following gates have current passing evidence on the release-candidate
working tree:

- locked npm installation with the reviewed lifecycle-script allowlist;
- dependency-free GitHub Actions policy verification before package install,
  covering full action SHA pins, checkout credential non-persistence, explicit
  permissions, job timeouts, concurrency, and privileged-trigger rejection;
- formatting, linting, TypeScript checks, unit and SQLite integration tests;
- production Next.js build and compiled standalone application E2E covering
  deterministic local-owner and personal-workspace provisioning, grid
  operations, workflow publication, and durable run creation without accounts,
  sessions, or email delivery;
- bounded incremental reads across every product Route Handler, with declared
  and observed five-MiB enforcement, compressed-body rejection,
  transport-specific responses, and source contracts that reject future direct
  `request.json()` use;
- a Next.js Proxy same-origin contract for every unsafe API request, rejecting
  cross-site browser metadata; optional canonical-origin configuration plus a
  fresh nonce CSP per application response, production `strict-dynamic`
  scripts without `unsafe-inline` or `unsafe-eval`, exact rendered-script nonce
  matching, nonce uniqueness across responses, HSTS, no-referrer, anti-framing,
  MIME-sniffing, browser-capability, and no-store header contracts without
  framework identification;
- server-generated request correlation that replaces caller-supplied public and
  private IDs, reaches proxy-level rejections and compiled application
  responses, and joins generic 500 responses to one bounded structured log
  event without messages, stacks, URLs, payloads, credentials, or tenant data;
- Rust connector-runner formatting, linting, tests, fail-fast Unix signal
  registration, a real child-process `SIGTERM`, and production-image PID 1
  evidence proving clean Axum shutdown as the unprivileged runtime user;
- current-schema migration plus an N-1-to-current SQLite upgrade preserving
  tenant data, migration history, foreign keys, and integrity;
- driver-level five-second local SQLite busy handling applied to every internal
  transaction connection, paired with per-process write serialization and
  three bounded, jittered retries only when machine-coded lock acquisition
  fails before application work starts; a real two-process WAL drill proves
  stale-connection reset and recovery without callback replay;
- readiness rejection for a database missing the latest required migration;
- explicit local/remote database topology policy, with every Helm-owned
  database process requiring `libsql://` against the kubelet-resolved Secret,
  startup-safe rejection before file creation or application work, and
  default/full-render coverage for all required and optional workloads;
- online SQLite backup, integrity verification, restore to a new file, and
  digest equality while the web container remained available;
- bounded deployment master-key overlap and workspace-key-only rewrapping with
  fail-closed startup validation, plan/apply separation, explicit current-key
  confirmation, ciphertext-preserving SQLite integration coverage, real CLI
  process evidence, and Compose/Helm Secret contracts;
- web startup rejection for absent or malformed runtime secrets and healthy
  startup with canonical runtime configuration;
- an explicit Helm web rollout contract with a process-only startup probe,
  database-aware readiness, endpoint-withdrawal pre-stop delay, bounded total
  grace period, invalid-value rejection, and a compiled standalone `SIGTERM`
  drill that immediately observes listener refusal/reset while the process and
  in-flight response remain active, with deterministic timing-race and
  cross-platform socket-result coverage;
- worker startup rejection before Hatchet connection when its master key is
  malformed;
- a SQLite-native execution driver that claims the durable SQLite outbox,
  resolves the same typed handlers as the optional Hatchet adapter, executes a
  real published workflow with every Hatchet setting absent, persists the
  expected row mutation, and drains cleanly on `SIGTERM`;
- a packaged workflow-worker probe that selects DB-backed local health on port
  `8002` or authenticated Hatchet health on port `8001`, with bounded startup,
  strict readiness, dependency-tolerant liveness, default/full Helm render
  checks, and production-image evidence as the unprivileged runtime user;
- deterministic lifecycle tests plus real child-process `SIGTERM` evidence
  proving poller abort, execution-driver drain completion, and database-close
  ordering;
- a reproducible local Compose drain drill that signals a persisted in-flight
  500-row, 100-step workflow, proves every step succeeds, verifies worker exit
  0 and driver-specific pending-task drain confirmation, and restores worker
  health; the application Node process is container PID 1 and the optional
  Hatchet REST lifecycle endpoint is explicit rather than inherited from its
  token;
- optional Hatchet `/metrics` runtime support through the installed
  `prom-client` peer, with container verification that the production
  dependency is present;
- a separate graceful-lifecycle application metrics endpoint covering
  deployment-wide workflow status, terminal outcomes, active-step age, and
  dispatch backlog plus process-local SQLite acquisition retries/exhaustions
  without tenant, payload, or error-message labels;
- Compose rendering and Helm security/health/migration contract verification;
- chart-owned default-deny runtime ingress, trusted web and monitoring peer
  contracts, permanent connector-runner egress denial, opt-in component-scoped
  runtime egress isolation, bounded connector-runner startup and termination,
  and render-time rejection of an exposed Ingress without a trusted peer;
- an optional analytics-projector lifecycle with owned live/ready state,
  retrying dependency initialization, signal-cancelled ClickHouse transport,
  lease-safe shutdown, real child-process `SIGTERM`, bounded Helm probes and
  grace period, invalid topology rejection, and production-image health proof;
- local builds of all seven production image targets plus a pre-tag CI scan
  that fails on fixable High/Critical OS or library vulnerabilities and
  end-of-life base operating systems;
- release metadata, Helm chart, connector SDK package, and checksum dry run,
  with the standalone SDK inventory check isolated from and independent of the
  operator's global npm cache;
- digest-aware Helm rendering plus a tested release-asset generator that
  rejects missing, duplicate, mutable, or unexpected image records;
- atomic, cross-platform release packaging that removes failed staging output
  and creates checksums only after the chart, SDK, digest manifest, and Helm
  digest values all exist, with a link-free fixed-timestamp chart staging copy
  and hosted two-build proof that all six release assets are byte-reproducible;
- a dependency-free release-bundle verifier that requires the exact six assets,
  streams checksum validation, semantically binds digest-pinned Helm values and
  fourteen image-smoke records, emits a bounded success marker, and runs before
  release-file attestation;
- repository-level immutable GitHub Releases plus a dependency-free
  post-publication readback verifier that requires immutable release state,
  exact version/title/prerelease metadata, the reviewed release-note body, the
  closed six-asset set, matching byte sizes and download identities, and
  GitHub-computed SHA-256 digests equal to every packaged file;
- a dependency-free GitHub Release publisher that verifies the local bundle
  before API access, treats only authenticated `404` as absence, creates once,
  safely no-ops only on a byte-identical immutable release, recovers ambiguous
  CLI outcomes through bounded exact readback, and rejects drafts, conflicts,
  provider errors, or oversized responses without logging credentials;
- a dependency-free native multi-architecture image-smoke collector and
  offline combiner that reject host/daemon architecture drift, exercise all
  seven immutable digests on real `amd64` and `arm64` Linux Docker servers with
  the release isolation boundary, and require the exact combined fourteen
  records to match the checksummed release smoke manifest within 24 hours;
- a bounded, read-only public deployment verifier for exact live/ready bodies,
  redirect rejection, unique request correlation, ingress-preserved security
  headers, and distinct response-bound CSP script nonces, reused by the
  compiled-standalone drill without treating loopback as ingress evidence;
- a fail-closed, isolated-database remote libSQL drill that requires
  authentication and current migrations, rejects application data, kills a
  committed writer, observes the challenge from a second process, and compares
  source/restore schema, migration, and table-count fingerprints before exact
  cleanup;
- a fail-closed authenticated Kubernetes worker-drain harness that requires an
  isolated idle environment and one stable replica, signals PID 1 during a real
  500-row workflow, and verifies clean previous termination, one restart,
  renewed Hatchet health, drain logs, durable completion, and returned-idle
  application metrics without emitting credentials or transport errors;
- a fail-closed Kubernetes NetworkPolicy enforcement drill with a closed claim
  set, isolated source namespaces, immutable token-free NotReady probe pods,
  allowed-before-blocked same-target controls, exact cleanup, target-redacted
  candidate-bound evidence, and optional-component coverage;
- a dependency-free read-only External Secrets Operator v1 provenance verifier
  that rejects broad imports and stale syncs, hashes the exact per-key remote
  bindings and store configuration, verifies a Ready store plus stable
  digest-pinned admitted controller pods, never fetches Secret data, and emits
  the same hashed Secret reference used by the workload verifier;
- an environment-bound production capacity harness with mandatory dataset,
  replica, concurrency, count, p95, and worker-retry limits; it measures grid,
  FTS, optimistic-write, workflow-enqueue, and durable-completion paths through
  HTTPS and remote libSQL, rejects mutable images or worker churn, and proves
  exact isolated-fixture cleanup;
- a fail-closed Kubernetes rollback-and-restoration drill that binds a named
  prior Helm revision and the current candidate to separate immutable digest
  manifests, verifies stable restart-free workloads and the canonical public
  endpoint in all three phases, restores the candidate after any post-mutation
  failure when possible, and emits an exact marker only after the original
  candidate is restored and reverified;
- a dependency-free schema-v2 stable-promotion verifier with a closed default
  product gate set, exact runtime and release markers, retained-artifact hashes,
  canonical timing, post-evidence operator acceptance, optional-adapter support
  binding, candidate ancestry, and a release-only Git path allowlist that forces
  a new RC after any runtime or verifier change;
- full-digest pins for release bases, CI services, and Compose third-party
  images, with registry evidence that each referenced manifest supports both
  `linux/amd64` and `linux/arm64`;
- a release-matrix runtime smoke for all seven immutable image digests on both
  supported platforms, with QEMU execution, exact target markers, no network,
  a read-only/capability-free boundary, bounded host parsing, two-record JSONL
  evidence artifacts, version tags blocked on any platform failure, and a
  revalidated fourteen-record `IMAGE_SMOKE.jsonl` asset covered by release
  checksums and attestation;
- a dependency-free GHCR version-tag publisher that validates the exact digest
  inventory, preflights all seven tags before mutation, treats identical tags
  as idempotent rerun state, rejects conflicting digests, rechecks immediately
  before creation, verifies every created tag plus the final complete tag set by
  OCI digest readback, and keeps registry credentials and provider errors out of
  logs;
- a dependency-free anonymous GHCR verifier that requests only public pull
  tokens, reads all seven version tags and immutable digest references, requires
  both identities to return the checksummed digest, and blocks GitHub Release
  publication while any package remains private;
- a dependency-free read-only release-protection verifier that discovers the
  active tag ruleset inventory, requires exact no-bypass mutation and
  owner-only creation rules, peels a GitHub-verified signed annotated tag to the
  candidate commit, confirms repository and published-release immutability,
  reads all seven GHCR version tags back at the checksummed release digests
  through both authenticated and anonymous paths, and writes one exclusive
  private marker-bound evidence record;
- a fail-closed public community contract with a recognized Contributor
  Covenant and private enforcement channel, explicit best-effort support
  boundaries, structured bug/feature/support intake, private vulnerability
  routing, a production-impact pull-request checklist, and a dependency-free
  verifier included in the ordinary test gate;
- public hosted CI and Security evidence on the promoted candidate, including
  JavaScript/TypeScript and Rust CodeQL with zero open alerts, dependency review
  through protected pull request
  [`#5`](https://github.com/mherzog4/byok-grid/pull/5), Dependabot vulnerability
  alerts and security updates, secret scanning and push protection, private
  vulnerability reporting, repository-level action SHA pinning, a no-bypass
  `main` ruleset requiring current CI/security results and blocking
  High-or-higher CodeQL findings, an immutable `v*` tag ruleset, and AGPL-3.0
  license detection.

The dated local runtime, drain, SQLite recovery, and ClickHouse projection
record is in
[`docs/evidence/2026-08-03-local-runtime.md`](evidence/2026-08-03-local-runtime.md).
The default SQLite-native worker's source, Compose topology, production-image
readiness, and clean `SIGTERM` evidence is in
[`docs/evidence/2026-08-04-sqlite-native-worker.md`](evidence/2026-08-04-sqlite-native-worker.md).
The public repository's pre-promotion CI, security-feature, ruleset, release,
and license-detection state is recorded in
[`docs/evidence/2026-08-03-github-hosted-state.md`](evidence/2026-08-03-github-hosted-state.md).

The tag workflow repeats repository checks, legacy PostgreSQL compatibility
tests, dependency audit, multi-platform image builds, fixable High/Critical
vulnerability and base-OS lifecycle scans, SBOM/provenance generation, digest
attestation, checksums, and release-file attestation. Version tags are created
from digests only after the complete image matrix passes, and the GitHub Release
remains blocked until all seven tags and digests are anonymously readable.

## Stable-release evidence assembled

The signed `v0.1.0-rc.3` candidate now has dated evidence for the shipped
default product:

- a passing public tag workflow and independent verification of all seven
  digest-pinned images, chart, SDK package, checksums, SBOMs, provenance, and
  attestations;
- the release workflow's checksummed
  `BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED` record for both published platforms;
- the default SQLite-native workflow drain and compiled Next.js web drain,
  retaining `BYOK_GRID_DRAIN_DRILL_PASSED`,
  `BYOK_GRID_DRAIN_SIGNAL_COMPLETE`, and
  `BYOK_GRID_WEB_DRAIN_DRILL_PASSED`;
- online SQLite backup, integrity verification, isolated restore, and digest
  equality for the candidate database;
- current required CI, CodeQL, dependency-review, and repository security
  results;
- `BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED` for the signed tag, immutable
  GitHub Release, protected version tags, exact GHCR digest identities, and
  anonymous public image access; and
- the stable supported-version policy in `SECURITY.md`.

The immutable prerelease is
[`v0.1.0-rc.3`](https://github.com/mherzog4/byok-grid/releases/tag/v0.1.0-rc.3),
and its complete release workflow is
[`31004784878`](https://github.com/mherzog4/byok-grid/actions/runs/31004784878).
The independently retained evidence records are linked from
[`issue #6`](https://github.com/mherzog4/byok-grid/issues/6). The candidate
digest manifest has SHA-256
`27398eccf55e7b73a908b40ecfb73706cee158c6276f9a3e2d2b6e34d320ac69`.

## Stable-promotion decision still required

The metadata-only candidate-to-stable diff must be retained by hash and receive
named owner acceptance after every evidence record. The stable promotion commit
must then pass protected pull-request checks and the schema-v2 evidence and
version verifiers. Creating `v0.1.0` remains a separate immutable action that
requires explicit owner authorization after the promotion commit reaches
protected `main`.

## Deployment-specific evidence

The following gates apply only when a maintainer or downstream operator claims
the corresponding topology. They do not block a stable release of the default
open-source application:

- authenticated Hatchet lifecycle and in-flight drain;
- remote libSQL multi-replica loss, provider backup, and isolated restore;
- Kubernetes runtime, External Secrets provenance, enforced NetworkPolicy, and
  rollback/restoration;
- canonical public ingress and an operator-controlled access boundary;
- native-host image repetition beyond the release workflow's two-platform
  execution;
- a measured tenant, row, mutation, and workflow concurrency envelope; and
- Airbyte ingestion or ClickHouse projection E2E evidence when either adapter is
  listed in `supportedOptionalAdapters`.

Capacity limits, backup retention, identity boundaries, alerts, and incident
ownership remain the responsibility of each production operator because they
depend on that operator's hardware, traffic, and deployment choices.

## Promotion decision

An RC can be published after its commit is reviewed, ordinary CI is green, and
the tag workflow passes. Stable promotion additionally requires the universal
evidence above, named post-evidence operator acceptance, and a passing schema-v2
manifest under `PRODUCTION_EVIDENCE.md`. Optional deployment claims require
their applicable runbooks but do not expand the default product gate. Never
move or reuse a failed tag; fix the cause and issue a new prerelease version.
