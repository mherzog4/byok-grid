# Local runtime evidence — 2026-08-03

Scope: the release-candidate working tree for `0.1.0-rc.1`, exercised through
the compiled standalone runtime and local Docker Compose evaluation topology.
This record is reproducible repository evidence; it is not a substitute for an
authenticated production Hatchet, remote libSQL, or reference Kubernetes
deployment.

## Analytics-projector rollout health and shutdown

The health-server tests bound a real loopback listener and proved `/live`
returned 200, `/ready` returned 503 before initialization and 200 afterward,
responses disabled caching, unsupported methods and paths returned 404, and the
listener refused connections after close. Lifecycle tests proved failed
ClickHouse initialization remained live but unready and retried, `SIGTERM`
withdrew readiness before aborting projection, health closed before SQLite, and
health-listener failure still cleaned up and propagated.

A real child process received operating-system `SIGTERM` while its projection
was active. It observed readiness withdrawal, projection abort, repeated
fail-closed readiness during finalization, health close, and database close in
that order, then exited with code 0. A separate transport test proved the same
abort reached the active ClickHouse fetch signal.

Helm lint and default/full/digest renders proved the optional projector's
process-only startup/liveness, initialization-aware readiness, non-privileged
health port, positive replica count, and explicit 60-second grace period.
Compose rendered the same `/ready` service-health contract.

The production analytics-projector target was built and inspected as runtime
user `node` with the expected Node/tsx entrypoint. A disposable container
loaded the packaged TypeScript health server and emitted:

```text
{"marker":"BYOK_GRID_ANALYTICS_HEALTH_IMAGE_PASSED","live":200,"initializing":503,"ready":200}
```

The disposable image was removed afterward. This repository and image evidence
does not replace the external secured-ClickHouse E2E, capacity, alerting, or
observation gates.

## Workflow-worker startup, readiness, and liveness

The packaged worker probe tests exercised all four Hatchet lifecycle states,
HTTP success and failure differences, malformed and unknown responses, network
failure, and unsupported modes. Readiness accepted only a successful
`HEALTHY` response. Liveness accepted every recognized state, including an
`UNHEALTHY` response using a non-success HTTP status, while rejecting a missing
or invalid local health server.

Helm lint and the default, full, egress, and digest renders required a
120-second worker startup bound, two packaged `ready` invocations for startup
and readiness, and one packaged `live` invocation. Compose configuration also
resolved the shared readiness helper.

The production workflow-worker image target was built from the working tree.
Image inspection reported runtime user `node`; a disposable container imported
the packaged helper and emitted:

```text
{"marker":"BYOK_GRID_WORKER_PROBE_IMAGE_PASSED","ready":true,"live":true}
```

The disposable tag and image were removed after inspection. This proves the
repository and image contract, not authenticated Hatchet startup duration or
recovery behavior; that external gate remains open.

## Kubernetes remote-database fail-closed contract

The shared configuration, web runtime, and analytics-projector tests exercised
the explicit local/remote database policy. Local mode retained file-backed
SQLite, while remote mode accepted `libsql://` and rejected a file URL without
including that URL in the structured validation issue.

The real migration command was then run with remote mode and a fresh path under
`/tmp`. It exited before database opening with:

```text
Remote database mode requires a libsql:// URL.
```

The candidate file did not exist after the process exited, proving validation
preceded local directory or database creation. Helm lint and the default, full,
egress, and digest renders required `BYOK_GRID_DATABASE_MODE=remote` on web,
workflow worker, migration, and the enabled analytics projector. This closes
the repository/configuration path that could otherwise create per-pod local
state; it does not satisfy the remote provider's multi-replica, backup, restore,
or failover gate.

## Connector-runner SIGTERM drain

The Unix integration test launched the real compiled connector-runner binary
against the signed reference registry, waited for the listener, and sent the
same `SIGTERM` used by Kubernetes:

