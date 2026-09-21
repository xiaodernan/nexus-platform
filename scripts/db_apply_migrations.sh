#!/usr/bin/env bash
# NEXUS — apply database migrations + role grants + (optionally) seed data.
#
# WHY psql RUNS INSIDE THE CONTAINER: this machine has no psql client on the host (see
# docs/ENVIRONMENT_REPORT.md §3). The pgvector/pgvector:pg16 image ships one, so we pipe SQL into
# `docker exec -i <container> psql -v ON_ERROR_STOP=1`, which is the documented Phase-1 path.
#
# Usage:
#   scripts/db_apply_migrations.sh                 # apply infra/db/migrations/V*.sql in filename order
#   scripts/db_apply_migrations.sh --seed         # ...then infra/db/seed/*.sql (idempotent seeds)
#   scripts/db_apply_migrations.sh --force        # re-apply everything (TRUNCATE-free; assumes scripts are idempotent)
#   scripts/db_apply_migrations.sh --file x.sql    # apply one arbitrary SQL file (relative to repo root)
#
# Windows/Git Bash notes:
#   * CRLF is stripped before piping (git checkout may use CRLF on Windows).
#   * `set -euo pipefail`, no bash-4-only features, no GNU-unless-present assumptions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER="${NEXUS_PG_CONTAINER:-nexus-postgres}"
DBNAME="${NEXUS_DB_NAME:-nexus}"
PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
MIG_DIR="$ROOT/infra/db/migrations"
SEED_DIR="$ROOT/infra/db/seed"
ROLES_SQL="$ROOT/infra/postgres/init/00_roles.sql"
APPLY_ONLY=""
RUN_SEED=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --seed)  RUN_SEED=1 ;;
    --force) FORCE=1 ;;
    --file)  shift; APPLY_ONLY="${1:?--file needs a path}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Load .env if the caller has not exported the variables (compose may already have done it).
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
  CONTAINER="${NEXUS_PG_CONTAINER:-$CONTAINER}"
  DBNAME="${NEXUS_DB_NAME:-$DBNAME}"
fi

psql_exec() {
  # $1 = SQL text, runs as superuser inside the container
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$DBNAME"
}

apply_file() {
  # $1 = host path, $2 = logical version key recorded in schema_migrations
  local file="$1" version="$2"
  [ -f "$file" ] || { echo "!! missing $file" >&2; return 1; }
  if [ "$FORCE" -eq 0 ] && [ -n "$version" ]; then
    local done_row
    done_row="$(psql_exec "SELECT 1 FROM schema_migrations WHERE version = '$version'")"
    if [ "$done_row" = "1" ]; then echo "= skip  $version (already applied)"; return 0; fi
  fi
  echo "> apply $version  <- $(basename "$file")"
  # --single-transaction: a migration that fails half-way leaves NO partial schema behind.
  sed 's/\r$//' "$file" | docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 --single-transaction -U "$PGUSER" -d "$DBNAME" -q -f -
  if [ -n "$version" ]; then
    psql_exec "INSERT INTO schema_migrations(version, applied_at) VALUES ('$version', now())
               ON CONFLICT (version) DO NOTHING" >/dev/null
  fi
}

# ------------------------------------------------------------------ preflight
if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "!! container '$CONTAINER' is not running. Start it: docker compose -f infra/docker-compose.yml --env-file .env up -d postgres" >&2
  exit 1
fi
until docker exec "$CONTAINER" pg_isready -U "$PGUSER" -d "$DBNAME" >/dev/null 2>&1; do
  echo "... waiting for postgres"
  sleep 1
done

# ------------------------------------------------------------------ single-file mode
if [ -n "$APPLY_ONLY" ]; then
  apply_file "$ROOT/$APPLY_ONLY" ""
  echo "OK: applied $APPLY_ONLY"
  exit 0
fi

# ------------------------------------------------------------------ bookkeeping table
psql_exec "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    text PRIMARY KEY,
             applied_at timestamptz NOT NULL DEFAULT now()
           )" >/dev/null

# ------------------------------------------------------------------ migrations, in filename order
# Flyway-style V<version>__<name>.sql, applied in lexicographic order (bash globs are sorted).
shopt -s nullglob
count=0
for f in "$MIG_DIR"/*.sql; do
  case "$f" in *~*) continue ;; esac
  base="$(basename "$f")"
  version="${base%.sql}"
  apply_file "$f" "$version"
  count=$((count + 1))
done
shopt -u nullglob
echo "OK: $count migration file(s) considered from infra/db/migrations"

# ------------------------------------------------------------------ role grants bind to real tables
apply_file "$ROLES_SQL" ""

# ------------------------------------------------------------------ seeds
if [ "$RUN_SEED" -eq 1 ]; then
  shopt -s nullglob
  for f in "$SEED_DIR"/*.sql; do
    apply_file "$f" ""
  done
  shopt -u nullglob
fi

echo "--- summary -------------------------------------------------"
psql_exec "SELECT 'tables=' || count(*) FROM information_schema.tables
             WHERE table_schema='public' AND table_type='BASE TABLE'"
psql_exec "SELECT 'migrations=' || count(*) FROM schema_migrations"
psql_exec "SELECT 'tenant hong-kong=' || count(*) FROM tenants WHERE slug='hong-kong'"
