#!/bin/sh
set -eu
# Apply pending migrations before serving. Safe with several replicas: migrate.py takes a
# Postgres advisory lock, so concurrent starts apply each file exactly once.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  python scripts/migrate.py
fi
exec "$@"
