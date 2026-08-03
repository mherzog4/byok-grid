#!/bin/sh
set -eu

: "${SQLITE_DATABASE_URL:?SQLITE_DATABASE_URL is required}"
: "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}"
: "${BETTER_AUTH_URL:?BETTER_AUTH_URL is required}"

exec "$@"
