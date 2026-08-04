# Self-hosting BYOK Grid

The repository ships production-shaped images for the Next.js control plane and
Node.js workflow worker. The root Compose file is a **local evaluation
environment**, not a production topology. SQLite is the application source of
truth. PostgreSQL is present only as Hatchet's private scheduler store; its
credentials are public development values and the Hatchet image has
authentication disabled.

## Local container evaluation

Prerequisites are Docker Compose and a copied `.env.example` at `.env`.

1. Generate unique local values for `BYOK_GRID_MASTER_KEY` and
   `BETTER_AUTH_SECRET` as described in `.env.example`.
2. Run `npm run infra:up` to start local Hatchet and its private PostgreSQL
   dependency.
3. Open <http://localhost:8888>, create or copy the development worker token
   from **Settings → API Tokens**, and set `HATCHET_CLIENT_TOKEN` in `.env`.
4. Run `npm run self-host:up`.
5. Wait for `sqlite-migrate` to complete, then open
   <http://localhost:3000>. The web container's `/api/health` endpoint reports
   database readiness and also drives the image health check.

The `app` Compose profile builds a non-root standalone Next.js image and a
SQLite-only visual-workflow worker. A one-shot SQLite migration job, web
container, and workflow worker share only the `sqlite_data` volume. Hatchet's
private PostgreSQL volume is isolated from all BYOK Grid processes. Image
entrypoints validate required runtime variables and exit before startup when a
value is missing; profile-independent interpolation does not block
infrastructure-only bootstrapping.

Use `npm run self-host:down` to stop the profile. Named SQLite, Hatchet
PostgreSQL, and Hatchet configuration volumes are retained. Removing volumes is
a separate destructive operation and is intentionally not part of that script.

### Local graceful-drain drill

After the web and worker are healthy, run:

```text
npm run drill:workflow-drain
```

The command builds a disposable E2E image, creates a synthetic 500-row,
100-node workflow in the shared local SQLite database, waits for a persisted
running step, sends `SIGTERM` to the worker with its 90-second grace period,
and requires the complete workflow to succeed. It verifies a clean container
exit and Hatchet drain logs, cleans the synthetic workspace, restarts the
worker, and waits for health. Do not run this disruptive drill against a
production deployment; repeat its signal and recovery procedure through that
environment's approved rollout tooling instead.

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

The Dockerfile uses a digest-pinned Node 24.14 image, the repository-declared
npm 11.17 installer, and `npm ci` against the committed lockfile. The web
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
Hatchet receives delivery and run identifiers, never those
secrets. When community connectors are enabled, the workflow worker also needs
the signed registry mount plus the connector-runner URL and shared RPC secret.
The runner remains isolated from SQLite and workspace encryption keys.
The same workflow-worker process schedules and executes SQLite-owned HTTP and
HubSpot sources. `SOURCE_SCHEDULER_POLL_SECONDS` controls the due-source scan
interval; source credentials and encrypted page cursors never enter Hatchet.

The web UI uses same-origin requests, so the image contains no operator URL.
Set the canonical runtime origin through `BETTER_AUTH_URL`; it must contain only
scheme, host, and optional port. The web runtime uses that exact origin for
browser mutation enforcement and does not trust forwarded proxy headers to
derive Better Auth's base URL. Database URLs, auth secrets, provider keys,
encryption keys, Hatchet tokens, and operator origins must never be passed as
image build arguments.

## Authentication rate limits and proxy trust

Authentication rate limiting is database-backed. With
`BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS` empty, the web process ignores every
client-IP header and uses one shared fail-closed bucket per authentication
route. This is safe for evaluation and small controlled installations, but a
multi-user deployment should configure real client identity before traffic is
admitted.

After proving that the reverse proxy overwrites or predictably appends
`X-Forwarded-For` and that the web service cannot be reached directly, set the
exact proxy addresses or narrow CIDRs:

```dotenv
BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS=10.20.0.0/16,192.0.2.10
```

The rightmost trusted hops are skipped and the first untrusted address becomes
the rate-limit identity. Do not copy an entire client-facing network or use a
`/0` range; startup rejects trust-all ranges. Re-test the observed header chain
after changing load balancers, CDN settings, ingress controllers, or network
topology. This setting does not enable forwarded host/protocol trust and does
not replace edge connection and distributed rate limits.

## Account provisioning

Loopback evaluation defaults to `BYOK_GRID_SIGNUP_MODE=open`. A public origin
defaults to `disabled`, and explicitly setting `open` on a non-loopback origin
causes web startup and readiness to fail. This prevents an omitted deployment
setting from exposing registration.

For controlled production provisioning, set
`BYOK_GRID_SIGNUP_MODE=allowlist` and supply a comma-separated
`BYOK_GRID_SIGNUP_ALLOWED_EMAILS` through the secret manager. Comparisons are
case-insensitive. Remove an address after its account is created, then switch to
`disabled` when provisioning is complete. The Helm chart exposes
`app.signupMode` and reads the allowlist from the `signup-allowed-emails` Secret
key by default. The chart schema intentionally permits only `disabled` and
`allowlist` for public Kubernetes releases.

Without SMTP, this mechanism limits account creation but does not verify control
of an inbox. Public open signup remains rejected even after SMTP is enabled;
delivery reputation, abuse controls, and public-registration policy require a
separate promotion decision.

## Authentication email and recovery

