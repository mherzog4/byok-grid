# BYOK Grid

BYOK Grid is a working codename for an open-source data-enrichment workspace:
an editable grid whose columns can run formulas, APIs, LLMs, and reusable
workflows with credentials supplied by each workspace.

## Current status

This is a release-candidate hardening build, not yet a stable production
release. It currently includes:

- a fork-first, single-user local workspace that opens directly without signup,
  sign-in, sessions, email delivery, or an account service;
- a React Flow node editor with typed ports, structurally safe incomplete
  drafts, strict publish validation, immutable graph versions, deterministic
  compiled plans, and revision-conflict protection;
- a SQLite-owned workflow run and step ledger with expiring claims, retry
  fencing, named filter branches, idempotent write-table effects, and a recent
  run inspector;
- personal workspace and starter-table provisioning;
- SQLite-backed workspaces, typed grid data, credentials, workflow definitions,
  immutable published versions, and run ledgers;
- an editable, typed sparse-cell grid with optimistic concurrency;
- bounded multi-table workspaces with table selection, atomic table-plus-first-
  column creation, table renaming, and typed input-column authoring;
- previewed table and column archival with dependency/in-flight-work blockers,
  exact-name confirmation, actor audit events, and ID-preserving restoration;
- previewed, exact-name-confirmed input-column type conversion with a
  stale-safe digest, conservative coercion, dependency blockers, table-level
  write exclusion, atomic cell migration, and actor audit events;
- type-aware text, finite-number, boolean, local-date-time/UTC, and JSON cell
  editors backed by a shared 256 KiB manual-value boundary;
- workspace-scoped envelope encryption for connector credentials;
- resumable deployment master-key rotation without rewriting provider-secret
  ciphertext;
- a hardened HTTPS connector with host allowlists, bounded responses, and
  stable idempotency keys;
- an Apache-2.0 versioned connector SDK with serializable JSON Schema
  manifests, fixed provider host policies, column and literal input bindings,
  and typed grid outputs;
- an optional publisher-signed, digest-pinned Wasmtime community-connector
  runner with no guest imports, bounded fuel/memory, authenticated RPC, and
  worker-mediated HTTPS effects;
- auditable community-connector transparency with frozen registry/artifact
  provenance, workspace-scoped publisher/connector/version/artifact emergency
  blocks, execution-time enforcement, and retained lift history;
- strict draft-2020-12 community credential/input/output validation and
  declarative multi-field BYOK forms without third-party browser code;
- built-in Hunter Domain Search and OpenAI Responses adapters, both executed
  with workspace-owned API keys and provider-pinned egress;
- previewed column-wide enrichment runs with frozen row selection,
  deployment-enforced row/request/token ceilings including retry exposure,
  resumable expansion, and live per-run progress;
- typed formula columns with a safe nested formula language, explicit
  dependency graphs, live type validation, and atomic chained recomputation;
- ordered two-provider HTTP waterfalls with resumable no-match checkpoints,
  per-provider idempotency, and configurable result paths;
- strict streaming CSV import with durable SQLite staging and restart-safe
  application;
- durable scheduled HTTPS JSON sources with stable-key upserts, schema
  evolution, bounded cursor pagination, encrypted restart checkpoints,
  pause/resume, missed-interval coalescing, and formula recomputation;
- native incremental HubSpot contact sources with fixed-host BYOK access,
  frozen modification windows, five-minute indexing lag, encrypted page
  cursors, and completion-gated cross-run watermarks;
- token-scoped push ingestion for Airbyte or any ELT tool, with bounded bodies,
  exact-request idempotency, SQLite capability-scoped staging, ordered durable
  application, stable-key upserts, one-time tokens, and revocation;
- a separately Apache-2.0-licensed Airbyte destination image implementing
  `spec`, authenticated `check`, batched `write`, safe HTTP retry, nested-value
  normalization, and application-complete state acknowledgement;
- an optional non-root ClickHouse analytics projector with strict terminal
  event schemas, independent SQLite leases and backoff, header-only
  credentials, and retry-safe `ReplacingMergeTree` storage;
