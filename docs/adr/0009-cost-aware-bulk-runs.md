# ADR 0009: Cost-aware, resumable bulk enrichment runs

- Status: Accepted
- Date: 2026-07-31

## Context

Per-cell execution proves the connector boundary but does not provide the core
workflow of an enrichment grid: running one column across many rows. A direct
browser loop would be non-durable, bypassable, hard to observe, and capable of
creating an unbounded provider bill. A mutable offset is also unsafe because
rows can be inserted, deleted, or reordered while a batch is expanding.

## Decision

The Next.js control plane previews a bulk run before accepting it. A preview
counts rows with all bound source cells present, applies a selection mode, and
reports the exact selected count plus maximum provider requests across every
configured retry attempt. OpenAI columns also report the configured maximum
output tokens across the selection and the same retry exposure.

The deployment enforces three independent ceilings:

- `BULK_RUN_MAX_ROWS`;
- `BULK_RUN_MAX_PROVIDER_REQUESTS`; and
- `BULK_RUN_MAX_OUTPUT_TOKENS`.

The user confirms the preview's exact selected count and selection digest.
Creation repeats the preview inside an immediate SQLite transaction; any change
to the ordered row IDs or saved-view definition returns a conflict instead of
accepting stale intent. The transaction inserts a batch, an immutable selection
snapshot, the exact ordered row IDs as batch items, and one outbox event.

Hatchet runs one idempotent expansion task per batch ID. Each immediate
database transaction serializes the batch, processes at most the configured chunk size, and
turns pending items into ordinary cell runs and cell-run outbox events. Batch
item state is the retry checkpoint. Existing queued or running cells are never
duplicated. Rows that lose required inputs are marked skipped rather than
being replaced by newly eligible rows.

`pending` mode excludes successful, queued, and running target cells. `all`
mode includes successful targets but still excludes active work. The shared
domain policy is the only place that defines this behavior.

Successful OpenAI runs write validated token counts to the workspace usage
ledger. Batch progress aggregates expansion, execution, and actual token usage.
The existing estimated-cost field remains unset until a trustworthy,
operator-controlled pricing source exists.

## Consequences

- Confirmation is stable in rows, requests, and maximum output tokens, not in
  currency. Provider-side budgets remain necessary.
- A preview is read-only and may become stale; creation detects membership,
  ordering, and saved-view-definition changes even when the count is unchanged.
- Source values freeze when each selected item becomes a cell run. The row set
  itself freezes at confirmation.
- Expansion completion does not imply provider completion. The progress API
  reports these phases separately.
- Batch and item tables live in the authoritative SQLite/libSQL database;
  repository membership predicates protect control-plane reads and writes.
- SQLite-authoritative cancellation stops remaining expansion, cancels
  queued/running child state, and requires compare-and-set worker transitions;
  see [ADR 0034](0034-postgresql-authoritative-bulk-run-cancellation.md).
