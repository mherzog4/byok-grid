#!/bin/sh
set -eu

: "${SQLITE_DATABASE_URL:?SQLITE_DATABASE_URL is required}"

exec "$@"
