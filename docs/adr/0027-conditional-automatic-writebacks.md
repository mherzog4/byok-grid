# ADR 0027: Conditional automatic writebacks

## Status

Accepted.

## Context

Manual HubSpot writeback freezes a safe scalar payload, but a Clay-like workflow
needs qualified rows to update a CRM after enrichment settles. Triggering on
every cell mutation would observe partial formulas, repeat work for stale row
versions, and allow an ingestion/writeback loop to generate unbounded external
updates.

The product already has two useful primitives: versioned row settlement waits
for dependency-driven enrichment, and the bounded filter AST gives grid reads,
exports, and bulk runs one definition of row qualification.

## Decision

A HubSpot destination chooses `manual` or `row_settled`. Automatic mode requires
a non-empty canonical filter tree. The destination stores that tree, validates
all referenced active columns and typed operators, and evaluates it with the
same parameterized SQLite compiler as saved views.

A row mutation creates settlement work for a writeback only when the dirty
column set intersects the destination's record-ID column, mapped columns, or
condition leaves. The settlement worker first advances automatic enrichments
and waits for all active cells to finish. It then evaluates each relevant active
destination against the exact current row version. Failed, stale, cancelled,
queued, or running mapped cells do not produce a writeback payload.

Each automatic delivery freezes the condition tree beside its immutable payload
and records `row_settled` as its trigger. A unique destination/row/row-version
index makes settlement replay idempotent. A second unique key uses a SHA-256
fingerprint of adapter, remote record ID, and sorted scalar property values; it
suppresses an ingestion loop that writes identical values back under a later
local row version. Manual commands are excluded from semantic deduplication so
an operator retains an explicit retry path.

The worker enforces `AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE`, defaulting to five.
If more valid matching destinations would run, the transaction queues none and
marks the settlement failed. Destination ordering never selects a silent
prefix. SQLite/libSQL owns conditions, exact row versions, deduplication, and
audit history; Hatchet executes the already-frozen commands. Airbyte and
ClickHouse do not participate in the decision.

## Consequences

- Qualified rows can update HubSpot without an open browser or a second rule
  language.
- Unrelated edits avoid settlement work, identical source loops converge, and
  over-broad configuration fails closed before external effects are queued.
- A changed payload may legitimately produce another writeback for a later row
  version. Provider-side audit and rate controls remain necessary because an
  ambiguous HTTP timeout can repeat one frozen command.
- Automatically skipped rows with missing record IDs or unsettled mapped cells
  do not create delivery records. A future automation-decision ledger may make
  these non-delivery reasons visible without weakening the current safety rule.
- New CRM object adapters must preserve the same settlement, filter, immutable
  snapshot, semantic-deduplication, and fan-out boundaries.