```text
cargo test --locked --package byok-grid-connector-runner \
  --test signal_shutdown -- --nocapture
```

The child process emitted its explicit `SIGTERM` shutdown log and exited with
code 0 rather than being reported as signal-terminated. The retained marker was:

```text
{"exitCode":0,"marker":"BYOK_GRID_CONNECTOR_RUNNER_SIGTERM_DRILL_PASSED","signal":"SIGTERM"}
```

The Helm verifier separately rendered the optional runner with a 60-second
startup window, five-second endpoint-withdrawal delay, and 60-second total
termination grace period, and rejected delay/grace collisions. This proves the
repository's process and chart contracts.

The production `connector-runner` Docker target was then built and loaded. Its
image configuration named user `65532:65532` and
`/usr/local/bin/connector-runner` as the entrypoint. The image ran read-only
against the signed reference registry, logged listener readiness, and received
Docker `SIGTERM` with the runner binary as container PID 1. The final state was
`ExitCode: 0`, `OOMKilled: false`, and the log contained
`connector runner received shutdown signal signal="SIGTERM"`. The disposable
container and image tag were removed after inspection. An enabled reference
deployment must still exercise termination during one of its reviewed real
connector invocations.

## Standalone web signal drain

After the production build, this command started the compiled standalone
Next.js server against a freshly migrated temporary SQLite database:

```text
npm run drill:web-drain
```

The drill sent a complete password-recovery request and held it inside the
application's real 500-millisecond anti-enumeration response floor. It then sent
`SIGTERM`, required the process to remain alive, and proved the listener refused
new connections before the original request completed with its normal
server-generated request ID. The captured result was:

```text
{"exitCode":143,"listenerCloseMilliseconds":252,"marker":"BYOK_GRID_WEB_DRAIN_DRILL_PASSED","newConnectionsRejectedBeforeCompletion":true,"responseStatus":400}
```

Exit code 143 proves the compiled Next.js handler completed its graceful
SIGTERM path. Helm lint and render checks separately prove a process-only
60-second startup window, database-aware readiness, a 10-second endpoint
withdrawal delay, and a 45-second total grace period. This local drill does not
prove the chosen production ingress consumes terminating endpoints within that
delay; that remains part of the reference deployment rollout gate.

## Full workflow and graceful drain

The current Compose topology was rebuilt from the working tree and the web,
worker, Hatchet, Hatchet PostgreSQL, ClickHouse, and analytics projector
services reached their expected health states. The web readiness response
reported valid configuration, a migrated SQLite database, and `status: ok`.
The worker health endpoint reported `HEALTHY`, ten slots, all nine registered
actions, and Node 24.14.0; `/metrics` exposed Node process metrics.

The following repository command then ran the bounded signal drill:

```text
npm run drill:workflow-drain
```

The command built the disposable production web test stage, created a synthetic
500-row workflow at the 100-node graph limit, and waited until the API exposed
a persisted running step. Before creating ordinary data, the same E2E rejected
cross-site signup and cookie-authenticated table mutations with the exact `403`
contract, sent a signup larger than the 64-KiB authentication boundary, and sent
an authenticated table mutation larger than the five-MiB product JSON boundary;
both oversized requests required their exact `413` transport responses. The
authenticated application response also had to expose a request-scoped CSP
nonce, production `strict-dynamic` without script `unsafe-inline` or
`unsafe-eval`, one-year HSTS, no-referrer, anti-framing, MIME-sniffing, and
browser-capability restrictions without `X-Powered-By`. The test required every
rendered script to carry the exact response nonce and proved a rejected
cross-origin response received a different nonce. It then sent Compose
`SIGTERM` with a 90-second timeout. Evidence emitted by the command:

```text
{"marker":"BYOK_GRID_DRAIN_DRILL_IN_FLIGHT","rowCount":500,...}
{"drainMs":2228,"marker":"BYOK_GRID_DRAIN_SIGNAL_COMPLETE"}
{"marker":"BYOK_GRID_DRAIN_DRILL_PASSED","rows":500,"steps":100}
```

