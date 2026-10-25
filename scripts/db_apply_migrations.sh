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
#   scripts/db_apply_migrations.sh --record V2__integrity   # declare one migration applied, running nothing
#
# One ledger caveat this script cannot fix by itself: the platform service runs Flyway and keeps
# `flyway_schema_history`, while this script keeps `schema_migrations`. A database built by hand has
# neither, and then a run here fails on `already exists` rather than clobbering it — read that error and
# use --record once the content has been compared against a migrated database (DECISIONS D32).
#
# Environment overrides (an exported value wins over .env, so a scratch/target DB is addressable
# without editing .env, which other streams read):
#   NEXUS_PG_CONTAINER=nexus-platform-postgres   NEXUS_DB_NAME=nexus   NEXUS_DB_SUPERUSER=postgres
#   (a container booted with POSTGRES_USER != postgres needs NEXUS_DB_SUPERUSER set to its superuser,
#    otherwise every psql call fails with `FATAL: role "postgres" does not exist`.)
#
# Windows/Git Bash notes:
#   * CRLF is stripped before piping (git checkout may use CRLF on Windows).
#   * `set -euo pipefail`, no bash-4-only features, no GNU-unless-present assumptions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CONTAINER="${NEXUS_PG_CONTAINER:-nexus-platform-postgres}"
DBNAME="${NEXUS_DB_NAME:-nexus}"
PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
# Variables the CALLER exported win over .env (see the "if the caller has not exported" note below):
# .env pins NEXUS_DB_NAME=nexus, so without capturing these first, a scratch/target database chosen on
# the command line (`NEXUS_DB_NAME=nexus_scratch scripts/db_apply_migrations.sh`) would be silently
# ignored and the migrations would land in the real database.
CALLED_CONTAINER="${NEXUS_PG_CONTAINER:-}"
CALLED_DBNAME="${NEXUS_DB_NAME:-}"
CALLED_PGUSER="${NEXUS_DB_SUPERUSER:-}"
MIG_DIR="$ROOT/infra/db/migrations"
SEED_DIR="$ROOT/infra/db/seed"
ROLES_SQL="$ROOT/infra/postgres/init/00_roles.sql"
# The role the platform service connects as, and therefore the role that must own anything a later
# Flyway migration has to replace in place (views). Same default as application.yml.
APP_ROLE="${NEXUS_PLATFORM_DB_USERNAME:-nexus_app}"
APPLY_ONLY=""
RECORD=()
RUN_SEED=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --seed)    RUN_SEED=1 ;;
    --force)   FORCE=1 ;;
    --record)  shift; RECORD+=("${1:?--record needs a version, e.g. --record V2__integrity}") ;;
    --file)    shift; APPLY_ONLY="${1:?--file needs a path}" ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# Load .env if the caller has not exported the variables (compose may already have done it).
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
  CONTAINER="${CALLED_CONTAINER:-${NEXUS_PG_CONTAINER:-$CONTAINER}}"
  DBNAME="${CALLED_DBNAME:-${NEXUS_DB_NAME:-$DBNAME}}"
  PGUSER="${CALLED_PGUSER:-${NEXUS_DB_SUPERUSER:-$PGUSER}}"
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
    # The service runs Flyway too, and keeps its own ledger. A database migrated by the platform at boot has
    # V4 in flyway_schema_history and nothing in schema_migrations, so without this the script would re-run a
    # migration that already happened — harmless only because V4 was written to be resumable. Any migration
    # that is NOT idempotent would be corrupted by that second pass (DECISIONS D30).
    local flyway_row
    flyway_row="$(psql_exec "SELECT 1 FROM information_schema.tables WHERE table_name = 'flyway_schema_history'")"
    if [ "$flyway_row" = "1" ]; then
      local vnum already
      vnum="${version#V}"; vnum="${vnum%%__*}"
      already="$(psql_exec "SELECT 1 FROM flyway_schema_history WHERE version = '$vnum' AND success")"
      if [ "$already" = "1" ]; then
        echo "= skip  $version (applied by the service's Flyway)"
        psql_exec "INSERT INTO schema_migrations(version, applied_at) VALUES ('$version', now())
                   ON CONFLICT (version) DO NOTHING" >/dev/null
        return 0
      fi
    fi
  fi
  echo "> apply $version  <- $(basename "$file")"
  # --single-transaction: a migration that fails half-way leaves NO partial schema behind.
  # stderr is captured in a VARIABLE, not a temp file. On this host `mktemp` returns a `C:\…`
  # path and the node runtime's safe-delete shim refuses to `rm` it — which aborted the script on
  # the CLEANUP line of a migration that had succeeded, masking the real exit status. A variable
  # has nothing to delete. (`2>&1 >/dev/null` sends stderr to the capture pipe, stdout to null.)
  local err rc=0
  err="$(sed 's/\r$//' "$file" | docker exec -i "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 --single-transaction -U "$PGUSER" -d "$DBNAME" -q -f - 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$err" >&2
    # `already exists` is not a broken migration — it is a database whose content predates its ledger,
    # which happens whenever a schema was built by hand (or by Flyway, whose history this script does
    # not read when the service never booted against that database). Re-running would be a silent
    # double-apply, so stop and name the repair instead of letting the operator guess at the error.
    if printf '%s\n' "$err" | grep -qE 'already exists'; then
      echo "!! $version was not executed: the objects it creates are already in '$DBNAME', but" \
           "$version is not in schema_migrations, so this script cannot tell applied-by-hand from a" \
           "half-built schema." >&2
      echo "!! Compare the content (tables + pg_indexes + pg_constraint) against a database that IS" \
           "migrated, then declare it:" >&2
      echo "     scripts/db_apply_migrations.sh --record $version" >&2
      echo "!! Until then this database cannot be migrated by either ledger, and role grants further" \
           "down in this run are skipped." >&2
      exit 1
    fi
    return "$rc"
  fi
  if [ -n "$version" ]; then
    psql_exec "INSERT INTO schema_migrations(version, applied_at) VALUES ('$version', now())
               ON CONFLICT (version) DO NOTHING" >/dev/null
  fi
}