- durable signed webhook row deliveries with immutable payload snapshots,
  command and workflow idempotency, guarded egress, and retry audit state;
- durable HubSpot contact writebacks with frozen property mappings, fixed-host
  egress, private-app BYOK credentials, conditional settled-row automation,
  semantic loop suppression, and per-delivery retry audit state;
- opt-in automatic row-settlement delivery with version coalescing, formula
  recomputation, and a durable settlement audit;
- dependency-driven automatic enrichment with manual-safe defaults, dirty-column
  coalescing, chained connector inputs, and deployment-level fan-out limits;
- opaque cursor pagination, a virtualized row viewport, row-scoped refreshes,
  and spreadsheet-safe streaming CSV export;
- shared saved views with bounded nested `AND`/`OR` typed filters, null-last
  server sorting, sort-aware keyset cursors, view-scoped CSV export, and
  schema-dependency blockers;
- view-scoped bulk enrichment with exact ordered-row confirmation digests,
  immutable view-definition snapshots, SQLite-resumable expansion, durable
  execution provenance, and creator-or-manager cancellation that discards late
  provider results;
- DNS-pinned worker egress that rejects private and reserved networks;
- bounded streaming request reads for every product JSON mutation,
  push-ingestion batch, and CSV import, with declared and observed byte
  enforcement;
- a canonical same-origin boundary for browser API mutations plus a fresh
  nonce-based script CSP on every application response, HSTS, no-referrer,
  anti-framing, MIME-sniffing, browser-capability, and framework-identification
  suppression headers;
- a Node.js workflow worker that resolves credentials just in time, records run
  provenance, and executes identifier-only SQLite outbox events locally by
  default, with Hatchet available as an optional scheduling adapter;
- non-root, multi-stage web and worker images with an opt-in migration-ordered
  Compose evaluation profile;
- a vendor-neutral Helm release with least-privilege runtime identities,
  pre-rollout migrations, external-secret support, secure pod defaults,
  default-deny runtime ingress, explicit egress-isolation controls, and opt-in
  connector-runner and ClickHouse-projector workloads;
- owner-only workspace deletion with an exact-name, stale-safe impact preview,
  active-work and operator-hold blockers, content-free audit receipts,
  transactionally scoped authorization, and retryable optional ClickHouse erasure;
- configurable HTTP enrichment columns delivered through a transactional
  outbox.

Additional provider-native incremental adapters and CRM object writebacks,
deployment-wide transparency-log/revocation distribution, destructive
provider deletion/reconciliation adapters, and provider-specific production
reference architectures are still in progress.
The generic HTTPS source supports explicit cursor pagination, and HubSpot
contacts provide the first fixed-host incremental read/write loop, but
provider-specific OAuth exchange and deletion-feed semantics are not
implemented. Scheduled snapshot sources do support
opt-in recoverable archival for records missing from a complete successful
snapshot; hard-delete propagation remains out of scope. The formula language exposes
the complete current expression function set without executing user-supplied
JavaScript. The current waterfall form authors two HTTP providers; its stored
format supports richer editors later.

## Architecture

- **Next.js** owns the product UI and local single-user control-plane API.
- **SQLite or libSQL** is the sole source of truth for workspaces, cells,
  credentials, workflow graphs, and execution state. A local file is the
  zero-configuration default.
- **SQLite-native execution** is the default workflow driver. It consumes the
  durable outbox and run ledgers without another service.
- **Hatchet** is an optional scheduling adapter for advanced deployments. Its
  internal PostgreSQL database belongs to Hatchet and is not application data.
- **TypeScript workers** decrypt credentials just in time and execute trusted
  connectors outside the web request lifecycle.
- **The connector SDK** separates Apache-2.0 manifests and execution contracts
  from the AGPL application; installed provider actions define their own fixed
  egress hosts.
- **Community connectors** execute in an optional Wasmtime sidecar without host
  imports. They describe HTTP effects that the guarded Node worker performs;
  installation requires an administrator-trusted Ed25519 publisher signature
  over the exact registry plus review of its manifests and artifact digests.
- **Connector trust operations** freeze artifact identity into columns and runs,
  expose signed provenance to workspace managers, and enforce online emergency
  blocks both before queueing and immediately before execution.
