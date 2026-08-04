# Kubernetes NetworkPolicy enforcement drill

Use this mutating drill on a disposable, digest-pinned clone of the release
candidate. It proves that the selected cluster CNI enforces BYOK Grid's named
TCP ingress and egress paths and emits one sanitized record for the
`reference-deployment` evidence bundle.

## Safety boundary

Never run this command in a namespace serving users or production traffic. The
drill creates short-lived pods with the web, worker, migration, and optional
component labels. A custom readiness gate keeps every probe NotReady, but those
labels intentionally cause the installed policies to select the pod.

Use four distinct non-system namespaces dedicated to this candidate: the Helm
release namespace plus ingress, monitoring, and untrusted source namespaces.
Label all four `byok-grid.dev/network-drill=isolated`. The command verifies the
active context and every declared namespace label before creating a pod. It
never reads Secrets, mounts a service-account token, prints endpoint names, or
runs more than one probe at a time.

The operator identity needs only `get` on namespaces and pods, `create` and
`delete` on pods in the four drill namespaces, and `get` on pod logs. Do not use
a cluster-admin identity.

## Prepare the isolated candidate

Install the exact RC digests with the production NetworkPolicy values in a
disposable release namespace. Reproduce the real ingress-controller and
monitoring namespace/pod labels in the two dedicated source namespaces. The
untrusted source should have no trusted workload labels.

Copy
[`kubernetes-network-policy-plan.template.json`](kubernetes-network-policy-plan.template.json)
to a private regular file and replace every `replace-*` namespace or host. Keep
the keys, claims, sources, expectations, target IDs, and array ordering exact.
The plan is capped at 128 KiB and symbolic links are rejected.

Choose these targets:

- `web`: the candidate web Service on its actual service port;
- `worker-health` and `worker-metrics`: the same Ready worker pod IP on the two
  configured ports, or an operator-created endpoint that preserves pod-source
  enforcement;
- `libsql` and `hatchet`: the exact approved production-candidate endpoints;
- `unapproved`: a controlled TCP listener outside every application and
  migration allowlist. It must accept the unlabelled control probe so a denied
  result cannot be mistaken for an unavailable destination.

The migration identity must already be selected by the operator-owned
hook-compatible egress policy described in
[`NETWORK_SECURITY.md`](NETWORK_SECURITY.md). If a provider is protected by an
FQDN-aware CNI policy or authenticated egress proxy, point the target at the
same effective route used by the candidate.

If optional components are enabled, add these probes in lexical claim order and
declare the corresponding `clickhouse` or `runner` target:

| Claim                                 | Source                | Expectation | Target       |
| ------------------------------------- | --------------------- | ----------- | ------------ |
| `analytics-clickhouse-egress-allowed` | `analytics-projector` | `allowed`   | `clickhouse` |
| `analytics-unapproved-egress-blocked` | `analytics-projector` | `blocked`   | `unapproved` |
| `connector-unapproved-egress-blocked` | `connector-runner`    | `blocked`   | `unapproved` |
| `untrusted-runner-blocked`            | `untrusted`           | `blocked`   | `runner`     |
| `worker-runner-allowed`               | `worker`              | `allowed`   | `runner`     |

Only include the first two rows for `analytics-projector` and the last three
for `connector-runner`. The parser rejects missing, extra, unsorted, or
incorrectly bound claims.

## Run the drill

Download and independently verify the RC's `IMAGE_DIGESTS.txt` first. The
drill uses its immutable maintenance image rather than a mutable utility image.

```text
export BYOK_GRID_NETWORK_POLICY_DRILL_CONFIRM=isolated-candidate-network-policy
export BYOK_GRID_NETWORK_POLICY_APP_NAME=byok-grid
export BYOK_GRID_NETWORK_POLICY_CANDIDATE_SHA=<40-character-lowercase-RC-commit-SHA>
export BYOK_GRID_NETWORK_POLICY_CONTEXT=<exact-kubectl-context>
export BYOK_GRID_NETWORK_POLICY_DIGEST_MANIFEST=/absolute/path/to/IMAGE_DIGESTS.txt
export BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS=
export BYOK_GRID_NETWORK_POLICY_PLAN=/absolute/path/to/private-network-policy-plan.json
export BYOK_GRID_NETWORK_POLICY_RELEASE=<helm-release-name>
export BYOK_GRID_NETWORK_POLICY_RELEASE_NAMESPACE=<isolated-release-namespace>

npm run drill:kubernetes-network-policy
```

When both optional components are enabled, use the exact sorted value
`analytics-projector,connector-runner`. The default connection timeout is five
seconds and the total deadline is five minutes. Override them only when the
observed environment requires it with
`BYOK_GRID_NETWORK_POLICY_CONNECT_TIMEOUT_MS` (1,000–20,000) and
`BYOK_GRID_NETWORK_POLICY_TOTAL_TIMEOUT_MS` (30,000–600,000).

For each target, the command runs all allowed controls before blocked probes.
A passing run emits one JSON line with marker
`BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED`. Retain the exact
line and hash its bytes. It binds the result to the candidate commit, release
digest manifest, context, release, namespace, immutable maintenance digest,
closed claim list, plan hash, target-set hash, optional components, run ID, and
verification time. It does not include target hosts or ports.

## Failure and cleanup

The command deletes each exact pod before proceeding. Interruption or operator
host failure can leave a NotReady probe behind. Find leftovers without exposing
the private plan:

```text
kubectl --context <exact-context> get pods --all-namespaces \
  --selector=byok-grid.dev/network-drill-id
```

Review the returned names and namespaces, then delete only those exact probe
pods. Do not delete by application labels because those labels intentionally
overlap the candidate workloads. Treat any cleanup failure, unexpected restart,
Ready probe, mismatched result, or unavailable allowed control as a failed
drill and do not retain a success marker.

## What the marker does not prove

The marker proves the closed TCP claim set in the declared isolated clone. It
does not prove UDP/DNS behavior, FQDN/SNI/HTTP identity, the live production
ingress controller's source-NAT path, external-secret provenance, public proxy
sanitization, provider health, telemetry, alert delivery, backups, or rollback.
Retain the separate live-runtime, public-deployment, external-secret,
observability, recovery, and rollback evidence required by
[`PRODUCTION_EVIDENCE.md`](PRODUCTION_EVIDENCE.md).
