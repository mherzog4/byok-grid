# ADR 0001: Transactional core with separate durable workers

- Status: Accepted
- Date: 2026-07-31

## Context

A single enrichment cell can make a metered third-party request, retry after a
transient failure, wait for an upstream cell, stop a waterfall, and invalidate
dependent cells when its inputs change. Provider credentials must never enter
browser state, workflow histories, or logs.

The default self-hosted installation must also remain understandable to an
individual contributor. Optional scale components cannot become mandatory
before evidence justifies them.

## Decision

Use a TypeScript monorepo with two runtime processes:

1. A Next.js application for the UI and control-plane API.
2. A long-running worker for connectors and enrichment execution.

PostgreSQL is the sole source of truth. Hatchet provides durable scheduling and
uses a separate `hatchet` database on the same PostgreSQL server in local
development. Workflow payloads contain opaque identifiers, never credentials.
The control plane writes run state and an outbox event in one transaction. A
worker-side dispatcher delivers unpublished events to Hatchet with run-level
idempotency, allowing queue outages to recover without losing committed work.

The initial product data model uses typed sparse cells rather than one JSONB
document per row. This avoids serializing concurrent column enrichments behind
a lock on the same row and provides reusable indexes for user-defined columns.

Deterministic formulas are stored as a constrained, versioned expression tree.
Column references use immutable IDs and explicit dependency rows. Input edits
recompute only the reachable formula subgraph in topological order inside the
same transaction; arbitrary JavaScript is never evaluated.

An HTTP provider waterfall is stored as an ordered, versioned column
configuration. Queueing freezes concrete request URLs, credential IDs, result
paths, and provider order in the run record, while Hatchet receives only run
identifiers and an input fingerprint. Completed no-match providers are
checkpointed in `cell_runs.output`; a retry resumes at the next unconsumed
provider. Rate limits checkpoint the current provider. Every provider attempt
uses an idempotency key derived from the run and stable provider IDs.

## Airbyte boundary

Airbyte is not part of the core runtime. Its source/destination synchronization
model is useful for scheduled bulk imports but does not model low-latency,
per-cell actions and waterfalls well. The current Airbyte repository is
licensed under [ELv2](https://github.com/airbytehq/airbyte/blob/master/LICENSE),
which Airbyte itself describes as source-available rather than OSI open source
and which restricts offering the software as a competing managed service.

A future adapter may connect to a user-owned Airbyte deployment over its API.
No Airbyte code or images are distributed in the default installation, and a
hosted edition must receive project-specific legal review before advertising
or bundling that adapter.

## ClickHouse boundary

[ClickHouse is Apache-2.0 licensed](https://github.com/ClickHouse/ClickHouse),
so its license is compatible with an optional open-source deployment. It is not
a source of truth. The optional standalone projector receives strict terminal
execution and ingestion metrics through projection-specific outbox leases. The
editable grid, permissions, credentials, and current workflow state remain in
PostgreSQL.

## Consequences

- Local development needs PostgreSQL and Hatchet in addition to Node.js.
- Web requests stay short and can be horizontally scaled separately from work.
- Connector handlers remain ordinary functions behind a workflow adapter.
- Analytics may be eventually consistent without weakening product state.
- Hatchet must be pinned and authenticated before any production deployment.
- Connector HTTP uses DNS-pinned egress and rejects non-public address ranges;
  production networks must enforce the same boundary independently.
