# Local runtime evidence — 2026-08-03

Scope: the release-candidate working tree for `0.1.0-rc.1`, exercised on the
local Docker Compose evaluation topology. This record is reproducible
repository evidence; it is not a substitute for an authenticated production
Hatchet, remote libSQL, or reference Kubernetes deployment.

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

The first process proved that public open signup exits before readiness. The
second used a public HTTPS canonical origin with signup disabled. It returned
`400` for account creation and omitted the Create account control from
server-rendered HTML. The third used the same public-origin posture with a
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
