# ADR 0049: Workflow-worker Kubernetes probes

- Status: accepted
- Date: 2026-08-03

## Context

The workflow worker exposed Hatchet's local health server but the Helm chart
used only a readiness probe after a fixed five-second delay. Kubernetes had no
bounded startup contract and no liveness signal for a dead or wedged local
health server.

Hatchet reports `INITIALIZED`, `STARTING`, `HEALTHY`, or `UNHEALTHY` in the
health response body. SDK versions differ in whether an unhealthy response uses
HTTP 200 or 503. Reusing strict readiness for liveness would also restart every
worker during a Hatchet connectivity incident, adding churn while leases and
in-flight actions are already recovering.

## Decision

The production image ships a repository-owned worker probe helper with two
modes:

- `ready` requires a successful response whose body status is exactly
  `HEALTHY`;
- `live` accepts any recognized Hatchet lifecycle status, regardless of HTTP
  200/503, but rejects an unreachable server, malformed JSON, missing status,
  or unknown status.

The Helm worker receives a startup probe that runs `ready` every three seconds
with a two-second timeout and 40 failures, giving authenticated registration a
120-second bound. After startup succeeds, readiness runs every ten seconds and
liveness runs every 20 seconds. Three consecutive liveness failures trigger a
restart. Compose uses the same packaged `ready` helper.

## Consequences

- A worker is not rollout-ready until Hatchet reports authenticated listener
  health.
- A reachable local health server reporting `UNHEALTHY` withdraws readiness but
  does not trigger a Kubernetes restart loop.
- A missing, wedged, or malformed local server eventually causes restart.
- The probe helper intentionally ignores action payloads, tenant data, labels,
  and error messages and emits no response body.
- The 120-second startup window and roughly 60-second liveness detection window
  must be validated against the chosen Hatchet service and cluster before
  stable promotion.

## Verification

Node tests cover every recognized status, HTTP success/failure differences,
unknown and malformed responses, network failure, and unsupported modes. The
Helm verifier requires two `ready` invocations, one `live` invocation, the
startup bound, and the expected startup-probe counts in default and optional
renders. Compose configuration parsing verifies the shared helper command.

The production workflow-worker target was built and executed as its
unprivileged `node` user. Importing the packaged helper accepted a healthy
readiness response and an unhealthy liveness response and emitted
`BYOK_GRID_WORKER_PROBE_IMAGE_PASSED`.