Email delivery is disabled by default. Set `BYOK_GRID_EMAIL_MODE=smtp` to
enable verified-email enforcement and password recovery for controlled
accounts. SMTP mode requires `SMTP_HOST` and `SMTP_FROM_EMAIL`; credentials are
optional, but `SMTP_USER` and `SMTP_PASSWORD` must be supplied together.

```text
BYOK_GRID_EMAIL_MODE=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_FROM_EMAIL=security@example.com
SMTP_FROM_NAME=BYOK Grid
SMTP_USER=mailer
SMTP_PASSWORD=from-your-secret-manager
```

Use `SMTP_SECURE=true` with port 465 for implicit TLS, or require STARTTLS with
`SMTP_REQUIRE_TLS=true` on port 587. Cleartext SMTP is rejected unless the host
is loopback, which exists only for disposable local delivery drills. The
transport uses certificate validation, a TLS 1.2 minimum, bounded connection
and socket timeouts, a two-connection pool, and no debug logging.

SMTP mode sends a one-hour verification link after signup and again after a
correct sign-in attempt by an unverified account. Signup does not create a
session until inbox control is proven. Password-reset requests return the same
message for known and unknown addresses, use a one-hour single-use token, and
revoke every session after a successful reset. Recovery and reset pages return
`404` while delivery is disabled; token-bearing reset pages are private,
non-cacheable, non-indexable, and covered by the global no-referrer policy.

Before relying on recovery, verify the SMTP connection and a complete delivery
to a controlled inbox, configure SPF, DKIM, and DMARC for the sending domain,
and monitor rejection, deferral, bounce, complaint, and authentication-failure
signals. BYOK Grid does not ingest bounces or complaints in this release.
With deployment environment variables available, verify connection and SMTP
authentication without sending a message:

```text
npm run email:verify
```

Success emits only `BYOK_GRID_SMTP_CONNECTION_VERIFIED`. This proves SMTP
connection and authentication, not inbox placement; follow it with a real
verification and password-reset delivery to a controlled account. Before a
stable production promotion, analyze the two received messages and live sender
DNS with the bounded procedure in
[`SMTP_PRODUCTION_DRILL.md`](SMTP_PRODUCTION_DRILL.md).

## Session lifecycle

Public origins default to a hard seven-day session. Loopback evaluation uses
sliding refresh for contributor convenience. Configure the policy explicitly
in a managed deployment:

```text
BYOK_GRID_SESSION_EXPIRES_IN_SECONDS=604800
BYOK_GRID_SESSION_REFRESH_ENABLED=false
BYOK_GRID_SESSION_UPDATE_AGE_SECONDS=86400
```

Expiry must be between 900 and 2,592,000 seconds. Update age must be between 60
seconds and the configured expiry. Enabling refresh extends an active session
after the update age; leaving it disabled preserves the original hard expiry.
Invalid values fail runtime validation and readiness. The account UI lets a
user sign out every other active session while preserving the current one, and
database revocation is checked without a cookie cache.

The Helm equivalents are `app.session.expiresInSeconds`,
`app.session.refreshEnabled`, and `app.session.updateAgeSeconds`. Treat longer
lifetimes and public sliding refresh as explicit risk acceptance for a stolen
cookie. Password recovery and verified email are available only when the SMTP
mode above is configured.

## Production boundary

A production operator must supply infrastructure outside the local Compose
defaults:

- persistent local storage for the SQLite database and WAL on one active
  application/worker host, or a remote libSQL service for a supported
  multi-host topology;
- an authenticated, release-pinned Hatchet deployment or compatible managed
  Hatchet endpoint with TLS;
- unique `BETTER_AUTH_SECRET`, `BYOK_GRID_MASTER_KEY`, and
  `BYOK_GRID_MASTER_KEY_ID` values from a secret manager, plus an optional
  secret-managed `BYOK_GRID_ADDITIONAL_MASTER_KEYS` overlap set used only
  during documented rotation;
- HTTPS termination with the canonical public URL configured consistently;
- disabled or secret-backed allowlisted account provisioning, with approved
  addresses removed after use;
- a TLS-authenticated SMTP service, secret-managed credentials, aligned sending
  domain, and tested inbox delivery when account recovery is enabled;
- an explicitly reviewed bounded session lifetime and refresh policy;
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

The [API transport security guide](API_SECURITY.md) defines the 64-KiB Better
Auth boundary, five-MiB JSON and ingestion boundaries, 50-MiB CSV boundary,
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
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BYOK_GRID_MASTER_KEY`,
`BYOK_GRID_MASTER_KEY_ID`, and optional `BYOK_GRID_ADDITIONAL_MASTER_KEYS`.
The workflow worker needs the same SQLite and BYOK
encryption-key settings plus Hatchet client settings. No BYOK Grid runtime needs
PostgreSQL credentials.

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

Set both `HATCHET_CLIENT_HOST_PORT` for gRPC task dispatch and
`HATCHET_CLIENT_API_URL` for REST lifecycle operations. Do not rely on the API
URL embedded in a token: it may name `localhost` from the machine where the
token was minted, which prevents a containerized worker from pausing itself
during a graceful drain.

The web image health check proves runtime configuration is valid and the Next.js
server can open a fully migrated SQLite database. The worker profile parses
Hatchet's native health status and performs a graceful drain on termination.
Neither check proves provider reachability or that queue age is within its SLO.
Production monitoring must cover queued-work age, workflow failure rate,
database saturation, and provider error/limit rates separately.
The worker health port serves Hatchet/process Prometheus metrics at `/metrics`.
A separate application endpoint on port `8002` exposes low-cardinality
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
