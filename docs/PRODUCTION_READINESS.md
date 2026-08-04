# Production-readiness ledger

This ledger separates repository evidence from environment-specific evidence.
Passing the local and CI gates makes a release candidate reproducible; it does
not by itself prove that a particular deployment is production-ready.

Last repository evidence review: 2026-08-04. Target version: `0.1.0-rc.1`.

## Repository and local-runtime evidence

The following gates have current passing evidence on the release-candidate
working tree:

- locked npm installation with the reviewed lifecycle-script allowlist;
- dependency-free GitHub Actions policy verification before package install,
  covering full action SHA pins, checkout credential non-persistence, explicit
  permissions, job timeouts, concurrency, and privileged-trigger rejection;
- formatting, linting, TypeScript checks, unit and SQLite integration tests;
- production Next.js build and compiled standalone application E2E covering
  signup, personal workspace provisioning, authenticated grid operations,
  workflow publication, and durable run creation;
- fail-closed public registration with disabled and secret-backed allowlist
  modes, loopback-only open signup, startup validation, Better Auth hook-level
  enforcement, UI reflection, temporary SQLite integration coverage, and a
  four-process compiled-standalone HTTP drill;
- bounded database-backed sessions with a hard seven-day public default,
  configurable 15-minute-to-30-day expiry, explicit sliding refresh,
  cache-free immediate revocation, token-safe other-session controls, SQLite
  integration coverage, and compiled-standalone HTTP evidence that revokes the
  older session while preserving the current one;
- provider-neutral SMTP authentication email with fail-closed configuration,
  non-loopback TLS enforcement, header-safe messages, one-hour verified-email
  and single-use reset links, outage-safe enumeration-neutral reset responses,
  a bounded anti-enumeration response-time floor, session revocation after
  reset, SQLite integration coverage, private reset-page headers, and a
  compiled-standalone drill using real SMTP protocol delivery;
- a dependency-free production SMTP evidence verifier that reads bounded raw
  verification and recovery messages from one controlled inbox without
  emitting their addresses, bodies, links, or Message-IDs; requires recent,
  distinct deliveries with one trusted `Authentication-Results` authority;
  cross-checks the actual DKIM signature and application automation header;
  proves aligned SPF, DKIM, and DMARC pass results against live DNS; rejects
  missing DKIM keys, non-enforcing DMARC, and permissive unmatched-sender SPF;
  and binds the sanitized record to the candidate commit and raw-message
  digests;
- fail-closed authentication client identity that ignores forwarded IP headers
  by default, validated opt-in trusted proxy CIDRs, right-to-left proxy-chain
  resolution, database-backed integration coverage against spoofed left hops,
  Helm/Compose configuration, compiled startup rejection for trust-all ranges,
  and HTTP evidence that rotating forged client addresses cannot escape the
  shared bucket;
- bounded incremental reads across Better Auth POST requests and every product
  Route Handler, with declared and observed 64-KiB/five-MiB enforcement,
  compressed-body rejection, transport-specific responses, and source contracts
  that reject future direct `request.json()` use or an unwrapped auth handler;
- a Next.js Proxy same-origin contract for every unsafe API request, preserving
  headless Bearer clients while rejecting cross-site browser metadata and
  provenance-free cookie mutations; fixed-origin Better Auth proxy trust plus
  a fresh nonce CSP per application response, production `strict-dynamic`
  scripts without `unsafe-inline` or `unsafe-eval`, exact rendered-script nonce
  matching, nonce uniqueness across responses, HSTS, no-referrer, anti-framing,
  MIME-sniffing, browser-capability, and invitation no-store header contracts
  without framework identification;
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
- a packaged workflow-worker probe with a bounded 120-second authenticated
  startup window, strict Hatchet readiness, dependency-tolerant local
  liveness, default/full Helm render checks, and production-image evidence as
  the unprivileged runtime user;
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
- local builds of the web, worker, migration, and maintenance image targets;
- release metadata, Helm chart, connector SDK package, and checksum dry run;
- digest-aware Helm rendering plus a tested release-asset generator that
  rejects missing, duplicate, mutable, or unexpected image records;
- atomic, cross-platform release packaging that removes failed staging output
  and creates checksums only after the chart, SDK, digest manifest, and Helm
  digest values all exist;
- a dependency-free release-bundle verifier that requires the exact six assets,
  streams checksum validation, semantically binds digest-pinned Helm values and
  fourteen image-smoke records, emits a bounded success marker, and runs before
  release-file attestation;
