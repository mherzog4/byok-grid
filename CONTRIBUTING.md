# Contributing

Thank you for helping build BYOK Grid. The name is a working codename; avoid
adding branding or copy that implies affiliation with Clay.

## Development flow

1. Follow the local setup in `README.md`.
2. Keep control-plane work in `apps/web` and long-running provider and workflow
   work in `apps/workflow-worker`. `apps/worker` is historical PostgreSQL
   compatibility code and is not part of the shipped runtime.
3. Put shared invariants in `packages/domain`, database behavior in
   `packages/db`, protocol types in `packages/connector-sdk`, installed
   connector behavior in `packages/connectors`, and cryptography in
   `packages/security`.
4. Generate a committed migration after changing the Drizzle schema.
5. Run the workflow policy verifier, formatting, linting, type checks, tests,
   the production build, and the dependency audit before opening a pull
   request.

## Architectural guardrails

- Never place connector secrets in browser state, API responses, workflow
  payloads, logs, or traces.
- Keep every external GitHub Action on a full commit SHA, disable checkout
  credential persistence, declare job permissions and timeouts, and run
  `npm run ci:verify-workflows` after workflow changes. Privileged trigger
  handoffs are outside this repository's CI trust model.
- Never persist or log a raw workspace invitation token. Role checks and role
  transitions must use the shared workspace policy rather than route-local
  comparisons.
- Every tenant-owned query must include workspace scope; the database schema
  should enforce the same boundary where practical.
- Web requests may enqueue work, but must not perform metered enrichment calls.
- SQLite/libSQL remains authoritative. ClickHouse projections and Airbyte adapters
  must be optional.
- Source adapters must define bounded responses, stable record identity,
  checkpoint and retry behavior, credential scope, egress capabilities, and
  missing-record semantics. Do not dynamically install executable packages in
  the web or worker process.
- Cursor sources must commit a page and its encrypted next cursor atomically.
  Never put raw cursors in URLs retained by workflow history, logs, outbox
  payloads, or API responses, and never mark a limit-truncated run successful
  without an explicit product policy.
- Missing-record reconciliation must default to preserve, archive only after a
  complete successful scheduled-source snapshot, retain source-run provenance,
  and restore the original row ID when a stable key reappears. Push and Airbyte
  deliveries are not complete snapshots and must never infer deletions.
- Incremental provider sources must freeze their query window on the run,
  advance the source watermark only after the terminal page, retain a bounded
  provider-indexing lag, and reject missing-record archival. Provider property
  selection cannot become arbitrary request construction, and per-run cursors
  must remain distinct from cross-run watermarks.
- Airbyte destination changes must preserve one endpoint per stream, exact
  protocol-only stdout, secret redaction, redirect denial, retry-stable POST
  bytes and idempotency keys, and the rule that input `STATE` is acknowledged
  only after all preceding BYOK Grid batches succeed.
- Analytics changes must preserve an explicit terminal-event allowlist,
  event-specific strict payload parsing, projection-specific leases independent
  of Hatchet `published_at`, bounded secret-redacting HTTP behavior, and
  SQLite authority. At-least-once retries require an event-ID deduplication
  design; never forward arbitrary outbox JSON or make core work wait for
  ClickHouse.
- Workspace purge changes must preserve the stale-safe impact digest, exact-name
  and irreversible confirmation, active-work blocker, short serialized SQLite
  write, root foreign-key cascade, operator hold in the delete policy, and the
  content-free receipt. Optional ClickHouse erasure must remain idempotent,
  retryable, grace-delayed against leased events, and unable to block the
  authoritative SQLite transaction. Never put deleted names, cell values,
  credentials, provider payloads, or other tenant content in a purge receipt.
- Table/schema mutations must preserve atomic table-plus-first-column creation,
  immutable ID references, case-insensitive duplicate rejection, and the
  concurrency-safe 100-table/256-column ceilings. Do not add destructive schema
  endpoints without dependency previews and explicit audit-retention behavior.
  Archive/restore changes must recompute blockers inside the schema write
  lock, retain immutable IDs and history, preserve the last active table/column,
  and append an actor-scoped lifecycle event. Table and column archival must not
  be repurposed as workspace erasure.
- Treat saved-view operators as a query language. Add them through the shared
  discriminated union, validate them against the column type, keep authored
  values parameterized, and extend sorted-cursor and archival-dependency tests.
  Preserve the filter-tree predicate, depth, and per-group fanout ceilings;
  recursive SQL may combine only allowlisted branches and must be shared by the
  grid, exports, and bulk selection. Never accept authored SQL or unbounded
  recursive groups.
- Editable input types must reuse the shared `CellValue` discriminant and
  byte-accurate 256 KiB manual-value limit. Do not add browser-only coercion,
  accept non-finite numbers, store local timestamps without UTC conversion, or
  silently stringify invalid JSON.
- Existing-column type conversion must remain previewed and all-or-nothing,
  revalidate its digest under the exclusive table cell-schema lock, preserve
  explicit empty cells, and append the lifecycle audit event in the same
  transaction. Every cell-producing path must take the matching shared lock.
  Do not broaden the coercion matrix without domain tests and a documented
  ambiguity/data-loss decision, or make Airbyte or ClickHouse authoritative for
  the mutation.