record_applied() {
  # Declare a migration applied without executing it, for a database whose content was verified to
  # already match. Deliberately manual: the ledger is the only record of what a hand-built schema has,
  # and a wrong row here makes a real migration skippable later.
  local version="$1" file
  file="$MIG_DIR/${version%.sql}.sql"
  [ -f "$file" ] || { echo "!! --record: no such migration file: $(basename "$file")" >&2; exit 2; }
  local already
  already="$(psql_exec "SELECT 1 FROM schema_migrations WHERE version = '$(basename "${file%.sql}")'")"
  if [ "$already" = "1" ]; then echo "= already recorded"; return 0; fi
  psql_exec "INSERT INTO schema_migrations(version, applied_at) VALUES ('$(basename "${file%.sql}")', now())" >/dev/null
  echo "= recorded $(basename "${file%.sql}") as applied WITHOUT executing it"
  echo "  ledger only — nothing ran against '$DBNAME'. The operator asserted the content matches."
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

# ------------------------------------------------------------------ declared-by-hand migrations
# Processed before the loop so a --record run also lands the role grants below: the reason a ledger-less
# database needs this script at all is usually those grants.
if [ "${#RECORD[@]}" -gt 0 ]; then
  for v in "${RECORD[@]}"; do
    record_applied "$v"
  done
fi

# ------------------------------------------------------------------ migrations, in VERSION order
# Flyway-style V<version>__<name>.sql. The order is the NUMERIC version, not lexicographic: a plain
# glob sorts "V10__…" BEFORE "V1__…" ("0" < "_"), so a from-scratch database ran V10's
# `CREATE INDEX … ON facts` before V1 had created `facts` and the gate died at step 2 — while the
# dev database, whose tables predate V10, could never show it. `sort -V` is the version order
# Flyway itself uses. `grep -v '^$'` keeps an empty glob (nullglob) from feeding one blank line.
shopt -s nullglob
count=0
while IFS= read -r f; do
  case "$f" in *~*) continue ;; esac
  base="$(basename "$f")"
  version="${base%.sql}"
  apply_file "$f" "$version"
  count=$((count + 1))
done < <(printf '%s\n' "$MIG_DIR"/*.sql | grep -v '^$' | sort -V)
shopt -u nullglob
echo "OK: $count migration file(s) considered from infra/db/migrations"

# ------------------------------------------------------------------ role grants bind to real tables
# 00_roles.sql reads the two dev passwords with psql `\getenv`, and psql runs INSIDE the container, so
# the host .env values must be passed through with `docker exec -e` — otherwise `\getenv` leaves the
# variables undefined and `SET x = :'nexus_app_password'` dies with a syntax error.
apply_roles_file() {
  local env_args=""
  [ -n "${NEXUS_DB_APP_PASSWORD:-}" ] && env_args="$env_args -e NEXUS_DB_APP_PASSWORD=$NEXUS_DB_APP_PASSWORD"
  [ -n "${NEXUS_DB_AI_PASSWORD:-}" ]  && env_args="$env_args -e NEXUS_DB_AI_PASSWORD=$NEXUS_DB_AI_PASSWORD"
  # shellcheck disable=SC2086  # intentional word splitting of the -e pairs
  sed 's/\r$//' "$ROLES_SQL" | docker exec -i $env_args "$CONTAINER" \
    psql -v ON_ERROR_STOP=1 --single-transaction -U "$PGUSER" -d "$DBNAME" -q -f -
}
echo "> apply role grants  <- $(basename "$ROLES_SQL")"
apply_roles_file

# ------------------------------------------------------------------ hand the views to the app role
# Views are the only objects a later migration has to replace in place (`CREATE OR REPLACE VIEW`), and
# Postgres refuses that from a non-owner — so whoever runs Flyway must own them. Since D30 that is the
# infra superuser, which can replace anything, making this transfer belt-and-braces rather than
# load-bearing. It is kept anyway: a database provisioned by this script stays migratable by the runtime
# role if someone points `SPRING_FLYWAY_USER` back at it, which is exactly the configuration that booted
# before D30 and failed V4 with `42501 must be owner of table user_identities`. Tables stay with the
# superuser.
echo "> transfer view ownership to $APP_ROLE"
psql_exec "do \$\$
declare r record;
begin
  if not exists (select 1 from pg_roles where rolname = '$APP_ROLE') then
    raise notice 'role $APP_ROLE absent, leaving view ownership with the superuser';
    return;
  end if;
  for r in select c.relname from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('v','m')
              and pg_get_userbyid(c.relowner) <> '$APP_ROLE'
            order by 1
  loop
    execute format('alter view public.%I owner to $APP_ROLE', r.relname);
    raise notice 'view % owned by $APP_ROLE', r.relname;
  end loop;
end
\$\$;"

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
