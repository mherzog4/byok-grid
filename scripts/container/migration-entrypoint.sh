#!/bin/sh
set -eu

if [ "${1:-}" = "--image-smoke" ]; then
  node --version >/dev/null
  printf '%s\n' '{"marker":"BYOK_GRID_IMAGE_SMOKE_READY","target":"migration"}'
  exit 0
fi

: "${SQLITE_DATABASE_URL:?SQLITE_DATABASE_URL is required}"

exec "$@"
