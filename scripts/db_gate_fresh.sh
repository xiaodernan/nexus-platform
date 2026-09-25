#!/usr/bin/env bash
# NEXUS — build a throwaway database from nothing, seed it, and gate the result. One command.
#
# WHY THIS EXISTS: the seeded dataset is only proven against the database it was loaded into once.
# V4__tenant_scoped_identity.sql is the case that motivated this script — it made
# `user_identities.tenant_id` NOT NULL, which broke the seeder's COPY column list, and the dev
# database could not show it: its identity rows predate the migration and were backfilled, so every
# check against that database passed while a fresh deploy would have died on the first load. Only a
# from-scratch database surfaces that class of defect, and "run the from-scratch database" was a
# note in docs/STATUS.md rather than something anyone executes twice.
#
# Usage:
#   scripts/db_gate_fresh.sh                      # generate + migrate + seed + gate + truncate probe + drop
#   scripts/db_gate_fresh.sh --keep               # leave the gate database behind for psql
#   scripts/db_gate_fresh.sh --skip-generate      # seed from data/seed/out/ as it stands on disk
#   MIN_MERCHANTS=100 scripts/db_gate_fresh.sh    # scale-down for CI, forwarded to quality.sql
#
# Environment overrides:
#   NEXUS_PG_CONTAINER   the container to build in (default: whichever of the known names is running)
#   NEXUS_DB_SUPERUSER   superuser inside it (default: postgres)
#   GATE_DB_PREFIX       naming for the throwaway database (default: nexus_gate)
#
# Safety: this creates and DESTROYS a database. It refuses to run if the target resolves to `nexus`
# or `nexus_test` — the developer database and the integration-test one — and it never touches a
# container it could not name on the command line first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEEP=0
SKIP_GENERATE=0

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)          KEEP=1 ;;
    --skip-generate) SKIP_GENERATE=1 ;;
    -h|--help)       sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "db_gate_fresh.sh: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf 'db_gate_fresh.sh: ERROR: %s\n' "$*" >&2; exit 2; }
step() { printf '\n=== %s\n' "$*"; }

PROTECTED="${NEXUS_DB_NAME:-nexus}"
[ "${GATE_DB_PREFIX:-nexus_gate}" != "$PROTECTED" ] || die "refusing: GATE_DB_PREFIX equals the live database name"

# --------------------------------------------------------------------------- container
# Two names have ever served this project's Postgres on this machine: the compose-declared
# `nexus-platform-postgres` and the hand-rolled container that currently publishes :5433,
# `nexus-platform-testpg`. Resolving rather than assuming matters here because the wrong guess is a
# database created in someone else's server — this machine also runs `nexus-postgres`, `nexus-seed-verify`
# and other projects' instances (D22).
CANDIDATES="${NEXUS_PG_CONTAINER:-} nexus-platform-postgres nexus-platform-testpg"
CONTAINER=""
for c in $CANDIDATES; do
  [ -n "$c" ] || continue
  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -qx true; then CONTAINER="$c"; break; fi
done
[ -n "$CONTAINER" ] || die "no running Postgres container among: $CANDIDATES
   start one: docker compose -f infra/docker-compose.yml --env-file .env up -d postgres
   or name it: NEXUS_PG_CONTAINER=<name> $0"

PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
GATE_DB="${GATE_DB_PREFIX:-nexus_gate}_$$_$(date +%s)"
case "$GATE_DB" in
  nexus|nexus_test|nexus_dev|postgres) die "refusing to use '$GATE_DB' as a throwaway name" ;;
esac

psql_maint() {  # SQL against the maintenance database, so the gate database can be created/dropped
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d postgres
}

psql_gate() {  # SQL against the gate database itself — the counts below have to describe THAT schema
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$GATE_DB"
}

echo "db_gate_fresh.sh  container=$CONTAINER superuser=$PGUSER gate_db=$GATE_DB keep=$KEEP"
echo "                  live databases this run must NOT touch: $PROTECTED, nexus_test"

cleanup() {
  rc=$?
  if [ "$KEEP" = "1" ]; then
    [ "$rc" = "0" ] || echo "!! failed; leaving $GATE_DB in place for inspection" >&2
    echo "gate database kept: docker exec -it $CONTAINER psql -U $PGUSER -d $GATE_DB"
    return
  fi
  if [ -n "${GATE_DB:-}" ]; then
    # Terminate own backends first: Postgres refuses DROP DATABASE while the just-failed step still
    # holds a connection, and a leaked database is exactly the litter this script promised to avoid.
    psql_maint "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$GATE_DB'" >/dev/null 2>&1 || true
    psql_maint "DROP DATABASE IF EXISTS \"$GATE_DB\"" >/dev/null 2>&1 \
      || echo "!! could not drop $GATE_DB — remove it by hand" >&2
  fi
  return "$rc"
}
trap cleanup EXIT

