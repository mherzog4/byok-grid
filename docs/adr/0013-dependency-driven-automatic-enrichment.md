# ADR 0013: Dependency-driven automatic enrichment

- Status: Accepted
- Date: 2026-07-31

## Context

A Clay-like table should continue an enrichment chain when an input, formula, or
upstream connector output changes. Running every connector on every row change
would waste provider credits, while invoking connectors directly in the write
transaction would couple interactive edits to remote availability. Rapid edits
and parallel connector completions can also make an older event stale without
making its changed columns irrelevant.

## Decision

Every connector column stores a `runMode` of `manual` or `on_change`; the default
is `manual`. Connector dependencies continue to use stable column IDs in
`column_dependencies`. HTTP and waterfall columns may use input, formula, or
earlier connector columns as their source, so connector chains do not require a
separate workflow language.

A logical row mutation stores the IDs of the columns it changed on the same
versioned `row_settlements` record used by settled-row webhooks. A connector
success includes its output column and any formulas changed in the same
transaction. A connector failure records a terminal mutation with no changed
output ID, allowing webhook settlement without falsely waking downstream
providers. Merely queueing a connector run does not increment the row version.

The settlement worker opens an immediate SQLite write transaction and reads all
unconsumed candidates through the current row version. It unions their
dirty-column sets and selects direct dependent connector columns whose
`runMode` is `on_change`.
Target cells already queued or running are not queued again. Candidate column
IDs are deduplicated and sorted before queueing, giving deterministic behavior.
The worker stores which newer settlement consumed each older candidate, so a
stale event can be audited without losing a parallel completion's dirty set.

When automatic dependents are queued, webhook delivery waits. Their terminal
results create later settlement candidates, which advance the next dependency
layer. A settled-row webhook is snapshotted only when there are no further
eligible automatic runs and no queued or running cells. Hatchet workflow
idempotency, the unique row/version settlement constraint, active-cell checks,
and transactional run/outbox inserts prevent duplicate queueing during retries.

The worker enforces `AUTOMATIC_RUN_MAX_PER_ROW_CHANGE`, defaulting to 10 and
bounded from 1 through 100. If the eligible fan-out exceeds that ceiling, the
whole fan-out is marked failed and no provider is queued. This avoids letting
column sort order silently decide which provider incurs cost. The limit counts
connector columns; a waterfall can still consume several provider requests and
must communicate that separately.

The current creation UI only allows a new connector to depend on columns that
already exist. This produces a creation-ordered directed acyclic graph. A future
dependency editor must perform an explicit cycle check before it can relax that
constraint.

## Consequences

- Interactive writes remain local and fast; durable workers own all provider
  execution.
- Parallel changes coalesce without dropping dependencies, and different rows
  can still advance concurrently.
- Manual is a safe upgrade default, while automatic behavior is visible in each
  column's configuration and creation form.
- The fan-out ceiling bounds simultaneous connector columns, not total provider
  price. Per-provider budgets, debounce windows, filters, and scheduled refresh
  policies remain future policy layers.
- SQLite/libSQL remains the correctness boundary. Airbyte may emit logical row
  changes and ClickHouse may project automation metrics, but neither belongs in
  the execution path.
