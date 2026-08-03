# Measure a production capacity envelope

This drill measures a declared release-candidate envelope through the real
HTTPS application, remote libSQL database, authenticated Hatchet workers, and
digest-pinned Kubernetes workloads. It is a destructive preproduction test,
not a benchmark that can be run against customer data.

The result answers one narrow question: **did this exact candidate stay inside
the operator's declared latency and contention thresholds at this dataset size,
replica count, and concurrency?** It does not manufacture a universal
"production-ready" request rate.

## What the drill measures

The command creates one ephemeral user and workspace, seeds a sparse text table
to the declared row count, and runs these phases:

1. warm the grid read path;
2. read 100-row grid pages through the canonical HTTPS origin;
3. run the same bounded reads through SQLite FTS search;
4. update distinct existing cells through optimistic API writes;
5. enqueue concurrent two-node workflows through the API; and
6. wait for every workflow to copy its bounded source batch into an isolated
   destination table through authenticated Hatchet workers.

Each HTTP phase requires every request to return the expected status and shape.
There is no permitted error percentage. The evidence records count, elapsed
time, throughput, maximum, p50, p95, and p99 latency. Workflow completion is
measured from each enqueue start through durable terminal success.

Before and after the workload, every worker must be authenticated, healthy,
idle, and on the same pod UID without a restart. The drill records deltas from
the worker processes' SQLite acquisition retry and exhaustion counters. Any
exhaustion fails; retries must remain at or below the declared threshold.
Every HTTP request has a 15-second client deadline, and all measured workflow
runs must reach durable success within 120 seconds.

## Safety boundary

Run from a trusted Unix-like operator host with Node.js, npm, and kubectl. Use a
fresh namespace and a newly migrated, authenticated remote libSQL database with
no application rows. The command refuses to begin unless:

- `BYOK_GRID_CAPACITY_DRILL_CONFIRM` exactly names the isolated capacity
  environment;
- the app is a non-loopback credential-free HTTPS origin;
- the database is a non-loopback credential-free `libsql://` host with its
  token supplied separately;
- the active kubectl context matches the explicitly named context;
- the web and worker deployments are stable at the declared replica counts;
- both measured container images use immutable `sha256` digests;
- every selected worker pod is running, ready, authenticated, and idle;
- the database has exactly the current migration ledger; and
- every application table is empty and no recovery-drill probe exists.

Disable authentication email delivery in this disposable release and allowlist
only the dedicated drill email so signup immediately creates a session. Test
the production SMTP path separately. Disable horizontal autoscaling, or pin its
minimum and maximum to the declared replica counts, for the complete observation
window. No other process, scheduled source, operator, or test may use the
database while the capacity drill runs.

On completion or ordinary failure, the drill deletes its workspace, user,
session/account rows, workflow data, and isolated authentication rate-limit
rows. It then re-runs the exact empty-database precondition. If exact cleanup
cannot be proved, it emits `BYOK_GRID_PRODUCTION_CAPACITY_CLEANUP_REQUIRED` with
the run ID. Discard the isolated database rather than improvising cleanup in a
shared environment.

## Declare the envelope

Every profile dimension and threshold is mandatory. Put credentials only in a
protected environment source; do not paste them into command arguments, source
control, shell history, or shared logs.

