# ADR 0012: Versioned row-settlement automations

- Status: Accepted
- Date: 2026-07-31

## Context

Manual webhook delivery proves the outbound protocol, but a Clay-like workflow
must also continue after data changes without depending on an open browser tab.
“Complete” is not a single cell event: multiple connector runs can overlap,
formulas must reflect the newest connector output, and a newer edit can make a
previous completion event stale before it is processed.

Running the webhook snapshot directly inside connector finalization would
couple receiver limits to paid provider work. For example, an oversized row
could roll back a successful connector result and cause the provider request to
run again.

## Decision

Webhook destinations explicitly choose `manual` or `row_settled`. The default
remains manual, so upgrading or creating a destination never starts unexpected
egress. Pausing a destination prevents new automatic deliveries; resuming does
not backfill skipped versions.

Every logical row data mutation increments `rows.version`. This includes input
edits, CSV/source writes, formula backfills, and terminal connector results.
Queueing a connector changes execution state but not row data, so it does not
advance the version. A row is settled when no cell is `queued` or `running`;
failed and cancelled cells are terminal and remain visible in the payload.

When an active automatic destination or automatic dependent column exists, the
same transaction inserts one `row_settlements` record for
`(row_id, row_version)` in SQLite/libSQL and an IDs-only outbox event. Hatchet
runs `process-sqlite-row-settlement` separately from the connector task. The
Node worker verifies the authoritative SQLite row version, advances eligible
automatic dependents first, and snapshots the row only after no queued or
running cell remains. A stale candidate is marked `skipped`, but its
dirty-column set remains available for a newer candidate to consume.

Automatic delivery idempotency is enforced twice:

- one settlement may exist for each row version; and
- one automatic delivery may exist for each destination, row, and row version.

The settlement transaction also recomputes formulas after connector success
before it records a candidate. An invalid or oversized snapshot fails the
settlement task rather than rolling back or repeating the provider request.

## Consequences

- Automatic behavior is durable, observable, and independent of browser
  lifetime.
- Rapid edits coalesce safely: obsolete row versions are audited as skipped and
  are never delivered.
- Input edits and ingestion can create many candidates, so operators must opt in
  per destination and receivers must deduplicate by delivery ID.
- Debounce windows remain a later policy. Dependency-driven auto-run is
  specified separately in ADR 0013, and bounded conditional HubSpot writeback
  subscribes to this settlement record through ADR 0027.
- SQLite/libSQL owns row versions and settlement state. ClickHouse may project
  append-only metrics later, and Airbyte adapters may create row mutations, but
  neither is required for automation correctness.
