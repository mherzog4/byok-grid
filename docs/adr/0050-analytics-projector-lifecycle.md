# ADR 0050: Analytics-projector lifecycle and health

- Status: accepted
- Date: 2026-08-03

## Context

The optional analytics projector opened SQLite, initialized ClickHouse schema,
and entered its projection loop without exposing health state. Kubernetes
therefore considered the pod available immediately, including while ClickHouse
initialization was blocked or failing. `SIGTERM` stopped future cycles but did
not reach active 30-second ClickHouse requests, and the chart relied on
Kubernetes' implicit termination default.

Projector availability must remain independent from web availability because
SQLite/libSQL is authoritative. At the same time, enabling the optional
Deployment should produce truthful rollout state and bounded shutdown behavior.

## Decision

The projector owns a bounded HTTP health server:

- `GET /live` returns 200 when the local server and event loop can respond;
- `GET /ready` returns 503 until SQLite opens and ClickHouse schema
  initialization succeeds, then returns 200;
- all responses are small JSON objects with `Cache-Control: no-store` and no
  dependency, tenant, payload, credential, or error details.

The health server binds before ClickHouse initialization. Initialization
failures emit only error class and phase, remain live but unready, and retry at
the configured projection poll interval instead of crash-looping. Readiness is
withdrawn synchronously on `SIGINT` or `SIGTERM`.

The shutdown signal is combined with the existing 30-second ClickHouse request
timeout for schema, insert, and workspace-erasure calls. Projection code stops
between records and does not mark an aborted operation successful or schedule
an artificial retry. Existing SQLite analytics leases remain the recovery
contract for ambiguous in-flight work. Health closes before the database.

The Helm Deployment has a 60-second termination grace period, a process-only
startup and liveness probe on `/live`, and initialization-aware readiness on
`/ready`. The values schema requires at least one replica, a non-privileged
health port, resources, and a bounded termination grace period. Compose uses the
same `/ready` contract.

## Consequences

- Kubernetes no longer marks an enabled projector available before dependency
  initialization completes.
- A ClickHouse startup outage holds the rollout unready without creating a
  restart storm.
- Signal-driven shutdown cancels active ClickHouse transport and leaves
  ambiguous claims recoverable through their lease expiry.
- Readiness records successful initialization; it is not a continuous
  ClickHouse or libSQL service-level signal. Operators must still alert on
  unprojected-event age, lease age, sanitized failures, and pod readiness.
- Projector health does not participate in web or workflow-worker availability.

## Verification

HTTP tests cover live/unready/ready transitions, cache control, method/path
rejection, and listener closure. Lifecycle tests cover initialization retry,
readiness withdrawal, abort propagation, cleanup ordering, listener failure,
and a real child-process `SIGTERM` with exit code 0. ClickHouse tests prove the
external abort reaches the active fetch signal. Configuration tests and the
Helm verifier cover health-port and replica bounds plus default/full renders.

The production analytics-projector image ran as user `node`; its packaged
server returned live 200, initializing 503, and ready 200 and emitted
`BYOK_GRID_ANALYTICS_HEALTH_IMAGE_PASSED`.