- **Local ownership** uses one deterministic internal owner and workspace-scoped
  repository queries. This preserves foreign keys and data boundaries without
  introducing accounts or sessions.
- **Typed formula ASTs** execute deterministic dependency chains inside the
  same SQLite write transaction as the triggering edit.
- **Table and schema authoring** creates each table with its first input column
  atomically, scopes selection by immutable ID, and enforces 100-table and
  256-column ceilings through immediate SQLite write transactions.
- **Input-column conversion** previews every explicit cell and integration
  dependency, binds confirmation to cell versions with a digest, and migrates
  values plus the declared type in one SQLite transaction.
- **Provider waterfalls** checkpoint completed no-match attempts so retries do
  not repeat already-consumed providers.
- **CSV imports** stream into tenant-scoped SQLite staging, then apply in
  restart-safe worker batches; Airbyte is not required for file ingestion.
- **Scheduled sources** are claimed with compare-and-swap leases, executed by
  the selected workflow driver, and upsert remote records through stable
  source-owned identities.
  Cursor sources commit each page and its encrypted next cursor atomically, so
  a retry resumes after the last durable page. Missing records are preserved by
  default; an opt-in mode archives them only after the complete snapshot and
  restores the same row if its stable key reappears.
- **HubSpot contact sources** search a frozen half-open modification window
  through fixed-host worker egress. Per-run page cursors are encrypted, while a
  source watermark advances only after the final page; incremental results
  never infer contact deletion.
- **Push ingestion** gives optional user-owned ELT adapters a stable HTTP
  destination; Next.js stages accepted batches under token-scoped SQLite
  capabilities, while the workflow worker applies rows, formulas, and
  automations asynchronously.
- **Outbound webhooks** snapshot one row transactionally, sign the exact body,
  and retry through the workflow worker without placing credentials in
  workflow history.
- **HubSpot writebacks** snapshot mapped scalar values transactionally and use
  a fixed-host connector to update one contact with a workspace-owned token.
  Optional settled-row triggers share the saved-view filter language, ignore
  unrelated edits, suppress identical payload loops, and enforce a deployment
  fan-out ceiling.
- **Row-settlement automations** version every logical row change and coalesce
  stale events before queueing dependency-driven enrichment or opted-in outbound
  destinations.
- **Grid reads** use keyset cursor pages and TanStack Virtual rather than loading
  or mounting an entire table.
- **Saved grid views** compile a bounded typed operator language into
  parameterized SQLite predicates; sorted cursors bind the view definition,
  typed value, empty bucket, and row ID so pagination remains stable.
- **Airbyte and ClickHouse are optional adapters**, not default dependencies;
  the ClickHouse projector consumes only allowlisted terminal metrics and never
  participates in product authorization or mutable state.
- **Workspace deletion** binds an owner-visible impact preview to the final
  transaction, removes the authoritative SQLite tenant cascade, retains a
  content-free receipt, and drives optional ClickHouse erasure independently.