```text
BYOK_GRID_CAPACITY_DRILL_CONFIRM=isolated-preproduction-capacity-environment
BYOK_GRID_CAPACITY_APP_ORIGIN=https://capacity.example.com
BYOK_GRID_CAPACITY_DATABASE_URL=libsql://capacity-db.example.com
BYOK_GRID_CAPACITY_DATABASE_AUTH_TOKEN=<isolated-database-token>
BYOK_GRID_CAPACITY_EMAIL=capacity-drill@example.com
BYOK_GRID_CAPACITY_KUBECTL_CONTEXT=<exact-capacity-context>
BYOK_GRID_CAPACITY_NAMESPACE=<isolated-namespace>
BYOK_GRID_CAPACITY_WEB_DEPLOYMENT=<helm-release>-web
BYOK_GRID_CAPACITY_WORKER_DEPLOYMENT=<helm-release>-worker
BYOK_GRID_CAPACITY_CANDIDATE_SHA=<40-character-commit-sha>

BYOK_GRID_CAPACITY_PROFILE=reference-small
BYOK_GRID_CAPACITY_WEB_REPLICAS=2
BYOK_GRID_CAPACITY_WORKER_REPLICAS=2
BYOK_GRID_CAPACITY_ROWS=2000
BYOK_GRID_CAPACITY_READ_CONCURRENCY=10
BYOK_GRID_CAPACITY_READ_REQUESTS=100
BYOK_GRID_CAPACITY_WRITE_CONCURRENCY=5
BYOK_GRID_CAPACITY_WRITE_REQUESTS=50
BYOK_GRID_CAPACITY_WORKFLOW_CONCURRENCY=2
BYOK_GRID_CAPACITY_WORKFLOW_RUNS=4

BYOK_GRID_CAPACITY_MAX_READ_P95_MS=500
BYOK_GRID_CAPACITY_MAX_SEARCH_P95_MS=750
BYOK_GRID_CAPACITY_MAX_WRITE_P95_MS=1000
BYOK_GRID_CAPACITY_MAX_WORKFLOW_ENQUEUE_P95_MS=1000
BYOK_GRID_CAPACITY_MAX_WORKFLOW_COMPLETION_P95_MS=30000
BYOK_GRID_CAPACITY_MAX_WORKER_WRITE_RETRIES=5
```

These numbers illustrate the schema only. They are not BYOK Grid performance
promises. Choose values from the intended tenant shape, user concurrency,
workflow arrival rate, infrastructure budget, and service-level objectives.

Profile constraints prevent trivial or unbounded evidence:

- rows: 500–100,000;
- read concurrency: 1–200, with at least five requests per slot;
- write concurrency: 1–100, with at least five distinct writes per slot and no
  more writes than seeded rows;
- workflow concurrency: 1–10 and runs: concurrency–20;
- web and worker replicas: 1–20 each;
- HTTP p95 thresholds: 1–60,000 milliseconds;
- workflow-completion p95: 1–120,000 milliseconds; and
- worker acquisition retries: 0–1,000,000, while exhaustion is always zero.

Run:

```text
npm run drill:production-capacity
```

Success emits exactly one JSON evidence record with marker
`BYOK_GRID_PRODUCTION_CAPACITY_VERIFIED`. It contains the declared profile,
candidate commit, measured phase summaries, web and worker image digests,
worker contention deltas, run ID, UTC verification time, and exact-cleanup
status. It excludes URLs, email, cookies, credentials, payload values, tenant
IDs, provider errors, and kubectl output.

## Turn the result into a release limit

Retain the success record with the release digest manifest, Helm values digest,
cluster and provider versions, libSQL topology, Hatchet version, load-generator
host/network location, provider-side latency and saturation metrics, ingress
metrics, and the operator/time window. The candidate SHA in the record is a
claim until the retained release manifest proves that the measured image
digests came from that commit.

Set the supported limit below the first passing-to-failing boundary, not equal
to a single best run. Repeat each candidate profile enough times to cover cold
and warm behavior, then record:

- maximum supported rows per table and active tenant;
- sustained and burst read/write/workflow concurrency;
- measured p95/p99 and error-free throughput;
- worker retry and provider contention behavior;
- an alert threshold below the observed saturation point; and
- the scale-up, scale-out, admission-control, or rollback action when the alert
  fires.

Worker metrics expose process-local contention only. Web/API retries occur in
separate processes, and a single load-generator network does not represent all
clients. Provider metrics, ingress metrics, a second client location, and the
candidate observation window remain required before stable promotion.
