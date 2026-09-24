#!/usr/bin/env bash
# NEXUS — falsification harness for the seed loader's truncate step (docs/DECISIONS.md D63).
#
# WHY THIS EXISTS. `out/00_truncate.sql` clears the tables generate.py names *plus* whatever the live
# schema hangs off them by a foreign key while it holds no rows. That is two claims, and a run that
# only ever succeeds proves neither:
#
#   * an EMPTY stranger has to be cleared, or V7's `share_links` keeps blocking every fresh-database
#     gate with `cannot truncate a table referenced in a foreign key constraint` — a table holding no
#     rows, destroying nothing, stopping a reset. That was the failure this change answers;
#   * a stranger WITH rows has to stop the load by name, or the same mechanism has become
#     `TRUNCATE ... CASCADE` wearing a generator's clothes: it would empty tables nobody listed.
#
# So this script builds a throwaway database, loads the real seed into it, plants one child table of
# each kind, and puts both questions to the same script an operator runs. The refusal is checked for
# leaving the dataset alone, which is the property `--single-transaction` is there to buy.
#
# Usage:
#   scripts/seed_truncate_probe.sh            # build, prove, drop the database
#   scripts/seed_truncate_probe.sh --keep     # leave it for inspection after a failure
#
# Environment: NEXUS_PG_CONTAINER=<name> picks the Postgres container; otherwise the same two names
# db_gate_fresh.sh considers. The live databases (nexus, nexus_test) are never opened — the database
# name is created here and dropped on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

die() { printf 'seed_truncate_probe.sh: ERROR: %s\n' "$*" >&2; exit 2; }
step() { printf '\n=== %s\n' "$*"; }

CANDIDATES="${NEXUS_PG_CONTAINER:-} nexus-platform-postgres nexus-platform-testpg"
CONTAINER=""
for c in $CANDIDATES; do
  [ -n "$c" ] || continue
  if docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -qx true; then CONTAINER="$c"; break; fi
done
[ -n "$CONTAINER" ] || die "no running Postgres container among: $CANDIDATES"

PGUSER="${NEXUS_DB_SUPERUSER:-postgres}"
PROBE_DB="${PROBE_DB_PREFIX:-nexus_probe}_$$_$(date +%s)"
case "$PROBE_DB" in
  nexus|nexus_test|nexus_dev|postgres) die "refusing to use '$PROBE_DB' as a throwaway name" ;;
esac

psql_maint() { printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d postgres; }
psql_probe() { printf '%s\n' "$1" | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA -U "$PGUSER" -d "$PROBE_DB"; }
count()      { psql_probe "select count(*) from $1"; }

cleanup() {
  rc=$?
  if [ "$KEEP" = "1" ]; then
    [ "$rc" = "0" ] || echo "!! failed; leaving $PROBE_DB in place for inspection" >&2
    echo "probe database kept: docker exec -it $CONTAINER psql -U $PGUSER -d $PROBE_DB"
    return
  fi
  if [ -n "${PROBE_DB:-}" ]; then
    psql_maint "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PROBE_DB'" >/dev/null 2>&1 || true
    psql_maint "DROP DATABASE IF EXISTS \"$PROBE_DB\"" >/dev/null 2>&1 || echo "!! could not drop $PROBE_DB" >&2
  fi
  return "$rc"
}
trap cleanup EXIT

echo "seed_truncate_probe.sh  container=$CONTAINER db=$PROBE_DB"
echo "                       SYNTHETIC DEMO DATA — the rows describe invented businesses."

# --------------------------------------------------------------------------- 1. schema + real seed
step "1/4  migrate and load the real seed into $PROBE_DB"
psql_maint "CREATE DATABASE \"$PROBE_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_NAME="$PROBE_DB" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" | tail -2 | sed -e 's/^/    /'
CONTAINER="$CONTAINER" DB="$PROBE_DB" USER="$PGUSER" RESEED_DEPENDENTS=1 SKIP_GENERATE=1 \
  "$ROOT/data/seed/load.sh" | tail -3 | sed -e 's/^/    /'
