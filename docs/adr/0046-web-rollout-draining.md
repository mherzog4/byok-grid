# ADR 0046: Web rollout draining

- Status: accepted
- Date: 2026-08-03

## Context

The release chart runs at least two standalone Next.js web replicas. Kubernetes
marks a terminating endpoint unready, but ingress and endpoint consumers need a
short propagation interval before the process stops listening. Cold starts also
need protection from liveness restarts without turning a database outage into a
restart loop.

Next.js installs its own `SIGINT` and `SIGTERM` handlers unless
`NEXT_MANUAL_SIG_HANDLE` is set. The built-in handler closes the HTTP listener,
waits for pending requests and framework cleanup, and exits with the
signal-derived status. BYOK Grid has no application cleanup that requires
replacing that handler.

## Decision

The Helm web Deployment uses this ordered contract:

1. Kubernetes marks the terminating endpoint unready.
2. A `preStop` hook waits 10 seconds for Service and ingress routing to converge.
3. Kubernetes sends `SIGTERM` to the standalone Node process, which is PID 1.
4. Next.js stops accepting connections and completes in-flight requests.
5. The pod has a 45-second total termination grace period, leaving 35 seconds
   after the default pre-stop delay.

Both values are operator-configurable. The schema bounds the grace period to
15–300 seconds and the pre-stop delay to 0–60 seconds. Template rendering fails
when the delay is greater than or equal to the grace period. Operators must
increase the grace period if their measured request envelope needs more time;
they must not set `NEXT_MANUAL_SIG_HANDLE` without supplying and proving an
equivalent handler.

The startup probe calls `/api/live` every two seconds and allows 60 seconds for
the process to start. Readiness continues to call `/api/health`, including
runtime configuration and database migration state. Liveness calls only
`/api/live`. A transient database outage therefore withdraws traffic without
restarting a healthy Next.js process.

## Consequences

- Rolling updates have an explicit endpoint-withdrawal and in-flight-drain
  budget rather than relying on Kubernetes and Next.js defaults.
- A slow or unavailable database affects readiness but not startup or liveness.
- The chart cannot prove that a particular ingress controller has consumed the
  terminating endpoint within 10 seconds. The reference deployment must verify
  that behavior and tune the delay from observed traffic.
- Requests exceeding the remaining shutdown budget can still be terminated by
  Kubernetes and must rely on their existing idempotency contracts.

## Verification

`npm run helm:verify` proves the default render, startup-probe split, bounded
values, and invalid delay/grace combinations. After `npm run build`,
`npm run drill:web-drain` starts the compiled standalone server, holds a real
password-recovery request inside its anti-enumeration timing floor, sends
`SIGTERM`, proves new connections are rejected before the original response
finishes, and requires Next.js's graceful exit code 143. Ordinary CI and the
tag workflow run this drill immediately after the production build.
