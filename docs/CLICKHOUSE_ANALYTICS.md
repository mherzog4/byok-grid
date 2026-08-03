# Optional ClickHouse analytics

ClickHouse is not required to run BYOK Grid. Enable it when terminal execution
and ingestion history is large enough that analytical scans should be isolated
from SQLite's interactive workload.

## Local evaluation

Set a unique `CLICKHOUSE_PASSWORD` in `.env`, then start the profile:

```bash
docker compose --profile analytics up --build -d
```

This starts SQLite migrations, ClickHouse, and the non-root analytics
projector. ClickHouse's HTTP port is exposed locally at `58123`; do not expose
that evaluation credential or port on an untrusted network.

The profile uses the current pinned ClickHouse LTS line and a persistent
`clickhouse_data` volume. The application and main worker continue to operate if
the projector or ClickHouse is stopped.

## Projected schema

The projector creates `byok_grid_analytics.events` with opaque workspace,
event, aggregate, table, and dimension identifiers plus these bounded metrics:

- outcome and error code;
- record, created-row, updated-row, archived-row, restored-row, and page counts;
- event and projection timestamps.

It never copies credentials, prompts, provider responses, source records, cell
values, webhook bodies, or arbitrary outbox payloads.

`ReplacingMergeTree` deduplicates retry copies during background merges. Use
`FINAL` when a query must be exact before those merges complete:

```sql
SELECT
  event_type,
  count() AS events,
  sum(record_count) AS records
FROM byok_grid_analytics.events FINAL
WHERE workspace_id = {workspace_id:UUID}
  AND occurred_at >= now() - INTERVAL 30 DAY
GROUP BY event_type
ORDER BY events DESC;
```

Always scope application-facing queries by `workspace_id`. ClickHouse is not
the permission authority; a future dashboard API must authenticate in Next.js
and inject the authorized workspace ID rather than accepting it on trust from a
browser.

## Workspace erasure

An owner-initiated workspace purge creates a content-free SQLite receipt.
The projector rejects any newly claimed events for that workspace, waits at
least one hour for already leased events to drain, and then performs an
idempotent parameterized lightweight delete. A successful delete immediately
hides matching rows from queries; ClickHouse reclaims their physical storage in
later background merges.

The receipt records claim attempts, a sanitized last error, the next retry, and
the successful erasure time. Monitor purged receipts whose
`analytics_erased_at` remains null beyond the grace period. SQLite remains
deleted and available even if ClickHouse is offline. See the
[retention guide](DATA_RETENTION.md) for receipt, backup, and restore policy.

## Production requirements

- Use HTTPS and leave `CLICKHOUSE_ALLOW_INSECURE_HTTP=false`.
- Create a dedicated user limited to the analytics database and table.
- Supply the password and URLs through a secret manager, not image arguments or
  committed environment files.
- Give the projector only the same scoped SQLite/libSQL endpoint used for the
  analytics outbox, and never give ClickHouse application-database credentials.
- Monitor unprojected event age, retry counts, projector errors, ClickHouse disk
  use, merge backlog, and query latency independently.
- Define retention and backups explicitly. The repository applies no automatic
  TTL because community deployments have different audit requirements.
- Treat the Compose profile as an evaluation topology, not a production
  manifest.

The projector is at-least-once. A crash in the acceptance/checkpoint window can
insert a duplicate version, but it cannot lose or mutate authoritative product
state. See [ADR 0024](adr/0024-optional-clickhouse-analytics-projection.md) for
the delivery and ownership model.
