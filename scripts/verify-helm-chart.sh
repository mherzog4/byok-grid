#!/bin/sh
set -eu

chart_dir="${1:-deploy/helm/byok-grid}"
default_render="$(mktemp)"
full_render="$(mktemp)"
digest_manifest="$(mktemp)"
digest_values="$(mktemp)"
digest_render="$(mktemp)"
trap 'rm -f "$default_render" "$full_render" "$digest_manifest" "$digest_values" "$digest_render"' EXIT

helm lint --strict "$chart_dir"
helm template byok-grid "$chart_dir" --namespace byok-grid >"$default_render"
helm template byok-grid-full "$chart_dir" \
  --namespace byok-grid \
  --values "$chart_dir/ci-values.yaml" >"$full_render"

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
grep -q 'helm.sh/hook: pre-install,pre-upgrade' "$default_render"
grep -q 'key: sqlite-database-url' "$default_render"
test "$(grep -c 'name: BYOK_GRID_MASTER_KEY' "$default_render")" -eq 2
grep -q "HATCHET_CLIENT_WORKER_HEALTHCHECK_ENABLED: 'true'" "$default_render"
grep -q 'HATCHET_CLIENT_API_URL: "https://hatchet.example.com"' "$default_render"
grep -q 'BYOK_GRID_METRICS_ENABLED: "true"' "$default_render"
grep -q 'name: app-metrics' "$default_render"
grep -q 'containerPort: 8002' "$default_render"
grep -q "body.status !== 'HEALTHY'" "$default_render"
grep -q 'terminationGracePeriodSeconds: 90' "$default_render"
grep -q 'kind: NetworkPolicy' "$full_render"
grep -q 'value: "10000000"' "$full_render"
grep -q 'name: SQLITE_DATABASE_URL' "$full_render"
grep -q 'app.kubernetes.io/component: analytics-projector' "$full_render"
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

if helm template conflicting-worker-ports "$chart_dir" \
  --set worker.metrics.port=8001 >/dev/null 2>&1; then
  echo 'expected conflicting worker health and application metrics ports to fail' >&2
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
