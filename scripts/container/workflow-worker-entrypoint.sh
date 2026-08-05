#!/bin/sh
set -eu

if [ "${1:-}" = "--image-smoke" ]; then
  node --version >/dev/null
  printf '%s\n' '{"marker":"BYOK_GRID_IMAGE_SMOKE_READY","target":"workflow-worker"}'
  exit 0
fi

: "${SQLITE_DATABASE_URL:?SQLITE_DATABASE_URL is required}"
: "${BYOK_GRID_MASTER_KEY:?BYOK_GRID_MASTER_KEY is required}"
: "${BYOK_GRID_MASTER_KEY_ID:?BYOK_GRID_MASTER_KEY_ID is required}"

if [ "${WORKFLOW_EXECUTION_DRIVER:-local}" = "hatchet" ]; then
  : "${HATCHET_CLIENT_TOKEN:?HATCHET_CLIENT_TOKEN is required for the Hatchet execution driver}"
  : "${HATCHET_CLIENT_API_URL:?HATCHET_CLIENT_API_URL is required for the Hatchet execution driver}"
  : "${HATCHET_CLIENT_HOST_PORT:?HATCHET_CLIENT_HOST_PORT is required for the Hatchet execution driver}"
fi

exec "$@"
