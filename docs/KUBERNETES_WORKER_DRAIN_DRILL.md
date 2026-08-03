# Verify authenticated Kubernetes worker draining

This drill proves that the release-candidate workflow worker registers with an
authenticated Hatchet deployment, receives a real workflow step, drains after
an operating-system `SIGTERM`, restarts cleanly, and completes the durable run.
Run it only in a disposable preproduction environment backed by remote libSQL.
It deliberately terminates the worker process.

The local Compose drill is useful image evidence, but Hatchet authentication,
remote database behavior, Kubernetes restart state, and the chosen Hatchet
version are environment contracts. This procedure supplies that missing
environment evidence without treating a rendered manifest as a runtime test.

## Safety boundary

Prepare an isolated namespace and database with all current migrations and no
customer or unrelated workflow activity. Run from a Unix-like operator host
with Node.js, npm, and kubectl installed. The drill refuses to run unless:

- the explicit confirmation phrase is present;
- the application uses a credential-free HTTPS origin;
- the database is an authenticated path-free `libsql://` endpoint;
- the named kubectl context matches the active context;
- the worker deployment is stable at exactly one replica;
- its pod has at least 90 seconds of termination grace;
- Hatchet health is `HEALTHY` with registered actions; and
- queued/running workflows, active steps, and dispatch backlog are all zero.

Use a dedicated signup email permitted by the candidate's registration policy.
It must not already have an account. The fixture generates a random password,
creates its own user and workspace through the public HTTPS application, and
deletes both directly through the isolated remote database during test cleanup.
Do not point the command at a shared staging or production tenant database.

Disable authentication email delivery in this disposable worker-drill release
and configure allowlist registration for only the dedicated drill email. The
fixture needs the ephemeral signup to create an authenticated session
immediately; a production setting that requires email verification correctly
prevents that. Exercise the real SMTP verification and recovery path through
its separate release gate, then restore the production SMTP configuration after
this worker-specific drill.

The Hatchet token stays inside the deployed Secret. The libSQL token is passed
only through the drill process environment and its child test process; neither
credential is placed in a command argument or success record.

## Run the drill

Export these values in a trusted operator shell without saving them in shell
history, source control, CI logs, or a shared terminal transcript:

```text
BYOK_GRID_KUBERNETES_DRAIN_CONFIRM=isolated-preproduction-environment
BYOK_GRID_DRILL_APP_ORIGIN=https://candidate.example.com
BYOK_GRID_DRILL_DATABASE_URL=libsql://candidate-database.example.com
BYOK_GRID_DRILL_DATABASE_AUTH_TOKEN=<least-privilege-isolated-database-token>
BYOK_GRID_DRILL_EMAIL=release-drill@example.com
BYOK_GRID_DRILL_KUBECTL_CONTEXT=<exact-preproduction-context>
BYOK_GRID_DRILL_NAMESPACE=<isolated-namespace>
BYOK_GRID_DRILL_WORKER_DEPLOYMENT=<helm-release>-workflow-worker
```

The workflow fixture has a fixed 120-second deadline, while the worker must
restart inside the stricter 90-second drain ceiling. Then run:

```text
npm run drill:kubernetes-workflow-drain
```

The command performs this sequence:

1. validates the context, deployment, one ready pod, Hatchet health, and idle
   application metrics;
2. creates a 500-row, 100-step workflow through the canonical HTTPS origin;
3. waits until Hatchet exposes a running step;
4. sends `SIGTERM` to PID 1 in the `workflow-worker` container;
5. requires the same pod UID to restart exactly once with previous exit code
   zero and reason `Completed` inside both the deployment grace period and the
   release gate's 90-second ceiling;
6. requires the previous SDK logs to contain the pending-task drain marker and
   no Hatchet pause failure;
7. requires the restarted worker to become authenticated and healthy again;
8. waits for every durable workflow step to succeed and for the fixture cleanup
   to complete; and
9. requires the workflow, active-step, and dispatch metrics to return to zero.

Success emits one JSON line with marker
`BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED`. Retain that line with:

- the candidate commit and image digest manifest;
- the Helm values digest or reviewed values reference;
- the Hatchet server and SDK versions;
- the remote libSQL provider and topology;
- the Kubernetes cluster/version and namespace;
- the previous worker logs and Kubernetes event record in restricted operator
  storage; and
- the operator, UTC start/end time, and pass/fail decision.

The success line contains operational identifiers but no credentials, cookies,
payloads, email, URLs, or provider error text.

## Failure and cleanup

The command never prints child test output, kubectl stderr, libSQL errors, or
Hatchet errors because those transports may include deployment details. Use
restricted cluster and provider logs for investigation.

If the process is interrupted before the fixture's cleanup completes, inspect
the isolated database for the dedicated drill email and its workspace. Confirm
that no workflow is still leased, then remove only that known drill identity or
discard the entire isolated database and namespace. Never copy ad hoc cleanup
SQL into a shared environment. A failed drill is not release evidence; correct
the cause and repeat it from a freshly idle environment.

This drill proves graceful authenticated worker restart and durable completion.
It does not prove multi-replica database recovery, backup restore, ingress,
capacity, alert routing, or provider service-level objectives; retain those as
separate release gates.
