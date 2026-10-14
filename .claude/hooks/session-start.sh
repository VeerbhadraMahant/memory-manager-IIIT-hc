#!/bin/bash
#
# SessionStart hook for Claude Code cloud sessions: a local Postgres+pgvector and the
# backend/frontend dependencies, so `ruff`, `pytest`, `npm run lint` and `npm run build`
# work the way CI runs them. The database is local and disposable — never a Supabase
# project — because the test suite TRUNCATEs every table.
#
# pgvector itself comes from the environment's setup script
# (`apt-get install -y postgresql-16-pgvector`); this installs it only as a fallback.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# ---------------------------------------------------------------- Postgres + pgvector
PG_VERSION=$(ls /usr/lib/postgresql | sort -n | tail -1)
if [ ! -f "/usr/lib/postgresql/$PG_VERSION/lib/vector.so" ]; then
  apt-get update -qq && apt-get install -y -qq "postgresql-$PG_VERSION-pgvector" >/dev/null
fi

service postgresql start >/dev/null
for _ in $(seq 1 30); do
  pg_isready -q -h 127.0.0.1 && break
  sleep 1
done

# Superuser so the migrations can CREATE EXTENSION vector. Fine for a throwaway DB.
su postgres -c "psql -q -tAc \"select 1 from pg_roles where rolname='nam'\"" | grep -q 1 \
  || su postgres -c "psql -q -c \"create role nam login superuser password 'nam'\""
for db in nam nam_test; do
  su postgres -c "psql -q -tAc \"select 1 from pg_database where datname='$db'\"" | grep -q 1 \
    || su postgres -c "createdb -O nam $db"
done

# ---------------------------------------------------------------- backend
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r backend/requirements.lock pytest ruff

# ---------------------------------------------------------------- frontend
# `npm ci`, not `npm install`: the latter rewrites package-lock.json under older npm.
(cd frontend && npm ci --no-audit --no-fund --loglevel=error)

# ---------------------------------------------------------------- session env
# Defaults only: values set in the environment's settings take precedence.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$PWD/.venv/bin:\$PATH\""
    echo ': "${TEST_DATABASE_URL:=postgresql://nam:nam@127.0.0.1:5432/nam_test}"; export TEST_DATABASE_URL'
    echo ': "${DATABASE_URL:=postgresql://nam:nam@127.0.0.1:5432/nam}"; export DATABASE_URL'
  } >> "$CLAUDE_ENV_FILE"
fi
