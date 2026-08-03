# Observability

BYOK Grid exposes two cluster-internal worker telemetry endpoints. Hatchet's
health port defaults to `8001` and serves worker health, slot/action gauges, and
Node.js process metrics. The application metrics port defaults to `8002` and
serves database-backed workflow and dispatch state at `/metrics`.

Neither endpoint implements application authorization. Do not route either
through public ingress. Restrict access to readiness probes and the monitoring
identity with a NetworkPolicy or equivalent infrastructure control.

## Request and error correlation

The web boundary generates a fresh UUIDv4 for every application request and
returns it as `X-Request-ID`, replacing both public and private caller-supplied
correlation headers. Unexpected API failures return that ID in the generic 500
body and emit one JSON record with this fixed shape:

```json
{
  "area": "workflow",
  "errorName": "Error",
  "event": "api.unexpected_error",
  "requestId": "00000000-0000-4000-8000-000000000000"
}
```

The example UUID illustrates the schema; runtime IDs are random. Collect the
JSON record as structured fields and retain the response ID in ingress access
logs so an operator can join a support report to one application event. Do not
enrich the event with exception messages, stacks, raw paths or queries, request
bodies, cookies, authorization headers, provider credentials, or user and
workspace identifiers. Request IDs are operational metadata and must never be
used for authorization or idempotency.

## Application metric contract

The application endpoint exports only deployment-wide counts and ages. It does
not emit workspace IDs, user IDs, provider names, URLs, payloads, or error
messages.

| Metric                                                      | Meaning                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------- |
| `byok_grid_workflow_runs{status}`                           | Current runs in each lifecycle state                          |
| `byok_grid_workflow_queue_oldest_age_seconds`               | Age of the oldest queued workflow, or zero                    |
| `byok_grid_workflow_terminal_runs{status,window_seconds}`   | Terminal outcomes updated during the fixed five-minute window |
| `byok_grid_workflow_active_steps{status}`                   | Current ready and running workflow steps                      |
| `byok_grid_workflow_active_step_oldest_age_seconds{status}` | Age of the oldest ready or running step                       |
| `byok_grid_outbox_unpublished_events`                       | Dispatchable events not yet handed to Hatchet                 |
| `byok_grid_outbox_unpublished_oldest_age_seconds`           | Age of the oldest dispatchable unpublished event              |
| `byok_grid_metrics_collection_timestamp_seconds`            | Timestamp of the last successful database collection          |
| `byok_grid_sqlite_write_acquisition_events{outcome}`        | Process-local retry or exhausted write-acquisition events     |

Analytics-only outbox records are deliberately excluded from dispatch backlog
metrics. Their independent leases require separate ClickHouse projection
monitoring.

Every worker replica queries the same authoritative SQLite/libSQL database, so
the workflow and outbox series are replicated deployment gauges. Aggregate
those across worker pods with `max`, not `sum`. The write-acquisition series is
different: it is a monotonic process-local gauge that resets on restart. Keep
the scrape target/instance dimension and watch positive deltas per replica. A
scrape that cannot complete its bounded database read within five seconds
returns `503` without database error details; Prometheus should also alert on
its generated `up == 0` signal.

## Kubernetes discovery

The Helm worker pod declares named `health` and `app-metrics` ports. A
Prometheus Operator `PodMonitor` can scrape both:

```yaml
podMetricsEndpoints:
  - port: health
    path: /metrics
  - port: app-metrics
    path: /metrics
```

The chart intentionally does not install monitoring CRDs or guess namespace
selectors. Add the endpoints to the operator-owned PodMonitor and restrict
network ingress to its namespace. Set `worker.metrics.enabled=false` only when
an external collector provides equivalent application-level signals.

Kubernetes startup and readiness use the packaged worker probe in `ready` mode
and require the Hatchet body status `HEALTHY`. Liveness uses `live` mode and
accepts every recognized lifecycle status; it is testing whether the local
health server and event loop can produce a valid response, not whether the
remote Hatchet control plane is available. Alert on sustained non-healthy
Hatchet status separately from container restarts.

## Alert starting points

Thresholds must come from the measured capacity envelope and service-level
objectives of the supported deployment. The following expressions demonstrate
safe cross-replica aggregation; their numeric thresholds are examples, not
production promises.

Use [`PRODUCTION_CAPACITY_DRILL.md`](PRODUCTION_CAPACITY_DRILL.md) to produce the
candidate's declared-envelope evidence, then place alerts below the observed
saturation boundary. The drill's worker retry delta is process-local evidence;
retain provider and ingress telemetry for the same window before setting the
deployment-wide limit.

```promql
max(byok_grid_workflow_queue_oldest_age_seconds) > 120
```

```promql
max(byok_grid_outbox_unpublished_oldest_age_seconds) > 60
```

```promql
max by (status, window_seconds) (
  byok_grid_workflow_terminal_runs{status=~"succeeded|failed"}
)
```

Use the terminal-outcome vector to calculate the failed share only after
enforcing a minimum completed-run sample size.

```promql
clamp_min(
  delta(byok_grid_sqlite_write_acquisition_events{outcome="exhausted"}[5m]),
  0
) > 0
```

Any exhaustion should be investigated. A sustained positive retry delta means
the deployment is approaching its write-contention envelope even when requests
eventually succeed; use it with database latency and provider-side signals when
setting the measured capacity limit.

Alert separately on database latency, libSQL/provider availability, Hatchet
queue age, provider rate limits, connector failures, backup freshness, and
optional analytics erasure backlog; the application gauges do not claim to
replace those service-specific signals.
