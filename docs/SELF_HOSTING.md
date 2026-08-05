# Self-hosting BYOK Grid

The repository ships production-shaped images for the Next.js control plane and
Node.js workflow worker. The root Compose file is a **single-node evaluation
environment**, not a managed production topology. SQLite is the application
source of truth and the default execution driver; Hatchet and PostgreSQL are
not part of the default profile.

## Local container evaluation

Prerequisites are Docker Compose and a copied `.env.example` at `.env`.

1. Generate a unique local `BYOK_GRID_MASTER_KEY` as described in
   `.env.example`.
2. Run `npm run self-host:up`.
3. Wait for `sqlite-migrate` to complete, then open
   <http://localhost:3000>. The web container's `/api/health` endpoint reports
   database readiness and also drives the image health check.

The `app` Compose profile builds a non-root standalone Next.js image and a
SQLite-only visual-workflow worker. A one-shot SQLite migration job, web
container, and workflow worker share only the `sqlite_data` volume. Image
entrypoints validate required runtime variables and exit before startup when a
value is missing; profile-independent interpolation does not block
infrastructure-only bootstrapping.

Use `npm run self-host:down` to stop the profile. The named SQLite volume is
retained. Removing volumes is a separate destructive operation and is
intentionally not part of that script.

### Optional Hatchet adapter

The local driver is the supported default. To evaluate the Hatchet adapter,
set `WORKFLOW_EXECUTION_DRIVER=hatchet`, run `npm run infra:up`, copy the
development token from Hatchet into `.env`, and then run
`npm run self-host:up`. The `hatchet` Compose profile contains Hatchet and its
private PostgreSQL database; BYOK Grid never reads or writes that database.
The bundled Hatchet image has authentication disabled and is for local adapter
testing only.

### Local graceful-drain drill

After the web and worker are healthy, run:

```text
npm run drill:workflow-drain
```

The command builds a disposable E2E image, creates a synthetic 500-row,
100-node workflow in the shared local SQLite database, waits for a persisted
running step, sends `SIGTERM` to the worker with its 90-second grace period,
and requires the complete workflow to succeed. It verifies a clean container
exit and the selected driver's drain marker, cleans the synthetic workspace,
restarts the worker, and waits for health. Do not run this disruptive drill
against a production deployment; repeat its signal and recovery procedure
through that environment's approved rollout tooling instead.

For the authenticated Kubernetes release gate, use the isolated remote
procedure in
[`KUBERNETES_WORKER_DRAIN_DRILL.md`](KUBERNETES_WORKER_DRAIN_DRILL.md). It
proves real Hatchet registration, PID 1 draining, clean restart state, and
durable completion; the local Compose result does not substitute for that
environment evidence.

## Images

Build either runtime directly from the repository root:

```text
docker build --target web -t byok-grid-web .
docker build --target workflow-worker -t byok-grid-workflow-worker .
docker build --target migration -t byok-grid-migration .
docker build --target maintenance -t byok-grid-maintenance .
docker build --target connector-runner -t byok-grid-connector-runner .
```

The Dockerfile uses a digest-pinned Node 24.19 image, the repository-declared
npm 12.0.2 installer, and `npm ci` against the committed lockfile. The web
runtime consumes Next.js standalone output instead of a complete monorepo
dependency tree. The worker deliberately retains the TypeScript workspace
sources and production `tsx` loader because those package exports currently
point to source. Runtime images invoke `node --import tsx` so the application,
not a launcher, is container PID 1 and receives termination signals directly.
The separately publishable connector SDK is compiled in an
explicit clean stage and shared by both builds; host-generated `dist` files are
excluded from the build context. Moving to a bundled worker is a future image-
size optimization that must preserve connector loading and source maps. The
workflow-worker target runs portable visual graphs and every background
integration from the shared SQLite store. The web and workflow-worker runtimes
receive the same deployment master key: the web control plane encrypts
credentials when they are saved, and credential-bearing nodes decrypt them only
at execution time. During a planned rotation they must also receive the same
bounded `BYOK_GRID_ADDITIONAL_MASTER_KEYS` Secret. Follow the complete overlap,
plan, apply, verification, and backup-key retirement sequence in the
[master-key rotation guide](MASTER_KEY_ROTATION.md); replacing the current key
without that overlap can make existing workspace credentials unreadable.
When the optional adapter is enabled, Hatchet receives delivery and run
identifiers, never those secrets. When community connectors are enabled, the
workflow worker also needs the signed registry mount plus the connector-runner
URL and shared RPC secret. The runner remains isolated from SQLite and
workspace encryption keys.
The same workflow-worker process schedules and executes SQLite-owned HTTP and
HubSpot sources. `SOURCE_SCHEDULER_POLL_SECONDS` controls the due-source scan
interval; source credentials and encrypted page cursors never enter Hatchet
when that adapter is enabled.

