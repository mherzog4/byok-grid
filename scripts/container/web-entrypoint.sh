#!/bin/sh
set -eu

if [ "${1:-}" = "--image-smoke" ]; then
  node --version >/dev/null
  printf '%s\n' '{"marker":"BYOK_GRID_IMAGE_SMOKE_READY","target":"web"}'
  exit 0
fi

: "${SQLITE_DATABASE_URL:?SQLITE_DATABASE_URL is required}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL is required}"
: "${BYOK_GRID_MASTER_KEY:?BYOK_GRID_MASTER_KEY is required}"
: "${BYOK_GRID_MASTER_KEY_ID:?BYOK_GRID_MASTER_KEY_ID is required}"

exec "$@"
