#!/usr/bin/env bash
# End-to-end read proof on a database nobody has ever used: empty → migrated → seeded → served.
#
# Why this exists next to the two gates that already do (D33's `db_gate_fresh.sh` and the unit suite):
# each of them stops at a boundary. `quality.sql` proves the *rows* are honest; `mvn -o test` proves the
# *projection* turns a row into the documented shape with test fixtures that are inserted by hand.
# Nothing checked the pair — so a seeded fact could be perfectly formed in the table and still never
# reach a card, which is exactly how the §19 rating gap survived every gate until D35: 520 merchants
# rendered a rating, `facts` held no `rating` row for any of them, and both suites stayed green.
#
# This script crosses that seam. It creates a throwaway database, applies the infra migrations and the
# role split, generates and loads the synthetic dataset, boots the platform against *that* database on a
# free port, probes the served consumer reads over HTTP, then shuts down and drops everything.
#
#   scripts/e2e_fresh.sh                 # full run, cleans up after itself
#   scripts/e2e_fresh.sh --keep          # leave the database (and the service) up for psql/curl
#   scripts/e2e_fresh.sh --skip-generate # load data/seed/out/ as found
#   scripts/e2e_fresh.sh --reads-only    # skip the three walks that write rows
#   E2E_PORT=8093 scripts/e2e_fresh.sh
#
# The live `nexus` and `nexus_test` databases are never opened, and neither is the running :8090
# instance: this starts its own process on its own port with its own log file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEEP=0
SKIP_GENERATE=0
READS_ONLY=0
PORT="${E2E_PORT:-8092}"

if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)          KEEP=1 ;;
    --skip-generate) SKIP_GENERATE=1 ;;
    --reads-only)    READS_ONLY=1 ;;
    -h|--help)       sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "e2e_fresh.sh: unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

die() { printf 'e2e_fresh.sh: ERROR: %s\n' "$*" >&2; exit 2; }
step() { printf '\n=== %s\n' "$*"; }

LIVE_DB="${NEXUS_DB_NAME:-nexus}"
[ "$PORT" != "${NEXUS_PORT:-8090}" ] || die "refusing: E2E_PORT equals the running instance's port"

# --------------------------------------------------------------------------- container
# Same resolution as the fresh gate: two names have ever served this project's Postgres on this host,
# and guessing wrong creates a database inside another project's server (D22).
CANDIDATES="${NEXUS_PG_CONTAINER:-} nexus-platform-postgres nexus-platform-testpg"
CONTAINER=""
for c in $CANDIDATES; do
  [ -n "$c" ] || continue
  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -qx true; then CONTAINER="$c"; break; fi
done
[ -n "$CONTAINER" ] || die "no running Postgres container among: $CANDIDATES"

PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
E2E_DB="${E2E_DB_PREFIX:-nexus_e2e}_$$_$(date +%s)"
case "$E2E_DB" in
  nexus|nexus_test|nexus_dev|postgres) die "refusing to use '$E2E_DB' as a throwaway name" ;;
esac

LOG="${TMPDIR:-/tmp}/nexus-e2e-platform.$$.log"
RUN_PID=""
LISTEN_PID=""