The web UI uses same-origin requests, so the image contains no operator URL.
Set the optional canonical runtime origin through `BYOK_GRID_PUBLIC_URL` when a
reverse proxy changes the origin visible to Next.js. It must contain only
scheme, host, and optional port. Compose defaults it to
`http://localhost:3000`; direct local development can leave it empty. Database
URLs, provider keys, encryption keys, optional Hatchet tokens, and operator
origins must never be passed as image build arguments.

## Access boundary

BYOK Grid is a single-user, fork-first application. It does not ship signup,
sign-in, sessions, invitations, or password recovery. Keep local development on
loopback. Before exposing an installation beyond a trusted device or private
network, place it behind an operator-controlled boundary such as a VPN,
identity-aware proxy, or equivalent ingress policy. The application does not
interpret upstream identity headers and must not be treated as a multi-tenant
SaaS authentication boundary.

## Production boundary

A production operator must supply infrastructure outside the local Compose
defaults:

- persistent local storage for the SQLite database and WAL on one active
  application/worker host, or a remote libSQL service for a supported
  multi-host topology;
- the default SQLite-native execution driver on the same active host as the
  local database, or an authenticated release-pinned Hatchet endpoint when the
  optional adapter is intentionally enabled;
- unique `BYOK_GRID_MASTER_KEY` and `BYOK_GRID_MASTER_KEY_ID` values from a
  secret manager, plus an optional
  secret-managed `BYOK_GRID_ADDITIONAL_MASTER_KEYS` overlap set used only
  during documented rotation;
- HTTPS termination with the canonical public URL configured consistently;
- an operator-controlled access boundary before any non-loopback exposure;
- preservation of the application's request-scoped nonce CSP, HSTS,
  no-referrer, anti-framing, MIME-sniffing, browser-capability, and cache-control
  response headers plus the browser's `Origin`, `Referer`, and `Sec-Fetch-*`
  request headers; the proxy must not rewrite or merge CSP values or cache
  nonce-bearing HTML for reuse across requests;
- preservation of the application-generated response `X-Request-ID` in ingress
  access logs and client responses, without copying caller-supplied correlation
  values into the private `X-BYOK-Grid-Request-ID` header or logging request
  bodies, raw queries, cookies, authorization headers, or credentials;
- private-network egress denial, DNS controls, and provider allowlisting around
  the worker as defense in depth;
- route-aware request-size, slow-body, connection, concurrency, and request-rate
  enforcement at the TLS proxy, aligned with the application's independent
  streaming limits;
- centralized logs that redact cookies, invitation URLs, provider payloads,
  credentials, and workflow inputs; and
- SQLite online-backup (or `VACUUM INTO`), encryption-key, and restore
  procedures tested before accepting
  customer data.

The [API transport security guide](API_SECURITY.md) defines the five-MiB JSON
and ingestion boundaries, 50-MiB CSV boundary,
compressed-body policy, and edge tests. Do not rely exclusively on proxy limits:
the application bounds observed bytes so chunked requests and alternate internal
paths cannot bypass the memory boundary.

After the canonical HTTPS ingress is live, run the repository's read-only
[`public deployment verifier`](VERIFY_DEPLOYMENT.md). It confirms health,
request correlation, security headers, and per-response CSP nonce behavior
through the real proxy without creating product data.

Use the repository's verified online-backup and new-file restore workflow in
[the backup and restore guide](BACKUP_RESTORE.md). A copied SQLite file or an
untested provider snapshot is not sufficient recovery evidence.

For multi-host remote mode, run the isolated preproduction
[`remote libSQL process-loss and restore drill`](REMOTE_LIBSQL_DRILL.md) against
the chosen provider before cutover. The drill refuses local URLs, missing
authentication, existing application rows, and a restore URL that aliases the
source.

Run SQLite migrations as a one-shot release job with `SQLITE_DATABASE_URL` and,
for remote libSQL, `SQLITE_AUTH_TOKEN`. The web container needs those values,
`BYOK_GRID_MASTER_KEY`, `BYOK_GRID_MASTER_KEY_ID`, optional
`BYOK_GRID_ADDITIONAL_MASTER_KEYS`, and an optional `BYOK_GRID_PUBLIC_URL`
behind a reverse proxy.
The workflow worker needs the same SQLite and BYOK encryption-key settings.
Hatchet client settings are required only when
`WORKFLOW_EXECUTION_DRIVER=hatchet`. No BYOK Grid runtime needs PostgreSQL
credentials.

