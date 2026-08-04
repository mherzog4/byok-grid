# Verify Kubernetes external-secret provenance

Use this read-only verifier after the digest-pinned candidate is Ready. It
binds the Secret reference already proven by the live runtime verifier to one
recent `external-secrets.io/v1` synchronization, a Ready `SecretStore` or
`ClusterSecretStore`, and a stable immutable External Secrets Operator
controller Deployment.

The reference deployment supports External Secrets Operator as its open-source
controller contract while leaving the backing provider operator-selected.
Another controller requires its own reviewed repository verifier before its
provenance can satisfy stable release evidence.

## Safety and permissions

The command runs `kubectl config current-context` and read-only `get` requests
for one `ExternalSecret`, one store, one controller Deployment, and its selected
Pods. It never requests a Kubernetes `Secret`, reads secret data, applies a
resource, executes in a Pod, or prints resource names, remote keys, provider
configuration, or Secret references.

Use a dedicated identity with only:

- `get` on `externalsecrets.external-secrets.io` and namespaced
  `secretstores.external-secrets.io` in the candidate namespace, or `get` on the
  one declared `clustersecretstores.external-secrets.io`;
- `get` on the declared controller Deployment; and
- `get`/`list` on Pods in the controller namespace.

Do not grant `get`, `list`, or `watch` on Kubernetes Secrets to this identity.
The verifier rejects system namespaces and requires the application and
controller namespaces to be distinct.

## ExternalSecret contract

Use the served `external-secrets.io/v1` API. The verifier deliberately rejects
deprecated beta resources, `dataFrom`, target templates, non-periodic refresh,
and transformed remote values. Declare every target key with one `spec.data`
entry and set:

```yaml
spec:
  refreshPolicy: Periodic
  refreshInterval: 1h0m0s
  secretStoreRef:
    kind: SecretStore
    name: production-store
  target:
    name: byok-grid-secrets
    creationPolicy: Owner
    deletionPolicy: Retain
```

The target key set must exactly match the active deployment. With default chart
key names, the production base is:

```text
better-auth-secret,byok-grid-master-key,hatchet-client-token,sqlite-auth-token,sqlite-database-url
```

Add, in lexical order, only keys used by enabled configuration:

- `byok-grid-additional-master-keys` during an overlapped key rotation;
- `signup-allowed-emails` for allowlist signup;
- both `smtp-password` and `smtp-user` for authenticated SMTP;
- `connector-runner-shared-secret` for the optional connector runner; and
- `clickhouse-password` for the optional analytics projector.

If chart key names are customized, use those exact names. The verifier hashes
the sorted key set and complete local-to-remote bindings but emits neither.

## Controller contract

Install the controller in a dedicated namespace with a dedicated
ServiceAccount. Pin its only synchronization container to a reviewed OCI
digest. The Deployment template and every admitted Pod must:

- run the exact digest-pinned image with zero restarts;
- be on one fully observed, updated, Ready revision;
- run as non-root with read-only root filesystem, no privilege escalation,
  `privileged: false`, all capabilities dropped, and RuntimeDefault seccomp;
- avoid host networking, host PID/IPC, hostPath, sidecars, init/ephemeral
  containers, and the default ServiceAccount.

The controller needs its dedicated Kubernetes API identity, so this verifier
does not require service-account token automount to be disabled.

## Run the verifier

Set the exact image reference from the reviewed controller deployment, not a
tag. Set the maximum age to at least the refresh interval and no more than two
intervals plus five minutes. The defaults are a two-hour maximum age and a
24-hour upper bound.

```text
export BYOK_GRID_EXTERNAL_SECRET_VERIFY_CONFIRM=read-only-external-secret-candidate
export BYOK_GRID_EXTERNAL_SECRET_CANDIDATE_SHA=<40-character-lowercase-RC-commit-SHA>
export BYOK_GRID_EXTERNAL_SECRET_CONTEXT=<exact-kubectl-context>
export BYOK_GRID_EXTERNAL_SECRET_NAMESPACE=<candidate-namespace>
export BYOK_GRID_EXTERNAL_SECRET_NAME=<external-secret-resource-name>
export BYOK_GRID_EXTERNAL_SECRET_STORE_KIND=SecretStore
export BYOK_GRID_EXTERNAL_SECRET_STORE_NAME=<store-name>
export BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS=<sorted-comma-separated-target-keys>
export BYOK_GRID_EXTERNAL_SECRET_MAX_REFRESH_AGE_SECONDS=7200
export BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_NAMESPACE=<controller-namespace>
export BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_DEPLOYMENT=<controller-deployment>
export BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_CONTAINER=<controller-container>
export BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_IMAGE=<repository>@sha256:<64-lowercase-hex>

npm run release:verify-kubernetes-secret-provenance
```

For a cluster-scoped store, set
`BYOK_GRID_EXTERNAL_SECRET_STORE_KIND=ClusterSecretStore`. A passing check emits
one JSON line with marker
`BYOK_GRID_KUBERNETES_EXTERNAL_SECRET_PROVENANCE_VERIFIED`.

Retain the exact line with the runtime and NetworkPolicy evidence. Confirm its
`secretReferenceSha256` exactly equals the field in
`BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED`. The record also binds the candidate,
context, controller digest and pod count, ExternalSecret/store generations,
refresh time and interval, hashed sync version, hashed controller/resource/store
identities, hashed key/binding sets, and a hash of the complete store spec.

## Evidence boundary

The marker proves the declared Kubernetes objects and recent controller sync.
It does not prove the backing provider's audit log, key custody, rotation
approval, IAM policy, deletion recovery, regional availability, or controller
webhook/certificate availability. Retain provider audit evidence showing the
declared workload identity fetched the expected version during the recorded
window, plus the separate runtime, CNI, telemetry, alert, recovery, and rollback
evidence required by [`PRODUCTION_EVIDENCE.md`](PRODUCTION_EVIDENCE.md).

Never put provider credentials, Kubernetes Secret objects, kubeconfig files,
controller tokens, raw remote references, or unredacted provider errors in the
evidence bundle.
