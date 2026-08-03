# ADR 0025: Completion-gated source reconciliation

## Status

Accepted

## Context

A remote record missing from one response may be deleted, temporarily filtered,
or simply absent because a paginated or failed sync is incomplete. Treating
every omission as deletion would make transient provider failures destructive.
Push and Airbyte deliveries are bounded batches, not authoritative snapshots.

## Decision

Scheduled sources expose an explicit `preserve | archive` missing-record mode
and default to `preserve`. Every received stable key records the current source
run as `last_seen_run_id`. Only the transaction that commits the final page and
marks the run successful may reconcile identities not seen in that run.

In `archive` mode, reconciliation timestamps both the row and its source
identity and records the responsible source-run ID. Normal grid reads, edits,
bulk runs, enrichment, formulas, webhooks, writebacks, and exports select only
active rows. Cells, execution history, and the stable identity remain intact.
If the key reappears, the source restores the same row ID before updating its
cells and reports the restoration in the run metrics.

Push ingestion remains PATCH-like: omitted records and omitted fields are
preserved, while explicit null or an empty string clears a mapped cell. The
Airbyte destination therefore continues to advertise append-oriented modes and
does not translate a delivery boundary into deletes.

## Consequences

- Failed, partial, retried, or limit-truncated source runs cannot archive rows.
- Empty successful snapshots may archive all currently active rows owned by an
  opted-in source.
- Archival is recoverable and auditable; hard deletion and retention expiry are
  separate future policies.
- PostgreSQL remains the authority. ClickHouse receives only aggregate archived
  and restored counts after a terminal success event.