The E2E assertions proved the oversized requests did not enter Better Auth or
domain mutation logic, verified the response-scoped script policy on compiled
standalone HTML, then proved an ordinary signup, mutation, run, and all 100
steps succeeded. The drill also proved worker exit code 0, no OOM kill, Hatchet
pending-task drain confirmation, no REST pause failure, and successful worker
health after automatic restart.

The first run of the expanded drill exposed `SQLITE_BUSY` while the workflow
worker acquired an internal local transaction connection. Its attempt to record
the step failure also encountered the lock, so the run remained nonterminal and
the 90-second E2E deadline correctly failed. The bootstrap had set
`PRAGMA busy_timeout` through the initial client connection, but
`@libsql/client` may open separate connections for transactions. The corrected
bootstrap supplies the same five-second timeout in `createClient`, which applies
it to every internal local connection, while retaining the per-process writer
queue and `BEGIN IMMEDIATE` transaction policy.

A subsequent strengthened run completed the workflow and its new early-`403`
header assertions but exposed the same immediate-lock default in the disposable
E2E client's fixture cleanup. The audit then applied the shared timeout constant
to every direct local client, including online backup verification/creation and
the E2E harness. Client and backup integration tests passed, and the final clean
rerun above completed workflow execution, cleanup, drain, and recovery. Failed
runs were not counted as evidence.
The current drill additionally requires the private application metrics
endpoint before signaling and after recovery, including workflow status, queue
age, and dispatch backlog series.

The shared write helper now also has an independent two-process contention
drill. A child process acquired a real WAL write transaction and held it beyond
the parent's five-second driver timeout. The parent received a machine-coded
pre-callback lock failure, reset the stale local libSQL connection, retried with
bounded jitter, committed its own transaction, and then counted both rows. Unit
coverage separately proved a lock error after callback entry is never retried,
unknown failures are preserved, and acquisition stops after three attempts.
The private worker metrics endpoint exposes process-local retry and exhaustion
counters; this evidence does not replace the remaining multi-replica remote
libSQL provider drill or define a production concurrency limit.
The pruned production workflow-worker image was rebuilt and run as its
unprivileged `node` user. Importing the packaged database module inside that
image returned
`{"acquisitionExhaustions":0,"acquisitionRetries":0}`, proving the counter
contract is present in the shipped dependency graph rather than only the
monorepo test environment.

The runtime command uses `node --import tsx`, making the application Node
process container PID 1; a pre-fix drill with the `tsx` launcher correctly
failed with exit 143 and an abandoned lease, which is why PID topology is part
of this gate.

The local Hatchet image has authentication disabled. This result therefore
does not close the authenticated production-Hatchet gate in the production
readiness ledger.

## Public account provisioning

After a production build, the following repository command launched four
independent standalone Next.js processes against fresh migrated SQLite files:

```text
npm run drill:signup-policy
```

The first process proved that public open signup and a trust-all `/0`
authentication proxy range both exit before readiness, while the diagnostic
named the setting without echoing its value. The second used a public HTTPS
canonical origin with signup disabled. It returned
`400` for account creation and omitted the Create account control from
server-rendered HTML. Successful page responses, the disabled-signup response,
and a cross-origin proxy rejection each returned a canonical, unique,
server-generated `X-Request-ID`; forged public and private correlation values
were replaced. It also sent four failed sign-ins with four forged
single-value `X-Forwarded-For` addresses; the first three reached authentication
and the fourth returned `429`, proving the production default ignored the
spoofed rotation and retained one shared bucket. The third used the same
public-origin posture with a
secret-backed allowlist. It returned the stable `SIGNUP_NOT_ALLOWED` code for a
different address, accepted a case-varied approved address, and issued a Better
Auth session cookie. It then created a second session, verified that both
expiries were inside the hard seven-day bound, and rendered the other-session
control without placing either raw token in account HTML. Revocation invalidated
the first cookie at the protected `/app` boundary while the current cookie
remained authorized. The valid processes reached readiness before testing and
were terminated before their temporary databases were removed. Evidence
emitted by the command:

