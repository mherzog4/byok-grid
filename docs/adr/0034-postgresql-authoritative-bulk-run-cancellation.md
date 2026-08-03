# ADR 0034: SQLite-authoritative bulk-run cancellation

- Status: Accepted
- Date: 2026-08-01

## Context

Bulk enrichments can expand into many metered provider calls. A user needs a
durable way to stop remaining cost after confirming a batch, including when the
Hatchet service is unavailable or the browser retries its request.

Hatchet can cancel workflow runs by orchestrator run ID and exposes cooperative
cancellation signals inside tasks. BYOK Grid does not persist those IDs, and
the Next.js control plane intentionally has no Hatchet management credential.
Making the product state depend on an orchestrator cancellation call would add
a second authority and couple the public API to one workflow provider.

An external request may already have reached a provider when cancellation is
requested. No distributed workflow system can truthfully guarantee that such a
request was not processed or billed.

## Decision

SQLite is the cancellation authority. The batch resource exposes an
idempotent `DELETE` operation with these rules:

- the batch creator may cancel their own queued or running batch;
- workspace owners and administrators may cancel any batch;
- peer members and outsiders receive the same not-found boundary;
- completed and failed batches remain immutable; and
- repeated cancellation returns the original cancellation record.

An immediate write transaction serializes the batch, marks pending items skipped before expansion,
marks its queued or running child cell runs and cells cancelled, records the
actor and timestamp, reconciles the skipped count, and commits one terminal
batch state. The expansion worker takes the same immediate-write boundary and treats
`cancelled` as terminal, so it cannot queue later items after that commit.

Cell workers use conditional state transitions. Only `queued` may become
`running`, and only `running` may become retrying, succeeded, or failed. If a
provider response loses that comparison to cancellation, the result is
discarded before cell mutation, formula recomputation, row settlement, usage
ledger writes, or terminal analytics events.

## Consequences

- Cancellation works across local or hosted Hatchet and remains portable to a
  future workflow engine.
- Next.js does not receive Hatchet management credentials.
- The database prevents cancelled work from being resurrected by a late worker
  transition.
- Previously succeeded or failed child runs retain their actual outcome;
  historical queued and skipped counts are not rewritten.
- A request already accepted by a provider may complete and may still be
  billed. Its late result is ignored, and the UI states this limitation before
  confirmation.
- Hatchet-native abort propagation could be added later as a best-effort cost
  optimization if orchestrator run IDs are durably captured. It must not replace
  the SQLite terminal-state checks.