- Formula language changes must compile to the shared `FormulaExpression` AST,
  remain deterministic, and preserve the 16,384-character, 12-level, and
  128-node ceilings. Never add `eval`, `Function`, SQL fragments, implicit
  network access, locale-dependent timestamps, or client-only validation.
- Outbound adapters must snapshot approved data before queueing, use durable
  idempotency, keep secrets and receiver bodies out of retained workflow state,
  reuse guarded egress, and document which response classes retry. Logical row
  mutations must increment the row version and record dirty column IDs in the
  same transaction when automatic consumers exist. Queue-state transitions must
  not masquerade as new row data. Automatic triggers must coalesce stale
  versions and include explicit cost, loop, filtering, and event-storm analysis.
- CRM writeback adapters must pin provider hosts, validate a provider-specific
  scalar payload, decrypt credentials only in the worker, preserve delivery-ID
  idempotency, classify retryable statuses, and document ambiguous-timeout
  behavior. Automatic writeback must remain settlement-gated, react only to
  mapped/identity/condition columns, snapshot its condition, enforce the worker
  fan-out limit, and deduplicate semantic payloads independently of row version.
  Never turn a writeback mapping into an arbitrary HTTP request.
- Connector retries must document their idempotency or reconciliation behavior.
- Bulk-run changes must freeze exact row IDs, preserve the preview-confirmation
  digest check, retain immutable selection provenance, enforce limits on the
  server, and resume only pending batch items. A saved-view run must apply its
  typed sort before `rowLimit`; never derive identity or ordering from a mutable
  row count. Cancellation must keep SQLite authoritative, preserve terminal
  completed/failed history, reconcile pending items under the batch lock, and
  remain idempotent. Cell workers may transition only queued runs to running
  and running runs to retry/terminal states; never let a late provider result
  overwrite cancellation or trigger formulas, settlements, usage, or analytics.
- Formula changes must preserve stable column-ID references, validate the
  expression tree, and reject dependency cycles; never evaluate workspace code.
- Waterfall changes must freeze provider order and inputs, checkpoint completed
  attempts, and preserve the policy seam in `packages/domain`.
- Import changes must preserve strict streaming limits, ordered staging,
  atomic batch checkpoints, and cleanup behavior. Never buffer a complete CSV.
- Grid list endpoints must use keyset cursors; offset pagination and unbounded
  cell snapshots are not accepted for product paths.
- Connector networking must use the guarded worker egress dispatcher; direct
  use of global `fetch` is not permitted in connector execution.
- Connector definitions must use strict credential/input schemas, validate
  provider output, classify retryability, and declare fixed provider hosts.
  Declare whether every input is a row-varying column or a column-wide literal,
  and project a typed visible cell separately from the full audit output.
  Community artifacts must preserve the ADR 0022 no-import ABI, digest pin,
  fixed-host manifest, authenticated sidecar RPC, independently verified signed
  registry, frozen column/run provenance, queue-time plus execution-time
  revocation checks, and worker-mediated effect loop. Never commit publisher
  private keys, weaken the signed-registry secure default, reinterpret an
  unpinned legacy run, delete revocation history, or load third-party executable
  packages into the web or worker process.
- Community credential UI must remain declarative and exactly match a closed
  credential JSON Schema. Schema changes must preserve strict draft-2020-12
  compilation, complexity ceilings, no remote references, no async validation,
  and no data coercion/defaulting/removal. Never render connector-owned HTML,
  React, JavaScript, or arbitrary schema widgets in the control plane.
- New default infrastructure requires an ADR explaining its operational and
  licensing cost.
- Container changes must keep application credentials separate from Hatchet's
  private database, preserve the non-root runtime user, keep secrets out of build arguments, and
  leave the auth-disabled local Hatchet image outside the production boundary.
- Helm changes must preserve migration-hook ordering, component-specific Secret
  references, external libSQL/Hatchet ownership, secure pod defaults, and
  successful minimal plus fully optional renders through `npm run helm:verify`.
  Database changes deployed by the hook must remain backward-compatible with
  the previous application image because Helm rollback does not undo them.
- Do not claim database-enforced row-level security for SQLite. Every product
  repository query must scope immutable workspace, table, row, and column IDs,
  and adversarial integration tests must cover cross-tenant access.
- Streaming paths should open one short SQLite transaction per durable batch;
  never hold a transaction open across network or provider calls.

## Tests

Unit tests and SQLite integration tests run with `npm test`; SQLite fixtures use
isolated temporary files. A bug fix should include a test that fails for the
original behavior. Legacy PostgreSQL compatibility tests use `TEST_DATABASE_URL`.
Historical RLS tests additionally use
`RLS_DATABASE_URL` and `RLS_WORKER_DATABASE_URL`; they must exercise a genuine
`NOBYPASSRLS` web role rather than a superuser.

## Commit scope

Keep changes focused and include migration, documentation, or ADR updates when
behavior or architectural boundaries change. Do not commit `.env` files,
tokens, generated build output, or provider credentials.
