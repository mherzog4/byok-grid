#!/bin/sh
set -eu

chart_dir="${1:-deploy/helm/byok-grid}"
default_render="$(mktemp)"
full_render="$(mktemp)"
digest_manifest="$(mktemp)"
digest_values="$(mktemp)"
digest_render="$(mktemp)"
egress_render="$(mktemp)"
trap 'rm -f "$default_render" "$full_render" "$digest_manifest" "$digest_values" "$digest_render" "$egress_render"' EXIT

helm lint --strict "$chart_dir"
helm template byok-grid "$chart_dir" --namespace byok-grid >"$default_render"
helm template byok-grid-full "$chart_dir" \
  --namespace byok-grid \
  --values "$chart_dir/ci-values.yaml" >"$full_render"
helm template byok-grid-egress "$chart_dir" \
  --namespace byok-grid \
  --values "$chart_dir/ci-values.yaml" \
  --set networkPolicy.egress.enabled=true >"$egress_render"

{
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-web@sha256:1111111111111111111111111111111111111111111111111111111111111111'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-workflow-worker@sha256:2222222222222222222222222222222222222222222222222222222222222222'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-migration@sha256:3333333333333333333333333333333333333333333333333333333333333333'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-maintenance@sha256:4444444444444444444444444444444444444444444444444444444444444444'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-connector-runner@sha256:5555555555555555555555555555555555555555555555555555555555555555'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-airbyte-destination@sha256:6666666666666666666666666666666666666666666666666666666666666666'
  printf '%s\n' 'ghcr.io/mherzog4/byok-grid-analytics-projector@sha256:7777777777777777777777777777777777777777777777777777777777777777'
} >"$digest_manifest"
node scripts/generate-helm-digest-values.mjs "$digest_manifest" "$digest_values"
helm template byok-grid-digests "$chart_dir" \
  --namespace byok-grid \
  --values "$chart_dir/ci-values.yaml" \
  --values "$digest_values" >"$digest_render"

grep -q 'kind: Deployment' "$default_render"
grep -q 'path: /api/live' "$default_render"
grep -q 'terminationGracePeriodSeconds: 45' "$default_render"
grep -q -- '- sleep 10' "$default_render"
if grep -q 'NEXT_MANUAL_SIG_HANDLE' "$default_render"; then
  echo 'expected the chart to preserve the built-in Next.js signal handler' >&2
  exit 1
fi
test "$(grep -c 'startupProbe:' "$default_render")" -eq 2
grep -A4 'startupProbe:' "$default_render" | grep -q 'path: /api/live'
grep -q 'helm.sh/hook: pre-install,pre-upgrade' "$default_render"
grep -q 'key: sqlite-database-url' "$default_render"
test "$(grep -c 'name: BYOK_GRID_DATABASE_MODE' "$default_render")" -eq 3
test "$(grep -A1 'name: BYOK_GRID_DATABASE_MODE' "$default_render" | grep -c 'value: remote')" -eq 3
grep -q 'BYOK_GRID_PUBLIC_URL: "https://byok-grid.example.com"' "$default_render"
if grep -Eq 'BETTER_AUTH|BYOK_GRID_SIGNUP|BYOK_GRID_EMAIL|SMTP_|BYOK_GRID_SESSION' "$default_render"; then
  echo 'expected the local-owner chart to omit account and SMTP configuration' >&2
  exit 1
