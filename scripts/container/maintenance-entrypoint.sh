#!/bin/sh
set -eu

command_name="${1:-}"
case "$command_name" in
  backup|restore|verify)
    exec node --import tsx packages/db/src/sqlite/backup-cli.ts "$@"
    ;;
  master-key-rotation)
    shift
    exec node --import tsx packages/db/src/sqlite/master-key-rotation-cli.ts "$@"
    ;;
  *)
    echo "Usage: maintenance {backup|verify|restore|master-key-rotation} ..." >&2
    exit 64
    ;;
esac
