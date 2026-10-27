#!/usr/bin/env bash
# NEXUS — does a database's schema and migration ledger still match the migration files?
#
# WHY THIS EXISTS: STATUS's own open list says nexus_test's ledger is "recorded, not validated" —
# nothing runs the migration files through a hand-built schema, so drift stays invisible until
# something errors at the worst moment. The 334-row comparison that once justified nexus_test's
# ledger rows was a one-off no one can re-run. This script makes that comparison a command.
#
# Two halves, both required for a green verdict:
#   1. LEDGER   — every V*.sql file has a schema_migrations row (version = filename minus .sql),
#                 and every row names a file that exists. A flyway_schema_history table, if
#                 present, is printed as context because the platform service keeps one and a
#                 database can carry both ledgers.
#   2. SCHEMA   — a throwaway reference database is built from template0 through
#                 scripts/db_apply_migrations.sh (the exact path the fresh gate uses), and its
#                 public-schema catalog is diffed against the target's: tables, views, columns,
#                 indexes, constraints. The bookkeeping tables (schema_migrations,
#                 flyway_schema_history) are excluded here; the ledger half owns them.
#
# Usage:
#   scripts/db_schema_drift.sh                    # validate nexus_test
#   scripts/db_schema_drift.sh --db nexus         # validate the dev database (read-only against it)
#   scripts/db_schema_drift.sh --ledger-only      # skip the reference build; files-vs-rows only
#
# Environment overrides:
#   NEXUS_PG_CONTAINER   container to build in (default: whichever known name is running)
#   NEXUS_DB_SUPERUSER   superuser inside it (default: postgres)
#
# Safety: the target is only READ. The reference database is created from template0 and dropped
# on exit (trap), and its name is prefixed so it can never collide with a real database. This
# script refuses to run if the reference name would resolve to a protected database name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

TARGET="nexus_test"
LEDGER_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --db)          shift; TARGET="${1:?--db needs a database name}" ;;
    --ledger-only) LEDGER_ONLY=1 ;;
    -h|--help)     awk 'NR>1 { if ($0 ~ /^$/) { print ""; next } if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "db_schema_drift.sh: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf 'db_schema_drift.sh: ERROR: %s\n' "$*" >&2; exit 2; }
step() { printf '\n=== %s\n' "$*"; }

CANDIDATES="${NEXUS_PG_CONTAINER:-} nexus-platform-postgres nexus-platform-testpg"
CONTAINER=""
for c in $CANDIDATES; do
  [ -n "$c" ] || continue
  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -qx true; then CONTAINER="$c"; break; fi
done
[ -n "$CONTAINER" ] || die "no running Postgres container among: $CANDIDATES"

PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
MIG_DIR="$ROOT/infra/db/migrations"

psql_t() {  # SQL against the target database — read-only by this script's contract
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$TARGET"
}
psql_m() {  # SQL against the maintenance database (create/drop of the reference)
  printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d postgres
}

docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 || die "container not running: $CONTAINER"
psql_m "SELECT 1" >/dev/null || die "cannot connect to container $CONTAINER as $PGUSER"
psql_t "SELECT 1" >/dev/null || die "target database '$TARGET' does not exist or is unreachable"

FAILURES=0

# --------------------------------------------------------------------------- 1. ledger half
step "1/2  ledger: infra/db/migrations/V*.sql vs $TARGET's schema_migrations"

TMP="$(mktemp -d)"
# D559: a cleanup must not fail the step. `mktemp -d` returns a `C:\…` path on this host and the
# node runtime's safe-delete shim refuses to `rm -rf` it; under `set -e` that turned a clean run
# into a non-zero exit on the cleanup line.
trap 'rm -rf "$TMP" 2>/dev/null || true; [ -n "${REF_DB:-}" ] && psql_m "DROP DATABASE IF EXISTS \"$REF_DB\"" >/dev/null 2>&1 || true' EXIT

ls "$MIG_DIR"/V*.sql >/dev/null 2>&1 || die "no V*.sql files in $MIG_DIR"
for f in "$MIG_DIR"/V*.sql; do basename "$f" .sql; done | sort > "$TMP/files.txt"
psql_t "SELECT version FROM schema_migrations ORDER BY version" > "$TMP/rows.txt" 2>"$TMP/rows.err" \
  || die "cannot read schema_migrations on '$TARGET': $(cat "$TMP/rows.err")"