See [the system architecture ADR](docs/adr/0001-system-architecture.md) for the
reasoning and boundaries.
See [the SQLite authority ADR](docs/adr/0035-sqlite-first-application-core.md)
for the current database contract and the status of older PostgreSQL modules.
Earlier ADRs remain as decision history; when their storage mechanics conflict,
the SQLite authority ADR is current.
See [the portable visual-workflow ADR](docs/adr/0036-portable-visual-workflow-execution.md)
for the React Flow authoring boundary, immutable graph versions, and durable
execution model.
See [the ingestion and grid-scaling ADR](docs/adr/0004-ingestion-and-grid-scaling.md)
for CSV, pagination, virtualization, and export decisions.
See [the connector protocol ADR](docs/adr/0005-versioned-connector-protocol.md)
for manifests, credentials, provider networking, and extension trust.
See [the community connector isolation ADR](docs/adr/0022-capability-constrained-community-connectors.md)
for artifact pinning, the no-import Wasm ABI, authenticated RPC, and declarative
HTTP effects.
See [the signed registry ADR](docs/adr/0029-signed-community-connector-registries.md)
for publisher trust, exact-byte signatures, secure defaults, and key rotation.
See [the connector transparency and revocation ADR](docs/adr/0031-workspace-connector-transparency-and-revocation.md)
for frozen run provenance, revocation precedence, tenant isolation, and
execution-time enforcement.
See [the push-ingestion ADR](docs/adr/0023-token-scoped-push-ingestion.md) and
[operator guide](docs/PUSH_INGESTION.md) for the provider-neutral Airbyte
boundary, token scope, idempotency, and batch lifecycle.
The optional adapter's commands, configuration, and data-mapping rules are in
[`packages/airbyte-destination`](packages/airbyte-destination/README.md).
See [the ClickHouse projection ADR](docs/adr/0024-optional-clickhouse-analytics-projection.md)
and [operator guide](docs/CLICKHOUSE_ANALYTICS.md) for delivery semantics,
deduplication, event schemas, and the opt-in Compose profile.
The practical registry, credential-form, schema, ABI, and review contract is in
[the community connector authoring guide](docs/COMMUNITY_CONNECTORS.md).
See [the historical row-level security ADR](docs/adr/0007-database-enforced-tenant-isolation.md)
for the superseded PostgreSQL boundary and the threat model carried forward by
SQLite workspace-scoped repositories.
See [the BYOK AI enrichment ADR](docs/adr/0008-byok-ai-enrichment.md) for prompt
snapshots, typed results, provider retention, and retry-cost boundaries.
See [the cost-aware bulk-run ADR](docs/adr/0009-cost-aware-bulk-runs.md) for
selection modes, confirmation limits, checkpoints, and usage accounting.
See [the cancellation ADR](docs/adr/0034-postgresql-authoritative-bulk-run-cancellation.md)
for authorization, count reconciliation, worker races, in-flight billing, and
the authoritative-store-versus-Hatchet boundary; its PostgreSQL mechanics are
superseded by the SQLite authority ADR.
See [the view-scoped bulk selection ADR](docs/adr/0021-view-scoped-bulk-selection.md)
for exact-set confirmation, saved-view ordering, and immutable provenance.
See [the bounded conditional filter-tree ADR](docs/adr/0026-bounded-conditional-filter-trees.md)
for recursive `AND`/`OR` semantics, complexity limits, and compatibility.
See [the scheduled-source ADR](docs/adr/0010-durable-scheduled-sources.md) for
schedule claiming, record identity, adapter trust, and the Airbyte boundary.
See [the incremental HubSpot source ADR](docs/adr/0028-incremental-hubspot-contact-source.md)
for frozen windows, indexing lag, paging checkpoints, and deletion semantics.
See [the source-reconciliation ADR](docs/adr/0025-completion-gated-source-reconciliation.md)
for completion gating, recoverable archival, and push-versus-snapshot semantics.
See [the signed-webhook ADR](docs/adr/0011-signed-webhook-deliveries.md) for
payload snapshots, receiver verification, retries, and writeback boundaries.
See [the row-settlement ADR](docs/adr/0012-row-settlement-automations.md) for
automatic readiness, version coalescing, and loop prevention.
See [the automatic-enrichment ADR](docs/adr/0013-dependency-driven-automatic-enrichment.md)
for dirty-column coalescing, cost ceilings, ordering, and connector chains.
See [the CRM-writeback ADR](docs/adr/0014-durable-hubspot-writebacks.md) for
mapping snapshots, fixed-host execution, retries, and exactly-once limits.
See [the conditional writeback ADR](docs/adr/0027-conditional-automatic-writebacks.md)
for settlement triggers, filter semantics, loop suppression, and fan-out limits.
See [the multi-table ADR](docs/adr/0015-multi-table-schema-authoring.md) for
schema limits, navigation scoping, and deferred deletion semantics.
See [the typed-input ADR](docs/adr/0016-typed-input-editing.md) for draft
coercion, UTC timestamps, JSON validation, and the manual-cell size boundary.
See [the type-conversion ADR](docs/adr/0030-previewed-atomic-input-column-type-conversion.md)
for the safe coercion matrix, stale-preview digest, advisory locking, blockers,
and irreversible canonicalization boundary.
See [the safe-formula-language ADR](docs/adr/0017-safe-formula-language.md) for
grammar limits, stable column references, deterministic literals, and the
no-eval boundary.
See [the container self-hosting ADR](docs/adr/0018-container-self-hosting-boundary.md)
for image contents, migration ordering, secrets, and the local/production
boundary. The practical operator checklist is in
[the self-hosting guide](docs/SELF_HOSTING.md).
See [the Kubernetes release ADR](docs/adr/0032-vendor-neutral-kubernetes-release.md)
and [operator guide](docs/KUBERNETES.md) for migration hooks, external Secret
ownership, workload isolation, and optional component boundaries.
See [the Kubernetes network security guide](docs/NETWORK_SECURITY.md) for
trusted ingress peers, explicit runtime egress, CNI/FQDN limitations, and
negative connectivity tests.
See [the Kubernetes NetworkPolicy enforcement drill](docs/KUBERNETES_NETWORK_POLICY_DRILL.md)
for candidate-bound behavioral evidence covering the exact trusted and denied
TCP paths with same-target availability controls.
See [the live Kubernetes verifier](docs/VERIFY_KUBERNETES_RUNTIME.md) for a
read-only digest, rollout, pod-security, ingress, and policy-shape evidence
record bound to a release candidate.
See [the Kubernetes secret-provenance verifier](docs/VERIFY_KUBERNETES_SECRET_PROVENANCE.md)
for a read-only External Secrets Operator v1 sync, store-health, and immutable
controller record that never fetches Secret data.
See [the workspace-purge ADR](docs/adr/0033-previewed-workspace-purge-and-cross-system-erasure.md)
and [retention guide](docs/DATA_RETENTION.md) for confirmation, legal holds,
receipts, analytics erasure, backups, and external-system boundaries.
See [the backup and restore guide](docs/BACKUP_RESTORE.md) for verified online
SQLite snapshots, safe new-file recovery, remote libSQL requirements, and
restore-drill evidence.
See [the authenticated Kubernetes worker drain drill](docs/KUBERNETES_WORKER_DRAIN_DRILL.md)
for isolated Hatchet registration, in-flight `SIGTERM`, clean restart, and
durable workflow-completion evidence.
See [the Kubernetes rollback drill](docs/KUBERNETES_ROLLBACK_DRILL.md) for a
controlled rollback to a named digest-pinned Helm revision and restoration of
the exact candidate with live workload and public-ingress verification.
See [the production capacity drill](docs/PRODUCTION_CAPACITY_DRILL.md) for a
declared HTTPS, remote-libSQL, and workflow concurrency envelope with
operator-owned latency and contention thresholds.
See [the stable production evidence contract](docs/PRODUCTION_EVIDENCE.md) for
the versioned external-gate manifest, candidate-source binding, observation
window, rollback proof, and named operator acceptance required by stable tags.
See [the multi-architecture image smoke guide](docs/MULTI_ARCH_IMAGE_SMOKE.md)
for digest-bound `amd64`/`arm64` entrypoint execution and retained release
evidence.
See [the release process](docs/RELEASING.md) and
[release verification guide](docs/VERIFY_RELEASE.md) for version gates, image
digests, generated digest-pinned Helm values, checksums, SBOM/provenance, and
GitHub attestations.
See [the observability guide](docs/OBSERVABILITY.md) for private worker
telemetry, the low-cardinality application metric contract, and replica-safe
alert aggregation.
See [the API transport security guide](docs/API_SECURITY.md) for application
body ceilings, edge alignment, compressed-body policy, and regression tests.
The current pass/fail evidence and the remaining stable-release blockers are in
[the production-readiness ledger](docs/PRODUCTION_READINESS.md).
Deployment key changes must use the overlapped procedure in
[the master-key rotation guide](docs/MASTER_KEY_ROTATION.md); replacing the
current key directly is not a supported rotation.
See [the recoverable schema lifecycle ADR](docs/adr/0019-recoverable-schema-lifecycle.md)
for preview recomputation, integration blockers, audit events, restoration, and
the boundary between archival and physical erasure.
See [the saved-view ADR](docs/adr/0020-saved-typed-grid-views.md) for typed
operators, sparse empty semantics, sort cursors, tenant isolation, and the
authoritative-store-versus-ClickHouse boundary.