psql_maint() { printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d postgres; }
psql_e2e()   { printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$E2E_DB"; }

stop_service() {
  # Kill only what this run started: the maven wrapper pid and the JVM actually holding the port.
  # `spring-boot:run` forks, so killing the parent alone leaves a server listening behind us.
  if [ -n "$LISTEN_PID" ]; then
    taskkill //PID "$LISTEN_PID" //T //F >/dev/null 2>&1 || kill "$LISTEN_PID" 2>/dev/null || true
  fi
  if [ -n "$RUN_PID" ]; then
    kill "$RUN_PID" 2>/dev/null || true
    wait "$RUN_PID" 2>/dev/null || true
  fi
}

cleanup() {
  rc=$?
  if [ "$KEEP" = "1" ]; then
    [ "$rc" = "0" ] || echo "!! failed; leaving $E2E_DB in place for inspection" >&2
    echo "e2e database kept: docker exec -it $CONTAINER psql -U $PGUSER -d $E2E_DB"
    echo "log: $LOG"
    return
  fi
  stop_service
  if [ -n "${E2E_DB:-}" ]; then
    psql_maint "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$E2E_DB'" >/dev/null 2>&1 || true
    psql_maint "DROP DATABASE IF EXISTS \"$E2E_DB\"" >/dev/null 2>&1 \
      || echo "!! could not drop $E2E_DB — remove it by hand" >&2
  fi
  rm -f "$LOG" "$LOG.app" "$LOG.pid" 2>/dev/null || true
  return $rc
}
trap cleanup EXIT

echo "e2e_fresh.sh  container=$CONTAINER db=$E2E_DB port=$PORT keep=$KEEP"
echo "              live databases this run must NOT touch: $LIVE_DB, nexus_test"

# Who owns the port right now. If something is already listening, this run must not start: the health
# probe would answer from *that* process, and every check below would be grading a service this script
# did not configure. That is not hypothetical — an earlier run reached the probes against a leftover
# instance from the previous attempt, which had been launched before the datasource fix landed.
listener_on_port() {
  { netstat -ano 2>/dev/null | grep -aE "TCP +[0-9.]+:$PORT +.*LISTENING" || true; }     | awk '{print $NF}' | head -1
}
[ -z "$(listener_on_port)" ] || die "port $PORT is already in use — choose another with E2E_PORT=..."

# --------------------------------------------------------------------------- 1/7 empty database
step "1/8  create $E2E_DB from template0"
psql_maint "CREATE DATABASE \"$E2E_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
[ "$(psql_e2e "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
                AND table_name NOT LIKE 'pg_%'")" = "0" ] \
  || die "the fresh database is not empty"

# --------------------------------------------------------------------------- 2/7 schema + roles
step "2/8  apply infra/db/migrations/V*.sql + 00_roles.sql"
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_NAME="$E2E_DB" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" | sed -e 's/^/    /'
TABLES="$(psql_e2e "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'
                     AND table_type='BASE TABLE'")"
MIGRATIONS="$(psql_e2e "SELECT count(*) FROM schema_migrations")"
echo "    -> tables=$TABLES migrations=$MIGRATIONS"

# --------------------------------------------------------------------------- 3/7 dataset
if [ "$SKIP_GENERATE" = "1" ]; then
  step "3/8  seed generation skipped (--skip-generate)"
else
  step "3/8  generate the synthetic dataset"
  PYTHON="${PYTHON:-python}"
  ( cd "$ROOT" && "$PYTHON" data/seed/generate.py ) 2>&1 | tail -3 | sed -e 's/^/    /'
fi

step "4/8  load the seed into the fresh database"
CONTAINER="$CONTAINER" DB="$E2E_DB" USER="$PGUSER" RESEED_DEPENDENTS=1 \
  "$ROOT/data/seed/load.sh" | tail -6 | sed -e 's/^/    /'
FACTS="$(psql_e2e "SELECT count(*) FROM facts WHERE attribute='rating'")"
echo "    -> rating facts loaded: $FACTS"

# --------------------------------------------------------------------------- 5/7 boot
step "5/8  boot the platform against $E2E_DB on :$PORT"
# baseline-version has to name the migrations the infra script already ran: Flyway would otherwise
# replay V1..V4 over a schema that has them (D30/D32 are what made that failure loud instead of silent).
# Redis is switched off so this run cannot write rate-limit or session keys into the shared instance.
NEXUS_PORT="$PORT" \
NEXUS_PLATFORM_DB_URL="jdbc:postgresql://127.0.0.1:5433/$E2E_DB" \
NEXUS_MIGRATION_DB_URL="jdbc:postgresql://127.0.0.1:5433/$E2E_DB" \
NEXUS_FLYWAY_BASELINE_VERSION="$MIGRATIONS" \
NEXUS_REDIS_ENABLED=false \
NEXUS_DEV_LOG="$LOG.app" NEXUS_DEV_PID="$LOG.pid" \
  "$SCRIPT_DIR/run_platform_dev.sh" --log >> "$LOG" 2>&1
RUN_PID="$(cat "$LOG.pid")"

printf '    waiting for /api/v1/health on :%s ' "$PORT"
UP=0
# `|| true` on the listener probe is not decoration: `set -e` makes a failed command substitution abort
# the assignment, and the probe is *expected* to find nothing on the first iterations — which is the
# normal case, not an error. Without it the wait loop exits before the service ever gets to boot.
for _ in $(seq 1 90); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1; then UP=1; break; fi
  LISTEN_PID="$( { netstat -ano 2>/dev/null | grep -aE "TCP +[0-9.]+:$PORT +.*LISTENING" || true; } \
    | awk '{print $NF}' | head -1)"
  printf '.'
  sleep 2
done
echo
[ "$UP" = "1" ] || { tail -40 "$LOG.app" 2>/dev/null | sed -e 's/^/    | /'
  die "service did not come up on :$PORT (logs kept: $LOG, $LOG.app)"; }
LISTEN_PID="$( { netstat -ano 2>/dev/null | grep -aE "TCP +[0-9.]+:$PORT +.*LISTENING" || true; } \
  | awk '{print $NF}' | head -1)"
echo "    -> serving on :$PORT (maven pid $RUN_PID, listener pid ${LISTEN_PID:-unknown})"

# --------------------------------------------------------------------------- the proof needs a target
# Assert the process we are about to grade is reading the database we just built. `.env` sets
# NEXUS_PLATFORM_DB_URL, and a launcher that sources it after the caller's exports silently re-points a
# "throwaway" run at the live database — which the first run of this script did, and then reported 1,727
# seeded rating facts as zero. The launcher now prints what it kept; this fails if that line is wrong,
# because a PASS against the wrong database is worse than no measurement at all.
if ! grep -aq "NEXUS_PLATFORM_DB_URL=jdbc:postgresql://127.0.0.1:5433/$E2E_DB" "$LOG"; then
  grep -a "caller overrides\|platform: http" "$LOG" | sed -e 's/^/    | /' || true
  grep -a "HikariPool\|jdbc:postgresql" "$LOG.app" 2>/dev/null | head -3 | sed -e 's/^/    app| /' || true
  die "the service is not reading $E2E_DB — refusing to probe another database"
fi
echo "    -> datasource confirmed: the launcher kept our URL over .env"
# ...and the process answering is the one this run started, not a neighbour that bound the port first.
[ -n "$LISTEN_PID" ] || die "no listener on :$PORT to attribute the responses to"
if ! tasklist //FI "PID eq $LISTEN_PID" //FO CSV 2>/dev/null | grep -qi java; then
  die "the listener on :$PORT (pid $LISTEN_PID) is not a java process this run started"
fi

# --------------------------------------------------------------------------- 6/7 probes
step "6/8  probe the served consumer reads"
node "$SCRIPT_DIR/verify_served_reads.mjs" --base "http://127.0.0.1:$PORT" --tenant "${NEXUS_TENANT:-hong-kong}"
echo

# --------------------------------------------------------------------------- 7/7 the write leg
if [ "$READS_ONLY" = "1" ]; then
  step "7/8  skipped (--reads-only): no rows written"
else
  step "7/8  walk the three write paths against $E2E_DB"
  # The reason these run here rather than against :8090: all three leave rows behind. A state machine is best
  # proved on a database that can be thrown away with the run that proved it, not on the demo data another
  # session is looking at.
  NEXUS_PLATFORM_URL="http://127.0.0.1:$PORT" NEXUS_TENANT="${NEXUS_TENANT:-hong-kong}" \
    "${PYTHON:-python}" "$SCRIPT_DIR/verify_reservation.py" 2>&1 | tail -40 | sed -e 's/^/    /'
  # The review lifecycle: write it, queue it, publish it — and check that the number a card prints moved
  # together with the fact that cites it. A separate walk because the invariant is different: this one is
  # about two representations of one claim staying equal, which is the failure mode D35/D38/D37 each
  # described and none of them could observe on its own.
  NEXUS_PLATFORM_URL="http://127.0.0.1:$PORT" NEXUS_TENANT="${NEXUS_TENANT:-hong-kong}" \
    "${PYTHON:-python}" "$SCRIPT_DIR/verify_review_flow.py" 2>&1 | tail -30 | sed -e 's/^/    /'
  # The workspace: sign in as the merchant the seed actually hands a visitor, open §5's doors, issue a key and
  # use it. A third walk because its failure mode is neither of the above — it is the dataset and the code
  # disagreeing about who can act (D40 found routes no seeded grant could reach), and only an HTTP call from
  # that account's own token can tell a reachable permission from a row that merely looks right.
  NEXUS_PLATFORM_URL="http://127.0.0.1:$PORT" NEXUS_TENANT="${NEXUS_TENANT:-hong-kong}" \
    "${PYTHON:-python}" "$SCRIPT_DIR/verify_workspace_flow.py" 2>&1 | tail -30 | sed -e 's/^/    /'
fi
echo

# --------------------------------------------------------------------------- 8/8 the contract itself
step "8/8  reconcile docs/API_CONTRACT.md against what this build declares"
# Same instance, same build, one question the other two ledgers cannot answer: does the document describe
# the router? `/v3/api-docs` is generated from the annotations that registered, so a documented §4/§8 read
# that is absent here is a page a consumer can be sent to with nothing behind it — and that fails the run.
node "$SCRIPT_DIR/verify_contract_runtime.mjs" --base "http://127.0.0.1:$PORT" | sed -e 's/^/    /'
echo
echo "RESULT: PASS — seeded rows, served payloads, the reservation, review and workspace walks, and the contract agree on :$PORT"
