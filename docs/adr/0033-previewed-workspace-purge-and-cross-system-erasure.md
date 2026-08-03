# ADR 0033: Previewed workspace purge and cross-system erasure

- Status: Accepted
- Date: 2026-08-01

## Context

Recoverable table and column archival is appropriate for ordinary schema
management, but it cannot satisfy an owner's request to erase an entire
workspace. A direct `DELETE /workspace` endpoint would also be unsafe: it could
race active work, conceal the affected scope, bypass an operator retention
hold, or remove PostgreSQL state while leaving an optional ClickHouse projection
indefinitely queryable.

Self-hosters additionally have different legal, backup, and receipt-retention
requirements. The application must provide secure mechanics without pretending
that it can erase operator backups or third-party provider copies.

## Decision

Workspace deletion is an owner-only, previewed operation with exact-name and
explicit irreversible confirmation. The preview returns aggregate impact,
blockers, and a versioned digest. The delete transaction takes a workspace
advisory lock, recomputes that preview, inserts a minimal content-free receipt,
and removes the workspace root only when every confirmation still matches.
Foreign-key cascades perform the authoritative tenant erasure.

Queued, staging, and running records block deletion. An operator-only hold table
has no application mutation policy; the forced-RLS workspace delete policy also
checks it so application omissions fail closed. The receipt deliberately has no
workspace foreign key and survives the cascade. It stores only opaque IDs,
reason, aggregate impact, digest, timestamp, and analytics-erasure state.

The optional analytics projector treats receipts as a second durable work
queue. It filters leased events for purged workspace IDs immediately before
insertion, waits at least one hour for in-flight leases to drain, then performs
an idempotent parameterized ClickHouse lightweight delete. Claim leases,
sanitized failures, bounded retry, and completion time are recorded on the
receipt. PostgreSQL deletion never waits for ClickHouse availability.

## Consequences

- Live PostgreSQL deletion is atomic and stale previews cannot authorize a
  changed scope.
- Legal holds are enforced even if a caller attempts a lower-level workspace
  delete through the web database role.
- The optional analytics system remains unavailable independently without
  weakening the product database's deletion semantics.
- ClickHouse query visibility is removed synchronously when its delete succeeds,
  while physical byte reclamation remains merge-dependent.
- The one-hour grace delays analytics erasure but closes the leased-event
  reinsertion race without coupling the projector to the purge transaction.
- A minimal receipt remains until the operator applies a documented retention
  schedule; it is an audit/checkpoint record, not deleted tenant content.
- Backup expiry, restored-backup reconciliation, user-managed Airbyte state,
  downstream copies, and provider retention remain explicit operator duties.

See the [workspace deletion and retention guide](../DATA_RETENTION.md) for the
runtime procedure and operational boundaries.
