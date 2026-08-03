# Kubernetes network security

The Helm chart renders component-scoped Kubernetes `NetworkPolicy` resources
when `networkPolicy.enabled=true`, which is the default. These policies are a
portable baseline for clusters whose CNI enforces the `networking.k8s.io/v1`
API. Verify enforcement in the actual cluster; creating a policy does not make
a non-enforcing CNI enforce it.

## Ingress contract

One baseline policy selects every pod carrying this Helm release's application
name and instance labels and denies ingress unless another policy allows it.
The chart then adds only these application paths:

- trusted `networkPolicy.ingress.web` peers may reach web container port
  `3000`;
- trusted `networkPolicy.ingress.monitoring` peers may reach the worker health
  port and, when enabled, the separate application-metrics port; and
- worker pods from the same release may reach the optional connector runner on
  port `4319`.

The connector runner has an explicit empty egress policy. The analytics
projector accepts no inbound application connection. Kubernetes allows node-to-
pod traffic, so kubelet probes remain possible even when no monitoring peer is
configured.

When chart ingress is enabled, rendering fails unless at least one web peer is
provided. Define a namespace selector and pod selector in the **same peer** so
both must match:

```yaml
networkPolicy:
  ingress:
    web:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: ingress-nginx
        podSelector:
          matchLabels:
            app.kubernetes.io/name: ingress-nginx
    monitoring:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: monitoring
        podSelector:
          matchLabels:
            app.kubernetes.io/name: prometheus
```

Separate peer entries are alternatives, not cumulative requirements. Confirm
the labels on the real controller pods and namespaces rather than copying the
example. Depending on the CNI, ingress controller mode, and source NAT path,
traffic may arrive with a node or load-balancer identity instead of the
controller pod identity; prove the effective path before cutover.

## Egress contract

Portable Kubernetes NetworkPolicy cannot select a DNS name, HTTP host, TLS SNI,
or cloud service identity. BYOK Grid permits operator-selected libSQL, Hatchet,
provider, webhook, and ClickHouse endpoints, so the chart does not invent
unsafe IP ranges for them. Runtime egress isolation is therefore explicit:

```yaml
networkPolicy:
  egress:
    enabled: true
    shared:
      - to:
          - namespaceSelector:
              matchLabels:
                kubernetes.io/metadata.name: kube-system
            podSelector:
              matchLabels:
                k8s-app: kube-dns
        ports:
          - protocol: UDP
            port: 53
          - protocol: TCP
            port: 53
    web:
      - to:
          - ipBlock:
              cidr: 192.0.2.0/24
        ports:
          - protocol: TCP
            port: 443
    worker: []
    analyticsProjector: []
```

The documentation-only `192.0.2.0/24` range above is not a usable provider
address. Replace every example selector, CIDR, and port with reviewed deployment
values. Shared rules apply to web, worker, and the optional analytics projector;
component rules apply only to that component. When egress isolation is enabled,
an empty effective list means deny all. The chart automatically preserves the
worker-to-runner RPC path, while the runner itself remains unable to initiate
egress.

For hostname-based services with changing addresses, use the installed CNI's
reviewed FQDN-aware policy, an authenticated egress proxy, or another
environment-native control. Kubernetes policies are additive, so those
operator-managed policies can grant required destinations without editing the
chart. Do not replace a provider allowlist with `0.0.0.0/0` merely to make a
readiness check pass.

The migration Job is a pre-install and pre-upgrade Helm hook. On first install,
normal chart resources do not exist until that hook succeeds; on upgrades,
policies from the previous release may already apply. The chart's optional
runtime egress policy deliberately excludes migration pods. Establish a
namespace-level baseline or an operator-owned hook-compatible policy before
installation, and allow the migration identity to reach only the selected
libSQL endpoint and required DNS service.

## Verification and rollout

Render the exact production values and inspect every peer before installation:

```text
npm run helm:verify
helm lint --strict deploy/helm/byok-grid -f values.production.yaml
helm template byok-grid deploy/helm/byok-grid \
  --namespace byok-grid \
  --values values.production.yaml \
  --values values.digests.yaml
```

In a disposable namespace with the production CNI, prove all of the following:

1. an unlabelled pod cannot reach web, worker telemetry, or the runner;
2. the selected ingress controller can reach web and no worker port;
3. the selected monitor can scrape both worker endpoints and no application
   API;
4. the worker can reach libSQL, Hatchet, approved providers, and the optional
   runner, while a disallowed destination fails;
5. web, projector, and migration reach only their required destinations; and
6. the connector runner cannot establish any outbound connection.

Keep a break-glass policy and rollback decision path outside the application
release. Disabling `networkPolicy.enabled` removes chart-owned policies; it is
safe only when an independently tested namespace or platform policy provides
equivalent isolation.