MERCHANTS="$(count merchants)"
[ "${MERCHANTS:-0}" != "0" ] || die "the seed did not land; the probe would prove nothing"

# --------------------------------------------------------------------------- 2. plant the two shapes
step "2/4  plant one empty child of merchants and one that holds a row"
psql_probe "
CREATE TABLE probe_empty_child (id int PRIMARY KEY, merchant_id uuid REFERENCES merchants(id));
CREATE TABLE probe_row_child   (id int PRIMARY KEY, merchant_id uuid REFERENCES merchants(id));
INSERT INTO probe_row_child SELECT 1, id FROM merchants LIMIT 1;
SELECT count(*) FROM probe_row_child;" | grep -qx "1" || die "the planted row is not there — the probe is not testing what it claims"

# --------------------------------------------------------------------------- 3. the rows case refuses
step "3/4  the truncate must REFUSE while a table outside generate.py's list holds rows"
TRUNCATE_SQL="$ROOT/data/seed/out/00_truncate.sql"
[ -f "$TRUNCATE_SQL" ] || die "no $TRUNCATE_SQL — run: python data/seed/generate.py"
refused=0
REFUSE_OUT="$(mktemp "${TMPDIR:-/tmp}/nexus-probe-refuse.XXXXXX")"
if printf '%s\n' "$(sed 's/\r$//' "$TRUNCATE_SQL")" \
     | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 --single-transaction -q -U "$PGUSER" \
       -d "$PROBE_DB" > "$REFUSE_OUT" 2>&1; then
  refused=0
else
  refused=1
fi
trap 'rm -f "$REFUSE_OUT"; cleanup' EXIT
cat "$REFUSE_OUT" | sed -e 's/^/    /'
[ "$refused" = "1" ] || die "the truncate SUCCEEDED with rows in probe_row_child — it cleared a table nobody listed"
grep -q "probe_row_child (1 row(s) written elsewhere)" "$REFUSE_OUT" \
  || die "refused, but not by name and count: the message has to say which table and how many rows"
grep -q "RESEED_DEPENDENTS=1" "$REFUSE_OUT" \
  || die "refused, but without the hint that names the operator's way out"
[ "$(count merchants)" = "$MERCHANTS" ] || die "a refused truncate still cleared the demo data"
[ "$(count probe_row_child)" = "1" ] || die "a refused truncate still cleared the planted row"
echo "    -> refused by name, and the database it refused is the database it found"

# --------------------------------------------------------------------------- 4. the empty case clears
step "4/4  with the planted rows gone, the same script must clear both strangers"
psql_probe "DELETE FROM probe_row_child;" >/dev/null
CLEAR_OUT="$(mktemp "${TMPDIR:-/tmp}/nexus-probe-clear.XXXXXX")"
trap 'rm -f "$CLEAR_OUT"; cleanup' EXIT
printf '%s\n' "$(sed 's/\r$//' "$TRUNCATE_SQL")" \
  | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 --single-transaction -q -U "$PGUSER" \
    -d "$PROBE_DB" > "$CLEAR_OUT" 2>&1 || { cat "$CLEAR_OUT" | sed -e 's/^/    /'; die "the empty-stranger case did not clear"; }
grep -E "seed truncate" "$CLEAR_OUT" | sed -e 's/^/    /'
[ "$(count merchants)" = "0" ] || die "the truncate did not clear the demo data"
[ "$(count probe_empty_child)" = "0" ] || die "the empty stranger was not cleared — share_links would still block the gate"
# V7's table is the shape that broke every fresh gate; it is only asserted where V7 is present, so the
# probe still runs against a checkout that has not received it.
if [ "$(psql_probe "select coalesce(to_regclass('public.share_links')::text, '')")" != "" ]; then
  [ "$(count share_links)" = "0" ] || die "V7's table was not cleared; the shape that broke the gates is still in place"
  echo "    -> share_links (V7) is in the closure: the fresh-database gates load again"
else
  echo "    -> share_links absent from this checkout; the planted empty child stands in for it"
fi
printf '\nRESULT: PASS — the empty child is cleared, the child with rows refuses by name, and the refusal costs nothing\n'
