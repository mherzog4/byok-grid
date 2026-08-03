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
a persisted running step. It then sent Compose `SIGTERM` with a 90-second
timeout. Evidence emitted by the command:

```text
{"marker":"BYOK_GRID_DRAIN_DRILL_IN_FLIGHT","rowCount":500,...}
{"drainMs":1488,"marker":"BYOK_GRID_DRAIN_SIGNAL_COMPLETE"}
{"marker":"BYOK_GRID_DRAIN_DRILL_PASSED","rows":500,"steps":100}
```

The E2E assertion proved the run and all 100 steps succeeded. The drill also
proved worker exit code 0, no OOM kill, Hatchet pending-task drain confirmation,
no REST pause failure, and successful worker health after automatic restart.
The runtime command uses `node --import tsx`, making the application Node
process container PID 1; a pre-fix drill with the `tsx` launcher correctly
failed with exit 143 and an abandoned lease, which is why PID topology is part
of this gate.

The local Hatchet image has authentication disabled. This result therefore
does not close the authenticated production-Hatchet gate in the production
readiness ledger.

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