fi
test "$(grep -c 'name: BYOK_GRID_MASTER_KEY' "$default_render")" -eq 2
test "$(grep -c 'name: BYOK_GRID_ADDITIONAL_MASTER_KEYS' "$default_render")" -eq 2
grep -q 'key: byok-grid-additional-master-keys' "$default_render"
grep -q "HATCHET_CLIENT_WORKER_HEALTHCHECK_ENABLED: 'true'" "$default_render"
grep -q 'HATCHET_CLIENT_API_URL: "https://hatchet.example.com"' "$default_render"
grep -q 'BYOK_GRID_METRICS_ENABLED: "true"' "$default_render"
grep -q 'name: app-metrics' "$default_render"
grep -q 'containerPort: 8002' "$default_render"
test "$(grep -c 'scripts/container/worker-health-probe.mjs' "$default_render")" -eq 3
test "$(grep -A1 'scripts/container/worker-health-probe.mjs' "$default_render" | grep -c -- '- ready')" -eq 2
test "$(grep -A1 'scripts/container/worker-health-probe.mjs' "$default_render" | grep -c -- '- live')" -eq 1
grep -q 'failureThreshold: 40' "$default_render"
grep -q 'terminationGracePeriodSeconds: 90' "$default_render"
test "$(grep -c '^kind: NetworkPolicy$' "$default_render")" -eq 3
test "$(grep -c '^kind: NetworkPolicy$' "$full_render")" -eq 4
test "$(grep -c '^kind: NetworkPolicy$' "$egress_render")" -eq 8
grep -q 'name: byok-grid-byok-grid-default-deny-ingress' "$default_render"
grep -q 'name: byok-grid-byok-grid-web-ingress' "$default_render"
grep -q 'name: byok-grid-byok-grid-worker-monitoring-ingress' "$default_render"
grep -q 'name: byok-grid-full-byok-grid-connector-runner' "$full_render"
grep -q 'terminationGracePeriodSeconds: 60' "$full_render"
grep -q -- '- sleep 5' "$full_render"
test "$(grep -c 'startupProbe:' "$full_render")" -eq 4
grep -q 'kubernetes.io/metadata.name: ingress-nginx' "$full_render"
grep -q 'kubernetes.io/metadata.name: monitoring' "$full_render"
grep -q 'name: byok-grid-egress-byok-grid-default-deny-runtime-egress' "$egress_render"
grep -q 'name: byok-grid-egress-byok-grid-worker-egress' "$egress_render"
grep -q 'kubernetes.io/metadata.name: kube-system' "$egress_render"
grep -q 'cidr: 192.0.2.0/24' "$egress_render"
grep -q 'cidr: 198.51.100.0/24' "$egress_render"
grep -q 'cidr: 203.0.113.0/24' "$egress_render"
grep -q 'value: "10000000"' "$full_render"
grep -q 'BYOK_GRID_PUBLIC_URL: "https://grid.test.example"' "$full_render"
grep -q 'byok-grid-additional-master-keys:' "$full_render"
grep -q 'name: SQLITE_DATABASE_URL' "$full_render"
test "$(grep -c 'name: BYOK_GRID_DATABASE_MODE' "$full_render")" -eq 4
test "$(grep -A1 'name: BYOK_GRID_DATABASE_MODE' "$full_render" | grep -c 'value: remote')" -eq 4
grep -q 'app.kubernetes.io/component: analytics-projector' "$full_render"
grep -q 'name: projector-health' "$full_render"
grep -q 'containerPort: 8003' "$full_render"
test "$(grep -c 'path: /ready' "$full_render")" -eq 1
test "$(grep -c 'path: /live' "$full_render")" -eq 2
test "$(grep -c 'terminationGracePeriodSeconds: 60' "$full_render")" -eq 2
grep -q 'app.kubernetes.io/component: connector-runner' "$full_render"
test "$(grep -c 'image: \"ghcr.io/mherzog4/byok-grid-.*@sha256:' "$full_render")" -eq 5
test "$(grep -c 'image: \"ghcr.io/mherzog4/byok-grid-.*@sha256:' "$digest_render")" -eq 5
grep -q 'byok-grid-workflow-worker@sha256:2222222222222222222222222222222222222222222222222222222222222222' "$digest_render"
grep -q 'byok-grid-analytics-projector@sha256:7777777777777777777777777777777777777777777777777777777777777777' "$digest_render"

if helm template invalid "$chart_dir" \
  --set secrets.create=false \
  --set secrets.existingSecret='' >/dev/null 2>&1; then
  echo 'expected an empty external Secret name to fail schema validation' >&2
  exit 1
fi