Set `AUTOMATIC_RUN_MAX_PER_ROW_CHANGE` and
`AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE` conservatively for the deployment.
The worker blocks an entire over-limit fan-out instead of letting column or
destination ordering decide which external effects occur.

## Optional community connector runner

Do not enable the runner until an administrator has verified the publisher-key
fingerprint through an independent channel, reviewed the registry, and verified
every artifact digest. The reference profile includes its public key and
detached signature. It can be evaluated by setting the four connector variables
documented in `.env.example`, generating a unique
`CONNECTOR_RUNNER_SHARED_SECRET`, and running:

```text
docker compose --profile app --profile sandbox-connectors up --build
```

The runner is attached only to an internal Compose network, has no database or
master-key environment, drops Linux capabilities, and uses a read-only root
filesystem. A production deployment should preserve those controls, mount its
registry and artifacts read-only, rotate the RPC secret through a secret
manager, and apply a network policy that permits RPC only from the worker. The
web, worker, and runner must use the same reviewed registry and compatible
Ed25519 trust maps. Keep publisher private JWKs outside the deployment and
repository, use a dual-signed registry during key rotation, and restart all
three processes after changing the registry or trust set. Unsigned registry
flags are development-only and must remain false in production. Workspace roles
do not grant artifact-installation rights. See
[`docs/COMMUNITY_CONNECTORS.md`](COMMUNITY_CONNECTORS.md) for signing commands
and rotation order.

The application exposes workspace-scoped online revocation for verified
publisher keys, connector IDs, versions, and artifact digests. It supplements
deployment controls; it does not change which registry signatures are trusted.
For a globally compromised publisher, remove the key from
`BYOK_GRID_CONNECTOR_TRUST_KEYS`, review or remove the registry, and restart the
web, worker, and runner. During planned dual-signature rotation, workspace
publisher revocation blocks execution only after every verified co-signer is
revoked; an artifact block is the immediate exact-code kill switch.

When using the optional adapter, set both `HATCHET_CLIENT_HOST_PORT` for gRPC
task dispatch and `HATCHET_CLIENT_API_URL` for REST lifecycle operations. Do not
rely on the API URL embedded in a token: it may name `localhost` from the
machine where the token was minted, which prevents a containerized worker from
pausing itself during a graceful drain.

The web image health check proves runtime configuration is valid and the Next.js
server can open a fully migrated SQLite database. The worker probe reads the
local database-backed health response or Hatchet's native health status,
depending on the selected driver, and both modes perform a graceful drain on
termination. Neither check proves provider reachability or that queue age is
within its SLO. Production monitoring must cover queued-work age, workflow
failure rate, database saturation, and provider error/limit rates separately.
The optional Hatchet health port exposes its SDK lifecycle status. The
application endpoint on port `8002` exposes low-cardinality
workflow, step, and dispatch backlog gauges backed by one bounded SQLite read.
Neither endpoint implements application authorization; both must remain on a
trusted monitoring network rather than public ingress. See the
[`observability guide`](OBSERVABILITY.md) for the metric contract, replica-safe
aggregation, discovery, and alert starting points.

## Production Kubernetes

The vendor-neutral Helm chart in `deploy/helm/byok-grid` preserves the separate
web, worker, and migration identities and supports the optional runner and
analytics projector without bundling their external data services. See the
[`Kubernetes deployment guide`](KUBERNETES.md) for the Secret contract,
migration-hook ordering, secure pod defaults, validation commands, and rollout
procedure. The [network security guide](NETWORK_SECURITY.md) covers the
chart-owned default-deny ingress baseline, explicit runtime egress mode, and
the cluster tests required before cutover.

Airbyte and ClickHouse are not default image dependencies. Deploy them only
when an operator chooses the optional bulk-ingestion adapter or analytics
projection; neither is permitted to become the product database or credential
authority.

To evaluate the ClickHouse projection, set a unique `CLICKHOUSE_PASSWORD` and
run `docker compose --profile analytics up --build -d`. This profile is still a
local evaluation topology: production requires HTTPS, secret-managed
credentials, network isolation, retention, backups, and an independently
maintained ClickHouse deployment. See
[`docs/CLICKHOUSE_ANALYTICS.md`](CLICKHOUSE_ANALYTICS.md).

## Workspace deletion and retained copies

Owners can permanently purge a workspace after reviewing its affected record
counts and clearing active work. Deployment operators alone manage retention
holds. Optional ClickHouse rows are erased asynchronously after a minimum
one-hour drain period, while backup expiry and external BYOK provider copies
remain operator responsibilities. Before production use, publish those periods
and rehearse post-restore purge reconciliation. See the
[workspace deletion and retention guide](DATA_RETENTION.md).
