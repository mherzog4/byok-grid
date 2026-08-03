# ADR 0047: Connector-runner SIGTERM draining

- Status: accepted
- Date: 2026-08-03

## Context

The optional community-connector runner executes capability-constrained Wasm
outside the web and workflow-worker trust boundary. Axum was configured with a
graceful-shutdown future, but that future waited only for Tokio's Ctrl+C helper.
Kubernetes terminates containers with `SIGTERM`, so the runner could bypass
Axum draining and terminate an in-flight invocation immediately.

Tokio's Unix signal handlers replace the process defaults for the rest of the
process after registration. A production server must therefore establish every
signal stream before admitting traffic and treat registration failure as a
startup failure.

## Decision

On Unix, the connector runner creates explicit Tokio streams for `SIGINT` and
`SIGTERM` before calling `axum::serve`. It selects the first signal, emits a
low-cardinality signal-name log, and resolves Axum's graceful-shutdown future.
Axum stops accepting connections and waits for active requests. Non-Unix builds
retain the portable Ctrl+C path.

The Helm Deployment uses a 60-second total termination grace period and a
five-second `preStop` delay. Kubernetes first marks the runner endpoint unready;
the delay lets worker-to-runner Service routing converge before `SIGTERM` closes
the listener. The chart rejects a delay greater than or equal to the grace
period. A process-only startup probe allows 60 seconds for registry validation,
signature verification, Wasm compilation, and listener startup.

## Consequences

- Kubernetes termination reaches the graceful Axum path instead of the default
  immediate Unix process action.
- Existing invocations can complete until the pod's remaining 55-second
  default budget expires.
- Fuel and memory still bound guest execution, but they are not a wall-clock
  guarantee. Operators must tune the grace period from their reviewed connector
  set and treat forced termination as a retryable workflow failure.
- The connector runner remains stateless and has no database or credential
  cleanup responsibilities.

## Verification

The Unix integration test launches the real compiled runner against the signed
reference registry, waits for its loopback listener, sends `SIGTERM` to the
child PID, and requires exit code 0 plus the `SIGTERM` shutdown log. It would
observe a signal-terminated failure with the old Ctrl+C-only implementation.
`npm run helm:verify` proves the startup probe, default drain budget, schema
bounds, and invalid delay/grace rejection. The production Docker target is also
run as its unprivileged user with the runner binary as PID 1; a Docker stop must
emit the `SIGTERM` marker and finish with exit code 0 without an OOM kill.
