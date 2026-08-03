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

| Key                                | Consumer              | Required                |
| ---------------------------------- | --------------------- | ----------------------- |
| `sqlite-database-url`              | all product workloads | yes                     |
| `sqlite-auth-token`                | all product workloads | when service requires   |
| `better-auth-secret`               | web                   | yes                     |
| `signup-allowed-emails`            | web                   | when allowlist enabled  |
| `smtp-user`                        | web                   | when SMTP requires auth |
| `smtp-password`                    | web                   | when SMTP requires auth |
| `byok-grid-master-key`             | web and worker        | yes                     |
| `byok-grid-additional-master-keys` | web and worker        | during key rotation     |
| `hatchet-client-token`             | worker                | yes                     |
| `connector-runner-shared-secret`   | worker and runner     | when runner enabled     |
| `clickhouse-password`              | projector             | when projector enabled  |

Use External Secrets, Secrets Store CSI, Sealed Secrets, SOPS, or the cluster's
equivalent to materialize that object. The web encrypts credentials and the
worker decrypts them, so both deployments must receive the same master-key
version and optional overlap keyring. Use the digest-pinned maintenance image
in an operator-owned Job for plan/apply and follow
[`MASTER_KEY_ROTATION.md`](MASTER_KEY_ROTATION.md); never place key JSON in the
ConfigMap or Job arguments. Do not pass production secrets through
`--set` or a committed values file: Helm release state can retain supplied
values. If an external controller changes the Secret, use its rollout/reloader
integration or restart the affected Deployment; Helm can checksum only the
optional Secret it renders itself.

`secrets.create=true` exists for disposable validation environments. It
requires all core secret values, and its contents become part of Helm's release
input.

## Install

Create an operator values file containing image locations, the public URL,
account-provisioning mode, Hatchet endpoint, ingress/TLS settings, and the
existing Secret name. The chart supplies the public URL to Better Auth at
runtime; the same attested web image digest can therefore be reused across
origins. `app.signupMode` accepts `disabled` or `allowlist`; the latter requires
the external Secret's `signup-allowed-emails` key to contain at least one
comma-separated address. The chart defaults to a hard seven-day session through
`app.session.expiresInSeconds=604800` and
`app.session.refreshEnabled=false`; `app.session.updateAgeSeconds` controls the
refresh threshold if an operator explicitly enables sliding refresh. The schema
permits expiries from 15 minutes through 30 days, while application readiness
also requires the update age to remain shorter than the expiry.

`app.email.mode` defaults to `disabled`. Set it to `smtp`, then configure
`app.email.smtp.host`, `port`, `fromEmail`, `fromName`, and either implicit TLS
or required STARTTLS. Put `smtp-user` and `smtp-password` in the external Secret
when authentication is required; they must be present as a pair. The chart
rejects public plaintext SMTP. If runtime egress isolation is enabled, add the
SMTP destination IP/CIDR and port to `networkPolicy.egress.web`; the chart does
not infer provider addresses or open email egress automatically.

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

The web startup probe calls `/api/live` and permits up to 60 seconds for the
standalone process to bind. After startup succeeds, readiness calls
`/api/health`, which checks runtime configuration and the complete ordered
SQLite/libSQL migration prefix and removes an unready pod from the Service.
Liveness calls only `/api/live`; a database outage therefore does not cause a
restart storm.

On web termination, Kubernetes first marks the endpoint unready. The default
10-second `preStop` delay lets that state propagate before `SIGTERM` reaches the
standalone Node process. Next.js then closes its listener and completes pending
requests inside the remaining 35 seconds of the default 45-second grace period.
Tune `web.preStopSleepSeconds` and `web.terminationGracePeriodSeconds` from the
observed ingress convergence and request-duration envelope; the chart rejects a
delay that consumes the entire grace period. Do not set
`NEXT_MANUAL_SIG_HANDLE`, because the deployment relies on Next.js's built-in
signal handler. The compiled behavior is reproducible with
`npm run drill:web-drain` after a production build. See
[ADR 0046](adr/0046-web-rollout-draining.md).

The worker enables Hatchet's native
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

Authentication rate limiting ignores forwarded client addresses by default and
uses a shared fail-closed bucket. Set `app.auth.trustedProxyCidrs` only to proxy
IP addresses or narrow CIDRs actually present on the sanitized
`X-Forwarded-For` chain. The chart renders them into
`BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS`, rejects duplicates and `/0`, and the web
runtime performs complete IP/CIDR validation. Keep `networkPolicy.ingress.web`
restricted to that ingress path so clients cannot reach the web pod directly;
also configure the ingress controller to overwrite or predictably append the
forwarding header. The trusted NetworkPolicy peer selectors and the forwarded
proxy CIDRs describe different layers and should be verified together.

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

The runner validates and compiles its registry before binding. Its startup
probe allows 60 seconds for that work. During termination, Kubernetes withdraws
the endpoint during a five-second pre-stop delay, then the runner's explicit
`SIGTERM` handler asks Axum to stop accepting connections and drain active Wasm
requests within the remaining 55 seconds. The delay must remain shorter than
`connectorRunner.terminationGracePeriodSeconds`; tune both from observed
connector duration. See
[ADR 0047](adr/0047-connector-runner-sigterm-draining.md).

For analytics, set `analyticsProjector.enabled=true` and point it at an
independently secured HTTPS ClickHouse endpoint. The projector uses SQLite's
independent analytics lease fields to claim allowlisted outbox events. It does
not become part of web availability or product authorization.

See `docs/COMMUNITY_CONNECTORS.md` and `docs/CLICKHOUSE_ANALYTICS.md` for the
security and data contracts behind those flags.