# --------------------------------------------------------------------------- 1. empty database
step "1/7  create $GATE_DB from template0 (empty, no inherited objects)"
psql_maint "CREATE DATABASE \"$GATE_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
[ "$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'pg_%'")" = "0" ] \
  || die "the fresh database is not empty — template1 pollution would make this gate meaningless"

# --------------------------------------------------------------------------- 2. migrations + roles
step "2/7  apply infra/db/migrations/V*.sql + 00_roles.sql"
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_NAME="$GATE_DB" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" | sed -e 's/^/    /'
TABLES="$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")" \
  || die "cannot read the gate schema"
SCHEMA_VERSION="$(psql_gate "SELECT count(*) FROM schema_migrations")" || die "no schema_migrations in the gate database"
echo "    -> gate database now has tables=$TABLES migrations=$SCHEMA_VERSION"

# --------------------------------------------------------------------------- 3. generate the dataset
if [ "$SKIP_GENERATE" = "1" ]; then
  step "3/7  seed generation skipped (--skip-generate): loading data/seed/out/ as found"
else
  step "3/7  generate the synthetic dataset from the CSVs (generate.py self-checks FK integrity)"
  PYTHON="${PYTHON:-python}"
  ( cd "$ROOT" && "$PYTHON" data/seed/generate.py ) 2>&1 | tail -4 | sed -e 's/^/    /'
fi

# --------------------------------------------------------------------------- 4. load
step "4/7  load the seed into the fresh database"
# RESEED_DEPENDENTS=1 states the blast radius rather than discovering it. The truncate script now
# closes itself over the live foreign keys (D63), so it would clear these 27 tables on a fresh
# database anyway — they are empty there. The gate names them because a from-scratch proof should not
# depend on nothing having been written yet.
CONTAINER="$CONTAINER" DB="$GATE_DB" USER="$PGUSER" RESEED_DEPENDENTS=1 \
  "$ROOT/data/seed/load.sh" | tail -12 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 5. gate
step "5/7  data/seed/quality.sql (the hard gate)"
VARS=""
for v in MIN_MERCHANTS MIN_OFFERINGS MIN_REVIEWS MIN_NEAR_SHA_TIN; do
  if [ -n "${!v:-}" ]; then VARS="$VARS -v $v=${!v}"; fi
done
# shellcheck disable=SC2086  # intentional word splitting of the -v pairs
GATE_OUT="$(mktemp "${TMPDIR:-/tmp}/nexus-gate-fresh.XXXXXX")"
trap 'rm -f "$GATE_OUT"; cleanup' EXIT
if printf '%s\n' "$(sed 's/\r$//' "$ROOT/data/seed/quality.sql")" \
   | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA $VARS -U "$PGUSER" -d "$GATE_DB" > "$GATE_OUT" 2>&1; then
  CHECKS="$(grep -ac '^  PASS' "$GATE_OUT" || true)"
  printf '    -> %s quality checks passed against a from-scratch schema (tables=%s, migrations=%s)\n' \
    "${CHECKS:-?}" "$TABLES" "$SCHEMA_VERSION"
else
  printf '\nRESULT: FAIL — last lines of the gate:\n' >&2
  tail -25 "$GATE_OUT" >&2 || true
  exit 1
fi

# --------------------------------------------------------------------------- 6. the truncate's two branches
step "6/7  scripts/seed_truncate_probe.sh — an empty stranger is cleared, one holding rows refuses"
# The probe builds its own throwaway database, so the gate's loaded dataset stays the way step 4 left
# it. Running it here is the point: a truncate that only ever succeeds proves nothing, and the branch
# that protects somebody else's rows is the branch nobody waits to see.
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/seed_truncate_probe.sh" 2>&1 | tail -8 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 7. the read census and the source
step "7/7  scripts/check_jsonb_reads.mjs — every jsonb key the build reads is in step 5's answered list"
# Step 5's read list is a transcription of source text, and a transcription drifts silently: the D84 list was
# built by grepping `col->>'key'` in SQL strings and missed eleven reads made through a Java map accessor. This
# is that grep, run as a reader rather than as a note, so the next read nobody answered for reddens here
# instead of returning nothing at runtime. node missing is a FAIL, not a skip — see the script's own LIMITS.
command -v node >/dev/null 2>&1 || die "step 7 needs node on PATH; a skipped census step is not a passed one"
( cd "$ROOT" && node scripts/check_jsonb_reads.mjs ) 2>&1 | sed -e 's/^/    /'

printf '\nRESULT: PASS — %s quality checks on a from-scratch schema (tables=%s, migrations=%s), plus the\n' \
  "${CHECKS:-?}" "$TABLES" "$SCHEMA_VERSION"
printf '        seed truncate shown clearing an empty stranger and refusing one that holds rows, and the\n'
printf '        build'"'"'s jsonb reads reconciled against that list of answered keys.\n'
printf '        SYNTHETIC DEMO DATA. The live databases were not opened by this run.\n'
