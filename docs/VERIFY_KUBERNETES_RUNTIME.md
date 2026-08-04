# Verify a live Kubernetes release

Use this read-only verifier after Helm reports a successful production-candidate
rollout and before the retained migration Job expires. It compares the live
release to the candidate's downloaded `IMAGE_DIGESTS.txt` and emits one bounded
JSON record suitable for the `reference-deployment` evidence bundle.

## Safety boundary

The command only runs `kubectl config current-context`, `kubectl version`, and
label-scoped `kubectl get` requests. It does not apply, patch, delete, exec,
port-forward, read Secret values, or print Secret names. Use a dedicated
read-only Kubernetes identity restricted to the candidate namespace.

The verifier requires an exact context, namespace, Helm release, canonical
HTTPS origin, candidate commit, and digest-manifest path. The explicit
confirmation phrase prevents an accidental check against an undeclared
environment.

## Run the check

Download and independently verify the RC release bundle first. Keep
`IMAGE_DIGESTS.txt` as a regular local file; symbolic links and noncanonical or
incomplete manifests are rejected.

```text
export BYOK_GRID_KUBERNETES_VERIFY_CONFIRM=read-only-production-candidate
export BYOK_GRID_KUBERNETES_CANDIDATE_SHA=<40-character-lowercase-commit-SHA>
export BYOK_GRID_KUBERNETES_CONTEXT=<exact-kubectl-context>
export BYOK_GRID_KUBERNETES_DIGEST_MANIFEST=/absolute/path/to/IMAGE_DIGESTS.txt
export BYOK_GRID_KUBERNETES_NAMESPACE=<namespace>
export BYOK_GRID_KUBERNETES_RELEASE=<helm-release-name>
export BYOK_GRID_KUBERNETES_APP_ORIGIN=https://grid.example.com
export BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS=

npm run release:verify-kubernetes-runtime
```

If enabled, set the optional-component value to the exact sorted list
`analytics-projector`, `connector-runner`, or
`analytics-projector,connector-runner`.

A passing check emits one JSON line with marker
`BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED`. Retain the line as immutable evidence
and hash the exact retained bytes. The record includes the candidate, cluster
version, context, namespace, release, canonical origin, digest-manifest hash,
per-workload digest and pod counts, migration completion, and a one-way hash of
the shared Secret reference.

## What the marker proves

The marker verifies the selected live resources have:

- stable web and worker rollouts with all expected pods Ready and restart-free;
- Pod `imageID` values matching the candidate's immutable release digests;
- a successful retained migration Job running the matching migration digest;
- token-free, non-root, capability-dropped, read-only pod security settings;
- Secret-backed sensitive environment entries and remote libSQL mode;
- cluster-internal Services, admitted TLS Ingress, a healthy web disruption
  budget, and a safe optional autoscaling envelope; and
- the chart's default-deny and explicit ingress/egress NetworkPolicy shape.

This marker does **not** prove that a CNI enforces NetworkPolicy, that an
external-secret controller supplied the Secret, that the public proxy chain is
sanitized, or that logs, metrics, alerts, backups, rollback, and provider
services work. Retain controller-provenance evidence, negative connectivity
tests, public-deployment evidence, telemetry and alert-delivery records, and a
tested rollback decision path alongside this marker. Do not put credentials,
raw Secret objects, kubeconfig files, or bearer tokens in an evidence bundle.
Use the isolated behavioral procedure in
[`KUBERNETES_NETWORK_POLICY_DRILL.md`](KUBERNETES_NETWORK_POLICY_DRILL.md) for
the complementary CNI enforcement marker.
Use
[`VERIFY_KUBERNETES_SECRET_PROVENANCE.md`](VERIFY_KUBERNETES_SECRET_PROVENANCE.md)
to bind the hashed Secret reference to a recent External Secrets Operator v1
sync and immutable controller image without fetching Secret data.
