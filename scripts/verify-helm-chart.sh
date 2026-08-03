#!/bin/sh
set -eu

chart_dir="${1:-deploy/helm/byok-grid}"
default_render="$(mktemp)"
full_render="$(mktemp)"
trap 'rm -f "$default_render" "$full_render"' EXIT

helm lint --strict "$chart_dir"
helm template byok-grid "$chart_dir" --namespace byok-grid >"$default_render"
helm template byok-grid-full "$chart_dir" \
  --namespace byok-grid \
  --values "$chart_dir/ci-values.yaml" >"$full_render"

grep -q 'kind: Deployment' "$default_render"
grep -q 'path: /api/live' "$default_render"
grep -q 'helm.sh/hook: pre-install,pre-upgrade' "$default_render"
grep -q 'key: sqlite-database-url' "$default_render"
grep -q 'kind: NetworkPolicy' "$full_render"
grep -q 'value: "10000000"' "$full_render"
grep -q 'name: SQLITE_DATABASE_URL' "$full_render"
grep -q 'app.kubernetes.io/component: analytics-projector' "$full_render"
grep -q 'app.kubernetes.io/component: connector-runner' "$full_render"

if helm template invalid "$chart_dir" \
  --set secrets.create=false \
  --set secrets.existingSecret='' >/dev/null 2>&1; then
  echo 'expected an empty external Secret name to fail schema validation' >&2
  exit 1
fi

echo 'Helm chart lint, default render, full render, and invalid-value checks passed.'