printf '    files: %s   ledger rows: %s\n' "$(wc -l < "$TMP/files.txt" | tr -d ' ')" "$(wc -l < "$TMP/rows.txt" | tr -d ' ')"
MISSING="$(comm -23 "$TMP/files.txt" "$TMP/rows.txt")"
ORPHANS="$(comm -13 "$TMP/files.txt" "$TMP/rows.txt")"

if [ -n "$MISSING" ]; then
  FAILURES=$((FAILURES + 1))
  printf '    RED — migration file(s) with no schema_migrations row on %s:\n' "$TARGET"
  printf '%s\n' "$MISSING" | sed 's/^/      /'
else
  printf '    every V*.sql file has a ledger row\n'
fi
if [ -n "$ORPHANS" ]; then
  FAILURES=$((FAILURES + 1))
  printf '    RED — schema_migrations row(s) naming no file in infra/db/migrations:\n'
  printf '%s\n' "$ORPHANS" | sed 's/^/      /'
else
  printf '    every ledger row names an existing file\n'
fi

if psql_t "SELECT 1 FROM information_schema.tables WHERE table_name='flyway_schema_history' AND table_schema='public'" | grep -q 1; then
  FLY="$(psql_t "SELECT min(version)||'..'||max(version)||' ('||count(*)||' rows)' FROM flyway_schema_history")"
  printf '    context: this database also carries flyway_schema_history, versions %s\n' "$FLY"
fi

if [ "$LEDGER_ONLY" -eq 1 ]; then
  step "2/2  schema: skipped (--ledger-only)"
  if [ "$FAILURES" -gt 0 ]; then
    printf '\nRESULT: FAIL — %s ledger discrepancy file(s) against %s. Nothing was built; the schema was not judged.\n' "$FAILURES" "$TARGET"
    exit 1
  fi
  printf '\nRESULT: PASS — ledger matches the migration files on %s (schema not judged, --ledger-only).\n' "$TARGET"
  exit 0
fi

# --------------------------------------------------------------------------- 2. schema half
step "2/2  schema: diff $TARGET's catalog against a from-template0 reference build"

REF_DB="nexus_drift_$$_$(date +%s)"
case "$REF_DB" in
  nexus|nexus_test) die "reference name collided with a protected database: $REF_DB" ;;
esac

psql_m "CREATE DATABASE \"$REF_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null

CATALOG_SQL="
SELECT 'TABLE|'    || table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_type='BASE TABLE'
   AND table_name NOT IN ('schema_migrations','flyway_schema_history')
UNION ALL
SELECT 'VIEW|'     || table_name FROM information_schema.views
 WHERE table_schema='public'
   AND table_name NOT IN ('schema_migrations','flyway_schema_history')
UNION ALL
SELECT 'COLUMN|'   || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable
FROM information_schema.columns WHERE table_schema='public'
  AND table_name NOT IN ('schema_migrations','flyway_schema_history')
UNION ALL
SELECT 'INDEX|'    || indexname || '|' || indexdef FROM pg_indexes
 WHERE schemaname='public'
   AND indexname NOT LIKE 'schema_migrations%'
   AND indexname NOT LIKE 'flyway_schema_history%'
UNION ALL
SELECT 'CONSTRAINT|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid)
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND conrelid::regclass::text NOT IN ('schema_migrations','flyway_schema_history')
ORDER BY 1;"

NEXUS_DB_NAME="$REF_DB" NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" > "$TMP/apply.log" 2>&1 \
  || { sed 's/^/    /' "$TMP/apply.log"; die "reference build failed — see the apply log above"; }
printf '    reference %s built from template0 through db_apply_migrations.sh\n' "$REF_DB"

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$REF_DB" <<< "$CATALOG_SQL" > "$TMP/ref.txt"
psql_t "$CATALOG_SQL" > "$TMP/target.txt"

if diff -u "$TMP/ref.txt" "$TMP/target.txt" > "$TMP/drift.txt"; then
  printf '    catalog identical: %s objects compared (tables, views, columns, indexes, constraints)\n' "$(wc -l < "$TMP/ref.txt" | tr -d ' ')"
else
  FAILURES=$((FAILURES + 1))
  printf '    RED — catalog drift between the reference build and %s (lines + are reference-only, - are target-only):\n' "$TARGET"
  sed 's/^/    /' "$TMP/drift.txt"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\nRESULT: FAIL — %s discrepancy class(es) against %s. The reference database was dropped; the target was read only.\n' "$FAILURES" "$TARGET"
  exit 1
fi
printf '\nRESULT: PASS — %s matches the migration files in both ledger and schema (%s catalog objects).\n' "$TARGET" "$(wc -l < "$TMP/ref.txt" | tr -d ' ')"