- repository-level immutable GitHub Releases plus a dependency-free
  post-publication readback verifier that requires immutable release state,
  exact version/title/prerelease metadata, the reviewed release-note body, the
  closed six-asset set, matching byte sizes and download identities, and
  GitHub-computed SHA-256 digests equal to every packaged file;
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
- an environment-bound production capacity harness with mandatory dataset,
  replica, concurrency, count, p95, and worker-retry limits; it measures grid,
  FTS, optimistic-write, workflow-enqueue, and durable-completion paths through
  HTTPS and remote libSQL, rejects mutable images or worker churn, and proves
  exact isolated-fixture cleanup;
- a dependency-free stable-promotion evidence verifier with a closed external
  gate set, exact drill markers, retained-artifact hashes, canonical timing,
  blocker-free 24-hour observation, rollback and operator acceptance ordering,
  optional-adapter support binding, candidate ancestry, and a release-only Git
  path allowlist that forces a new RC after any runtime or verifier change;
- full-digest pins for release bases, CI services, and Compose third-party
  images, with registry evidence that each referenced manifest supports both
  `linux/amd64` and `linux/arm64`;
- a release-matrix runtime smoke for all seven immutable image digests on both
  supported platforms, with QEMU execution, exact target markers, no network,
  a read-only/capability-free boundary, bounded host parsing, two-record JSONL
  evidence artifacts, version tags blocked on any platform failure, and a
  revalidated fourteen-record `IMAGE_SMOKE.jsonl` asset covered by release
  checksums and attestation.
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
- run an authenticated Hatchet worker against the supported production Hatchet
  version, prove health registration, then send `SIGTERM` during an in-flight
  workflow and prove lease-safe completion or recovery inside the 90-second
  grace period using
  [`KUBERNETES_WORKER_DRAIN_DRILL.md`](KUBERNETES_WORKER_DRAIN_DRILL.md); the
  passing auth-disabled local Compose drill does not satisfy this
  environment-specific gate;
- test the chosen remote libSQL provider with at least two application replicas,
  a simulated replica/process loss, provider backup creation, and restore into
  an isolated database before cutover; retain the drill's prepared and
  restore-verified markers with the provider operation evidence;
- deploy the reference Helm release behind real TLS with an external secret
  manager, default-deny network policy, provider-specific egress, centralized
  logs, metrics, alert routing, and an operator-owned rollback decision path;
  retain `BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED` from the read-only live-object
  check in [`VERIFY_KUBERNETES_RUNTIME.md`](VERIFY_KUBERNETES_RUNTIME.md),
  `BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED` from the isolated
  CNI drill in
  [`KUBERNETES_NETWORK_POLICY_DRILL.md`](KUBERNETES_NETWORK_POLICY_DRILL.md),
  external-secret provenance evidence, plus a passing
  `BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED` record from the canonical ingress;
- capture the production ingress `X-Forwarded-For` chain, prove the proxy
  overwrites or predictably appends it, deny direct web access, configure only
  the observed proxy IP/CIDR boundary, and exercise both application and edge
  rate limits from multiple real client networks;
- exercise the chosen authenticated SMTP service over TLS, prove verification
  and recovery delivery to controlled inboxes, configure and validate SPF,
  DKIM, and DMARC alignment, and monitor deferrals, rejections, bounces,
  complaints, and authentication failures; retain the exact marker from
  [`SMTP_PRODUCTION_DRILL.md`](SMTP_PRODUCTION_DRILL.md) plus the provider
  monitoring evidence;
- independently repeat the digest-bound image smoke on native `linux/amd64` and
  native `linux/arm64` hosts, retaining those records with the release
  workflow's attested fourteen-record `IMAGE_SMOKE.jsonl` asset;
- verify the strongest available GHCR tag immutability controls against the
  first candidate publication; the active no-bypass `v*` repository tag
  ruleset already prevents release-tag update and deletion;
- measure web/API latency and SQLite/libSQL contention at the intended tenant,
  row, mutation, and workflow concurrency envelope; record a capacity limit and
  alert threshold using
  [`PRODUCTION_CAPACITY_DRILL.md`](PRODUCTION_CAPACITY_DRILL.md) rather than
  treating a synthetic benchmark as a guarantee;
- exercise optional Airbyte ingestion and ClickHouse projection end to end in
  the supported environment before listing either adapter in that environment's
  supported production matrix;
- complete a candidate observation window with no unresolved security,
  correctness, restore, or data-loss blocker, then update `SECURITY.md` with the
  stable supported-version policy.

## Promotion decision

An RC can be published after its commit is reviewed, ordinary CI is green, and
the tag workflow passes. Stable promotion additionally requires every external
gate above, a documented rollback point, named operator acceptance, and a
passing versioned manifest under the contract in `PRODUCTION_EVIDENCE.md`.
Never move or reuse a failed tag; fix the cause and issue a new prerelease
version.
