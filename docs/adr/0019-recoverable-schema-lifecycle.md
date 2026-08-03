# ADR 0019: Recoverable schema lifecycle

- Status: Accepted
- Date: 2026-08-01

## Context

A collaborative grid must let operators remove obsolete tables and columns from
the active workspace. Hard deletion is unsafe because schema resources are
referenced by cells, formula dependency edges, source and writeback mappings,
queued workflows, usage records, and retained delivery history. Database
`ON DELETE CASCADE` behavior is a referential-integrity mechanism, not a product
retention policy.

The lifecycle also needs a recovery path and durable actor evidence. A browser
confirmation alone cannot protect against races where work or dependencies are
created after the preview but before mutation.

## Decision

BYOK Grid implements archive and restore, not hard deletion.

- Active tables and columns have `archived_at = null`. Product reads and
  mutation entrypoints reject archived resources.
- Only workspace owners and administrators have `schema.manage` permission.
- A preview reports retained rows, cells, runs, dependencies, mappings,
  automations, and in-flight work before archival.
- The archive service acquires the same advisory namespace lock used by schema
  creation, rebuilds the preview inside the transaction, verifies an exact-name
  confirmation, and refuses every current blocker.
- A workspace must retain one active table and every active table must retain
  one active column.
- Active dependent columns, queued or running work, active sources, active
  webhook/writeback destinations, and active source/writeback mappings block
  the relevant archive operation.
- Paused mappings may continue to reference an archived column, but they cannot
  be resumed until every mapped column is restored.
- Restore preserves immutable resource IDs, values, configuration, dependency
  edges, and run history. A computed column cannot be restored before its
  archived dependencies.
- Every transition appends an actor-bound snapshot to
  `schema_lifecycle_events`. Forced PostgreSQL RLS restricts audit reads and
  inserts to owners and administrators in that workspace.

Archived names continue to participate in uniqueness and resource ceilings.
This prevents archive/create cycles from bypassing limits and avoids ambiguous
restoration.

The UI uses a read-only preview followed by exact-name confirmation. Its native
form fallback is a harmless POST to the page, so a pre-hydration submission
cannot perform the mutation.

## Airbyte and ClickHouse boundary

PostgreSQL owns lifecycle state and audit evidence. Optional Airbyte adapters
must treat an archived destination table as unavailable. Optional ClickHouse
projections may mirror lifecycle events, but they are rebuildable consumers and
cannot authorize archive or restore operations.

## Consequences

- Operators can remove schema from active work without losing recoverability or
  audit history.
- Archival can require pausing integrations or waiting for work, which makes the
  dependency cost explicit instead of silently destroying it.
- Physical erasure, retention windows, legal holds, storage reclamation, and
  workspace-wide purge remain a separate future design.