## Local development

Prerequisites: Node.js 24 or newer and npm 11 or newer. Docker is needed only
for Hatchet, container evaluation, and optional services.

1. Copy `.env.example` to `.env`. Generate `BYOK_GRID_MASTER_KEY` with
   `openssl rand -base64 32`.
2. Run `npm install`.
3. Run `npm run db:migrate`. This creates the local `data/` directory and
   applies the SQLite schema explicitly.
4. Run `npm run dev`.

Open <http://localhost:3000>; it redirects directly to the local workspace.
There is no signup or sign-in flow. The repository-root `.env` file is
loaded by the web app, worker, and migration tools regardless of the directory
from which their workspace command runs.

The public marketing website is an independent, static-first Next.js workspace
with no database or product secrets. Run `npm run dev:marketing` and open
<http://localhost:3001>. Its Vercel setup and isolation boundary are documented
in [`docs/MARKETING_SITE.md`](docs/MARKETING_SITE.md).

To evaluate the built web and workflow-worker images, run
`npm run self-host:up`. No scheduler service or token is required by the
default SQLite-native execution driver.
Compose persists the authoritative SQLite file in its own named volume. See
[the self-hosting guide](docs/SELF_HOSTING.md) for the image commands and
production requirements.

The local application does not need Docker, PostgreSQL, Airbyte, ClickHouse, or
Hatchet for grid authoring or workflow execution.

