# Kubernetes deployment

The repository includes a vendor-neutral Helm chart at
`deploy/helm/byok-grid`. It deploys the product workloads, not a bundled data
platform:

- the Next.js web control plane;
- the Node.js workflow worker connected to Hatchet;
- a migration Job that runs before install and upgrade;
- an optional isolated community-connector runner; and
- an optional ClickHouse analytics projector.

A remote libSQL service and authenticated Hatchet are required external
services for the chart's multi-pod topology. Hatchet privately owns its own
database; BYOK Grid receives no credentials for it. ClickHouse is external and
opt-in. Airbyte is installed independently and points its BYOK Grid destination
at the public push-ingestion API.

## Prerequisites

Use a tagged BYOK Grid release that publishes each Dockerfile target as a
multi-platform manifest plus an immutable digest:

```text
web
workflow-worker
migration
maintenance              # backup/restore jobs
connector-runner          # only if enabled
airbyte-destination       # only if used
analytics-projector       # only if enabled
```

Provision a durable remote libSQL database. The web, workflow worker, migration
job, and optional projector receive one `libsql://` URL and, when required by
the service, an auth token. Use service-side network and tenant isolation; the
chart does not support a pod-local `file:` database because replicas would not
share one authoritative file.

Provision authenticated Hatchet separately. Its development `hatchet-lite-dev`
image from Compose is not suitable for this chart.

Download and verify the release's `values.digests.yaml`. It contains the exact
web, worker, migration, connector-runner, and analytics-projector digests that
passed the release scan and attestation gate. A chart image accepts either a
tag or a `sha256:` digest, never both; a digest takes precedence over the chart
version fallback.

## Secret contract

The secure default is `secrets.create=false`. Create a Secret such as
`byok-grid-secrets` with these keys:

| Key                              | Consumer              | Required               |
| -------------------------------- | --------------------- | ---------------------- |
| `sqlite-database-url`            | all product workloads | yes                    |
| `sqlite-auth-token`              | all product workloads | when service requires  |
| `better-auth-secret`             | web                   | yes                    |
| `byok-grid-master-key`           | web and worker        | yes                    |
| `hatchet-client-token`           | worker                | yes                    |
| `connector-runner-shared-secret` | worker and runner     | when runner enabled    |
| `clickhouse-password`            | projector             | when projector enabled |

Use External Secrets, Secrets Store CSI, Sealed Secrets, SOPS, or the cluster's
equivalent to materialize that object. The web encrypts credentials and the
worker decrypts them, so both deployments must receive the same master-key
version. Do not pass production secrets through
`--set` or a committed values file: Helm release state can retain supplied
values. If an external controller changes the Secret, use its rollout/reloader
integration or restart the affected Deployment; Helm can checksum only the
optional Secret it renders itself.

`secrets.create=true` exists for disposable validation environments. It
requires all core secret values, and its contents become part of Helm's release
input.

## Install

Create an operator values file containing image locations, the public URL,
Hatchet endpoint, ingress/TLS settings, and the existing Secret name. The chart
supplies the public URL to Better Auth at runtime; the same attested web image
digest can therefore be reused across origins.

Validate before changing the cluster:

```text
npm run helm:verify
helm lint --strict deploy/helm/byok-grid -f values.production.yaml
helm template byok-grid deploy/helm/byok-grid \
  --namespace byok-grid \
  --values values.production.yaml \
  --values values.digests.yaml
```

Then install atomically:

```text
helm upgrade --install byok-grid deploy/helm/byok-grid \
  --namespace byok-grid \
  --create-namespace \
  --atomic \
  --timeout 15m \
  --values values.production.yaml \
  --values values.digests.yaml
```

Pass the verified digest file last. Before installation, inspect the render and
confirm every enabled workload image uses `repository@sha256:...`; do not
convert those references back to tags for convenience.

The migration Job runs at hook weight `-10`. A failed Job stops the release
before either runtime changes. Its pod does not mount a Kubernetes API token. If
the migration needs an operator-managed ServiceAccount, set
`migration.serviceAccountName` to one that already exists before installation;
a normal chart resource cannot satisfy a pre-install hook. The latest Job is
retained for 24 hours for diagnostics and is removed before the next hook run.
Helm rollback does not reverse a completed database migration, so migrations
must use expand/contract changes that remain compatible with both the old and
new application images.

## Probes and runtime isolation

The web readiness probe calls `/api/health`, which checks runtime configuration
and the complete ordered SQLite/libSQL migration prefix and removes an unready
pod from the Service. Its liveness probe
calls `/api/live`, which checks only the Next.js process; a database outage
therefore does not cause a restart storm. The worker enables Hatchet's native
health server, and its readiness probe parses the response status rather than
accepting every HTTP 200. On termination, it stops local dispatchers, asks
Hatchet to pause new assignments and drain tracked tasks, then closes SQLite.
Configure both `worker.hatchet.hostPort` (gRPC) and
`worker.hatchet.apiUrl` (HTTPS REST). The chart passes each endpoint explicitly
so shutdown control does not inherit a machine-local URL from the client token.
The default 90-second grace period exceeds the longest built-in provider timeout
and is configurable up to ten minutes. Monitor Hatchet queue age separately.

The Hatchet health port exposes `/metrics` with worker health, slot, and action
gauges plus Node.js process, memory, garbage-collection, and event-loop metrics.
The separate named `app-metrics` port defaults to `8002` and exposes
low-cardinality workflow, active-step, and dispatch backlog gauges from one
bounded database read. Discover both named ports with the monitoring stack's
PodMonitor. Keep them cluster-internal and restrict ingress to the monitoring
namespace. The [`observability guide`](OBSERVABILITY.md) defines the complete
metric contract and explains why database-wide gauges use `max` across worker
replicas rather than `sum`.

All chart-owned pods run as non-root, drop capabilities, disable privilege
escalation and service-account token mounts, use the runtime-default seccomp
profile, and receive only their component-specific secret keys. Chart-owned
NetworkPolicies default-deny ingress for the release, then admit only explicitly
selected ingress-controller and monitoring peers plus worker-to-runner RPC. An
enabled Ingress without a trusted web peer fails chart rendering. The optional
runner always has no egress.

Runtime egress isolation is available but requires explicit shared and
component rules. Provider egress is intentionally not guessed: BYOK Grid can
call operator-selected APIs, and portable Kubernetes NetworkPolicy cannot
express DNS/FQDN rules. Apply reviewed standard rules plus CNI-specific policy
for DNS, libSQL, Hatchet, approved provider hosts, and ClickHouse. A separate
namespace-level or hook-compatible control must cover the pre-install migration
Job. Keep the application's DNS-pinned guarded HTTP dispatcher enabled as a
second layer. The [network security guide](NETWORK_SECURITY.md) defines the
values contract, selector semantics, migration boundary, and required negative
tests.

## Optional components

For community connectors, set `connectorRunner.enabled=true`, supply a
read-only PVC containing the reviewed registry, detached signature, and pinned
Wasm artifacts, and configure the same public trust map for the web, worker,
and runner. The schema rejects `allowUnsignedRegistry=true`.

For analytics, set `analyticsProjector.enabled=true` and point it at an
independently secured HTTPS ClickHouse endpoint. The projector uses SQLite's
independent analytics lease fields to claim allowlisted outbox events. It does not become part
of web availability or product authorization.

See `docs/COMMUNITY_CONNECTORS.md` and `docs/CLICKHOUSE_ANALYTICS.md` for the
security and data contracts behind those flags.
