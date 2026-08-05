# SQLite-native workflow-worker evidence — 2026-08-04

Scope: the candidate working tree after `0.1.0-rc.2`. This record proves the
default single-node execution path from source, production image, and a
disposable SQLite volume. It does not replace deployment-specific backup,
capacity, ingress, or optional-adapter evidence.

## Source and integration boundary

The workflow-worker suite created a freshly migrated SQLite database, authored
and published a real workflow, started the Node worker with every Hatchet
setting blank, and waited for DB-backed `/health` readiness. The local
dispatcher claimed the durable outbox event, executed the shared typed task
handler, persisted the expected destination-cell value, and marked the workflow
run successful. The test then sent operating-system `SIGTERM`, required exit
code 0, and observed:

```text
{"marker":"BYOK_GRID_LOCAL_WORKER_DRAIN_COMPLETE"}
```

All 11 workflow-worker tests passed. The complete monorepo format, lint,
typecheck, test, and production-build gates also passed, including 68 web tests
with one intentional skip, 93 database tests with the documented external
compatibility skips, and the Rust connector-runner signal test.

## Compose topology

The default application profile rendered exactly these services:

```text
sqlite-migrate
web
workflow-worker
```

The separate `hatchet` profile rendered only `hatchet-postgres` and `hatchet`.
This proves a default clone does not provision PostgreSQL or a scheduler service
to execute visual workflows.

## Production-image startup and drain

The production `workflow-worker` and matching `migration` Docker targets were
built from the working tree. The migration image initialized an isolated named
volume, then the production worker image started against that volume with:

- `WORKFLOW_EXECUTION_DRIVER=local`;
- a local `file:` SQLite URL;
- the required BYOK master-key configuration; and
- no Hatchet URL, host, or token.

The packaged readiness probe succeeded against the worker's DB-backed port
`8002` endpoint. Docker then sent `SIGTERM`; the container exited with code 0
and emitted the local drain-complete marker above. The isolated container and
volume were removed afterward. The image entrypoint's side-effect-free smoke
mode also emitted:

```text
{"marker":"BYOK_GRID_IMAGE_SMOKE_READY","target":"workflow-worker"}
```

This closes the production-artifact gap for the default SQLite-native runtime.
Hatchet remains a separately configured adapter and requires its own evidence
only when a deployment enables that profile.
