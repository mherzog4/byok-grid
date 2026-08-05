# ADR 0036: Compile portable visual workflows into SQLite-owned runs

- Status: accepted
- Date: 2026-08-02
- Supersedes: none
- Extends: ADR 0035

Implementation update (2026-08-04): the portability boundary is now exercised
in production code. SQLite-native outbox execution is the default driver;
Hatchet remains an optional scheduling adapter that invokes the same task
handlers.

## Context

BYOK Grid needs a node-based workflow editor without making its public workflow
format depend on one canvas library or its durable state depend on one workflow
service. Open-source deployments must be able to inspect, migrate, validate, and
back up definitions and run history with the application database alone.

React Flow is well suited to interactive graph authoring. Hatchet is well suited
to durable scheduling and retries. Neither should become the authority for a
workflow's meaning or current state.

## Decision

The domain package owns a versioned, portable workflow graph. Nodes contain a
stable kind, validated configuration, display name, and editor position. Edges
connect named, typed ports. The graph validator enforces bounded size, unique
identifiers, compatible ports, one producer per input, trigger reachability,
destinations, and acyclicity.

React Flow maps to and from this graph at the UI boundary. React Flow-specific
node types, callbacks, selection state, and rendering data are not persisted.

Publishing a draft atomically stores:

1. the immutable authoring graph;
2. its canonical SHA-256 digest; and
3. a deterministic compiled plan containing only execution semantics.

The compiler strips positions and viewport state, sorts routes deterministically,
and topologically orders steps. Reordering authoring arrays therefore does not
change the executable plan. Historical versions created before a compiler was
available keep a null plan and must be explicitly republished before execution.

SQLite owns `workflow_runs` and `workflow_step_runs`. Each run pins its workflow
version and graph digest. Each step records its state, attempt count, lease,
retry schedule, bounded output, and sanitized failure. A worker must acquire a
conditional, expiring claim before executing a step. Completion, route
activation, downstream readiness or skipping, and overall-run completion occur
in one immediate SQLite transaction.

The default local driver claims the SQLite outbox and invokes the generic task
handlers directly. The optional Hatchet adapter receives identifiers and
schedules those same handlers. It does not receive credentials, mutable graph
definitions, or authoritative node state. Either transport can be selected
without changing stored workflow definitions or run history.

Outbound webhook nodes snapshot one delivery per input row in SQLite. Their
delivery identifiers are derived deterministically from the run, step,
destination, and row identifiers. A replay therefore observes an existing
successful delivery instead of repeating it. The workflow worker decrypts the
signing secret only at execution time, signs the exact frozen body, blocks
private and reserved egress targets, and bounds concurrent requests to five.
Manual deliveries use the same SQLite ledger and executor through the outbox.

Enrichment nodes similarly expand their bounded row input into deterministic
SQLite `cell_runs`. Each run freezes the connector identity, version, artifact
provenance, credential identifier, resolved action input, and input fingerprint
before execution. The `pending` mode skips already-succeeded cells; `all`
explicitly creates a new run, while replaying the same workflow step resolves
the original run identifiers. Built-in and signed community connectors share
the guarded execution path, with community code isolated behind the connector
runner protocol.

## Branch semantics

Routes are activated by their named source handle. Ordinary transform nodes
activate `rows`. A filter may activate `matched`, `rejected`, or both, depending
on its row partitions. An inactive route marks its unreachable descendants as
skipped. The current graph contract permits one incoming edge per input, which
keeps branch propagation deterministic. A future join node must define explicit
fan-in semantics before that restriction can be relaxed.

## Failure and retry semantics

Step execution is at least once. Claims carry a caller-generated identifier and
expire after a bounded lease. Completion, retry, and failure updates are fenced
by that identifier, so a stale worker cannot overwrite a newer attempt.

Retryable failure returns the step to `ready` with a future `next_attempt_at`.
Terminal failure marks the step failed, the run failed, and unfinished siblings
cancelled. Error codes and messages are bounded and control characters are
removed before storage.

## Consequences

- Definitions and run history remain portable SQLite data.
- The editor, compiler, scheduler, and connector executors have narrow and
  independently testable boundaries.
- Published runs remain reproducible after later draft edits.
- Operators can inspect node-by-node progress without querying Hatchet.
- Retried webhook steps cannot resend rows whose durable deliveries already
  succeeded.
- Every enrichment remains inspectable and attributable at cell granularity,
  even when it originated inside a larger workflow.
- Large row sets must be represented by bounded references or cursors rather
  than copied into every step output.
- Join, loop, and human-approval nodes require new explicit domain semantics;
  they cannot be introduced as canvas-only behavior.