if helm template invalid-tls "$chart_dir" \
  --set worker.hatchet.tlsStrategy=none >/dev/null 2>&1; then
  echo 'expected plaintext Hatchet transport to fail chart validation' >&2
  exit 1
fi

if helm template invalid-hatchet-api "$chart_dir" \
  --set worker.hatchet.apiUrl=http://hatchet.example.com >/dev/null 2>&1; then
  echo 'expected a plaintext production Hatchet API URL to fail chart validation' >&2
  exit 1
fi

if helm template removed-account-settings "$chart_dir" \
  --set app.authentication.enabled=true >/dev/null 2>&1; then
  echo 'expected account configuration to fail chart validation' >&2
  exit 1
fi

if helm template conflicting-worker-ports "$chart_dir" \
  --set worker.metrics.port=8001 >/dev/null 2>&1; then
  echo 'expected conflicting worker health and application metrics ports to fail' >&2
  exit 1
fi

if helm template invalid-web-drain "$chart_dir" \
  --set web.terminationGracePeriodSeconds=30 \
  --set web.preStopSleepSeconds=30 >/dev/null 2>&1; then
  echo 'expected a web preStop delay consuming the full grace period to fail' >&2
  exit 1
fi

if helm template invalid-web-grace "$chart_dir" \
  --set web.terminationGracePeriodSeconds=14 >/dev/null 2>&1; then
  echo 'expected a web termination grace period below 15 seconds to fail' >&2
  exit 1
fi

if helm template invalid-runner-drain "$chart_dir" \
  --values "$chart_dir/ci-values.yaml" \
  --set connectorRunner.terminationGracePeriodSeconds=30 \
  --set connectorRunner.preStopSleepSeconds=30 >/dev/null 2>&1; then
  echo 'expected a connector-runner preStop delay consuming the full grace period to fail' >&2
  exit 1
fi

if helm template invalid-runner-grace "$chart_dir" \
  --set connectorRunner.terminationGracePeriodSeconds=14 >/dev/null 2>&1; then
  echo 'expected a connector-runner termination grace period below 15 seconds to fail' >&2
  exit 1
fi

if helm template invalid-projector-health "$chart_dir" \
  --values "$chart_dir/ci-values.yaml" \
  --set analyticsProjector.health.port=1023 >/dev/null 2>&1; then
  echo 'expected a privileged analytics-projector health port to fail' >&2
  exit 1
fi

if helm template invalid-projector-replicas "$chart_dir" \
  --values "$chart_dir/ci-values.yaml" \
  --set analyticsProjector.replicaCount=0 >/dev/null 2>&1; then
  echo 'expected zero analytics-projector replicas to fail' >&2
  exit 1
fi

if helm template missing-ingress-peer "$chart_dir" \
  --set ingress.enabled=true >/dev/null 2>&1; then
  echo 'expected ingress without a trusted NetworkPolicy peer to fail' >&2
  exit 1
fi

if helm template invalid-egress-port "$chart_dir" \
  --set networkPolicy.egress.web[0].ports[0].port=0 >/dev/null 2>&1; then
  echo 'expected an invalid NetworkPolicy egress port to fail schema validation' >&2
  exit 1
fi

if helm template network-policy-disabled "$chart_dir" \
  --set networkPolicy.enabled=false | grep -q '^kind: NetworkPolicy$'; then
  echo 'expected networkPolicy.enabled=false to omit all NetworkPolicy resources' >&2
  exit 1
fi

if helm template invalid-digest "$chart_dir" \
  --set web.image.digest=sha256:not-a-digest >/dev/null 2>&1; then
  echo 'expected a malformed image digest to fail schema validation' >&2
  exit 1
fi

if helm template ambiguous-image "$chart_dir" \
  --set web.image.tag=mutable \
  --set web.image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa >/dev/null 2>&1; then
  echo 'expected simultaneous image tag and digest values to fail schema validation' >&2
  exit 1
fi

echo 'Helm lint, default/full/digest renders, and invalid-value checks passed.'