To execute published visual workflows locally, stop the web-only dev process
and run `npm run dev:workflows`. This starts the Next.js app and the
SQLite-native Node
workflow worker. Table triggers, filters, table writes, and signed outbound
webhook nodes execute from SQLite-owned plans and run ledgers. Connector
enrichment nodes expand into deterministic per-cell runs, including signed
community connectors when the sandbox runner is configured. Scheduled HTTP and
HubSpot sources use the same worker, with SQLite-owned checkpoints and encrypted
page cursors. `npm run dev:all` additionally starts optional workspace
development processes; `npm run dev:workflows` is the focused contributor path.
To exercise the optional Hatchet adapter, set
`WORKFLOW_EXECUTION_DRIVER=hatchet`, run `npm run infra:up`, configure the
development token, and start the same worker command.

## Verification

```text
npm run format:check
npm run lint
npm run lint:connector-runner
npm run typecheck
npm test
npm run test:connector-runner
npm run build
npm run helm:verify
npm run release:verify-version
npm run pack:connector-sdk
npm audit
npm run benchmark:grid
```

After a digest-pinned candidate is installed behind its real HTTPS ingress, run
the read-only checks in
[`docs/VERIFY_DEPLOYMENT.md`](docs/VERIFY_DEPLOYMENT.md).
Multi-host candidates must also complete the isolated provider process-loss and
restore procedure in
[`docs/REMOTE_LIBSQL_DRILL.md`](docs/REMOTE_LIBSQL_DRILL.md).

SQLite integration tests run in the default suite against isolated temporary
databases. Historical PostgreSQL compatibility tests remain opt-in and require
a separately prepared legacy database; they are not part of the shipped runtime:

```text
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:55432/byok_grid \
  npm test --workspace=@byok-grid/db
```

The legacy public-network tests remain separately opt-in. The SQLite web smoke
test needs the local Next.js app and workflow worker to be running and exercises
local-owner and personal-workspace provisioning, the built app, draft workflow
editing, publication, and durable run creation:

```text
RUN_SQLITE_WEB_E2E=1 TEST_APP_URL=http://127.0.0.1:3000 \
  TEST_SQLITE_DATABASE_URL=file:/absolute/path/to/test.sqlite \
  npm test --workspace=@byok-grid/web -- src/workflow-sqlite.e2e.test.ts
```

## Community and support

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change and the
[support policy](SUPPORT.md) before asking for help or reporting a defect.
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).
Suspected vulnerabilities must follow the private process in
[SECURITY.md](SECURITY.md), never a public issue.