```text
{"marker":"BYOK_GRID_PUBLIC_OPEN_SIGNUP_REJECTED"}
{"marker":"BYOK_GRID_UNSAFE_PROXY_TRUST_REJECTED"}
{"marker":"BYOK_GRID_REQUEST_CORRELATION_DRILL_PASSED"}
{"marker":"BYOK_GRID_AUTH_RATE_LIMIT_DRILL_PASSED"}
{"marker":"BYOK_GRID_SIGNUP_DISABLED_VERIFIED"}
{"marker":"BYOK_GRID_SIGNUP_ALLOWLIST_VERIFIED"}
{"marker":"BYOK_GRID_SESSION_POLICY_DRILL_PASSED"}
{"marker":"BYOK_GRID_SMTP_RECOVERY_DRILL_PASSED"}
{"marker":"BYOK_GRID_SIGNUP_POLICY_DRILL_PASSED"}
```

Separate file-backed SQLite integration tests additionally proved that rejected
requests created no users and an approved signup created exactly one user,
personal workspace, and membership. They also proved two active session rows,
bounded expiry, other-session revocation, and current-session preservation.
The compiled drill also started a disposable loopback SMTP receiver and a
fourth public-origin application process with SMTP mode enabled. It observed
the final verification and reset MIME messages, followed their exact HTTPS auth
URLs through the local listener, proved signup created no pre-verification
session, and compared identical known/unknown reset responses. The reset token
worked once, invalidated the verified session and old password, and enabled the
replacement password. The unknown address generated no message. This is local
protocol and application evidence, not proof of production inbox delivery,
sending-domain alignment, or reputation; public open signup remains rejected
outside loopback.

## Deployment master-key rotation

The security and SQLite integration suites generated independent old and new
32-byte master keys, created credentials before and during an overlap window,
and authenticated both credential ciphertexts after rewrapping only the
workspace data-key envelope. The stored credential envelopes remained exactly
unchanged. A second apply rotated zero rows, while unavailable old material,
relational/envelope ID disagreement, malformed keyrings, duplicate material,
and a wrong apply confirmation all failed before mutation. The real child-
process CLI returned only key IDs, counts, and fixed markers; neither key value
appeared in output.

The production maintenance target was then built with its pruned dependency
graph and run as the unprivileged `node` user against a fresh, container-migrated
SQLite database. Its normal entrypoint emitted:

```text
{"currentKeyId":"container-v1","marker":"BYOK_GRID_MASTER_KEY_ROTATION_PLAN_VALID","pending":0,"total":0}
```

The same rebuilt entrypoint successfully ran the existing backup verification
command, proving the maintenance dispatcher preserved that contract. This is
local packaging and SQLite evidence; a supported production deployment must
still rehearse overlap rollout, remote-libSQL rewrap, provider canaries, backup
key retention, replica drain, and old-key removal with its real secret manager.

## SQLite recovery

The live SQLite database was backed up online, independently verified, and
restored into a separate new file while web readiness remained available. Both
the backup and restored file had nine migrations, size 929,792 bytes, and
SHA-256:

```text
9fc145da4a2c11c7a00a23358cc0201884b1ddca30973214b78a1af60691e172
```

The source database was not replaced during the drill. Provider-managed remote
libSQL backup and multi-replica recovery remain external gates.

## Optional ClickHouse projection

The opt-in projector E2E created and leased a terminal analytics event,
projected the exact metrics row to ClickHouse, persisted the SQLite checkpoint,
then exercised purge grace and workspace erasure and verified both systems were
cleaned. This proves the local adapter contract only; the supported production
environment must repeat it against its secured ClickHouse service.
