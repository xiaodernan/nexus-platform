#!/usr/bin/env bash
# =============================================================================
# SYNTHETIC DEMO DATA - NOT REAL BUSINESSES
# data/seed/load.sh — apply out/*.sql into a running Postgres container.
#
# Everything here is invented demo content for the NEXUS HK pilot (docs/DECISIONS.md D6,
# spec §109/§110/§155): fake brand names, reserved 2xxx-0000 phone numbers, example.hk
# domains, placeholder art. Never point this at a database holding real merchants.
#
# Usage:
#   data/seed/load.sh                     # default container/db/user (see the vars)
#   CONTAINER=nexus-seed-verify DB=nexus USER=nexus data/seed/load.sh
#   RESEED_DEPENDENTS=1 data/seed/load.sh  # also name the 27 V1 tables that FK into the
#                                          # demo tables (orders/carts/conversations/...) in the
#                                          # reset. Needed when the platform has already written rows
#                                          # into them: without this, the truncate refuses that table
#                                          # by name rather than emptying it. Destructive either way.
#   SKIP_GENERATE=1 data/seed/load.sh     # load the files as they are on disk
#   ONLY=09_locations,12_offerings data/seed/load.sh   # partial reload, FK order preserved
#   SEED_ANCHOR=1 data/seed/load.sh       # stamp this database with the window the load ran inside
#                                         # (nexus.seed_started / nexus.seed_finished, epoch seconds). It is
#                                         # what quality.sql's generation-clock row reads instead of now();
#                                         # see D89. Off by default because it is a write to the DATABASE
#                                         # entry, not to a table: on the throwaway gate database that is
#                                         # free, on a shared one it is somebody else's server setting.
#                                         # scripts/db_gate_fresh.sh turns it on for its own database.
#
# Design notes:
#   * One psql invocation, one transaction (--single-transaction), ON_ERROR_STOP=1: the seed
#     is all-or-nothing, so a failed load leaves the previous dataset untouched.
#   * Files are applied in filename order (00_truncate, then 01..21 = FK-safe parent→child).
#   * The COPY data lives inline in each .sql file, so it is streamed on stdin — no files are
#     copied into the container and no server-side absolute paths are needed.
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${SEED_OUT:-$HERE/out}"

CONTAINER="${CONTAINER:-nexus-platform-postgres}"
DB="${DB:-nexus}"
USER="${USER:-${PGUSER:-postgres}}"
PSQL="${PSQL:-psql}"
RESEED_DEPENDENTS="${RESEED_DEPENDENTS:-0}"
SEED_ANCHOR="${SEED_ANCHOR:-0}"
ONLY="${ONLY:-}"

log() { printf '%s\n' "$*"; }
die() { printf 'load.sh: ERROR: %s\n' "$*" >&2; exit 2; }

[ "${SEED_ANCHOR}" != "1" ] || [ -z "$ONLY" ] \
  || die "SEED_ANCHOR=1 with ONLY= would record a load window around a partial reload: quality.sql's" \
         "generation-clock row reads that window as 'everything the seed stamped', and a partial reload" \
         "leaves columns it skipped holding their old values — outside the window, for the wrong reason."

[ -d "$OUT" ] || die "no such directory $OUT — run: python $HERE/generate.py --out $OUT"

# --------------------------------------------------------------------------- preflight
# The dataset is complete when the *last* table in load order is present — but its filename is not a
# stable way to say that. The prefix is the position, and the position moves whenever a table is added
# anywhere before it (seeding moderation_cases pushed collections from 21_ to 22_ and this check failed on
# a complete directory). Match the table, not the number.
if [ "${SKIP_GENERATE:-0}" != "1" ] && ! ls "$OUT"/*_collections.sql >/dev/null 2>&1; then
  die "$OUT looks incomplete (no *_collections.sql). Run generate.py first."
fi
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  log "load.sh: container '$CONTAINER' is not running."
  log "           start it (docker compose -f infra/docker-compose.yml up -d postgres) or set CONTAINER=<name>."
  log "           The dataset itself is still verifiable offline: python $HERE/generate.py --out $OUT"
  log "           (generate.py always re-parses the CSVs and asserts FK integrity + product rules)."
  exit 3
fi

psql_query() {  # run one SQL string on the container, print raw stdout
  docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" -Atq -c "$1"
}

# The schema must exist before any COPY can land.
tables_present=$(psql_query "select count(*) from information_schema.tables where table_schema='public' and table_name in ('merchants','offerings','reviews','availability_slots','chunks','facts')")
[ "${tables_present:-0}" = "6" ] || die "public schema incomplete ($tables_present/6 core tables). Apply infra/db/migrations/V1__init.sql (+V2) first."

# Refuse to write into a tenant that is not the demo tenant, if anything is already there.
other=$(psql_query "select count(*) from merchants where tenant_id <> '00000000-0000-0000-0000-000000000001'")
[ "${other:-0}" = "0" ] || die "$other merchants belong to a non-demo tenant; this loader only owns tenant 00000000-0000-0000-0000-000000000001."

# --------------------------------------------------------------------------- file order
files=()
if [ "$RESEED_DEPENDENTS" = "1" ]; then
  [ -f "$OUT/optional/00_truncate_dependents.sql" ] || die "out/optional/00_truncate_dependents.sql missing — regenerate first."
  files+=("$OUT/optional/00_truncate_dependents.sql")
else
  files+=("$OUT/00_truncate.sql")
fi
for f in "$OUT"/[0-9][0-9]_*.sql; do
  base="$(basename "$f")"
  # The 00_ truncate scripts are chosen explicitly just above (plain vs. dependents). Without this
  # skip the glob re-adds out/00_truncate.sql AFTER out/optional/00_truncate_dependents.sql, so
  # RESEED_DEPENDENTS=1 always died on "cannot truncate a table referenced in a foreign key
  # constraint" — the dependents list was already applied and the plain list cannot be.
  case "$base" in 00_*.sql) continue ;; esac
  if [ -n "$ONLY" ]; then
    stem="${base%.sql}"
    stem="${stem%%_*}"                      # 09_locations -> 09
    case ",$ONLY," in *",$base,"*|*",$stem,"*) ;; *) continue ;; esac
  fi
  files+=("$f")
done

log "load.sh  container=$CONTAINER db=$DB user=$USER files=${#files[@]} dependents=$RESEED_DEPENDENTS"
log "         SYNTHETIC DEMO DATA — the rows describe invented businesses, not real HK companies."

# --------------------------------------------------------------------------- load
# cat the ordered scripts into a single psql session on stdin: COPY ... FROM STDIN then
# consumes the rows that follow it in the same stream.
stream=$(mktemp "${TMPDIR:-/tmp}/nexus-seed.XXXXXX.sql")
cleanup() { rm -f "$stream"; }
trap cleanup EXIT
: > "$stream"
for f in "${files[@]}"; do cat "$f" >> "$stream"; done

seed_window_record() {  # $1 = started | finished
  case "$1" in started|finished) ;; *) die "seed_window_record: '$1' is not a bound name" ;; esac
  # `now()` is read by the SERVER, so a host/container clock disagreement cannot enter the window, and the
  # value goes out through ALTER DATABASE because a session cannot see its own new database-level setting:
  # quality.sql evaluates in the NEXT session, and that is the one which needs the window.
  docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -q -c \
    "DO \$\$
     DECLARE e bigint;
     BEGIN
       SELECT floor(extract(epoch FROM now()))::bigint INTO e;
       EXECUTE format('ALTER DATABASE %I SET nexus.seed_$1 = %L', current_database(), e);
       RAISE NOTICE 'load.sh  seed window $1 = % (epoch %)', now(), e;
     END
     \$\$;"
}

if [ "$SEED_ANCHOR" = "1" ]; then seed_window_record started; fi

docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" \
  -v ON_ERROR_STOP=1 --single-transaction -q < "$stream"

# The window's other bound is taken immediately after the commit, before ANALYZE and the count report: those
# open sessions of their own, and the row's claim is about the transaction that wrote the rows.
if [ "$SEED_ANCHOR" = "1" ]; then seed_window_record finished; fi

# --------------------------------------------------------------------------- post
# Planner stats for the geo/price/rating filters the recommendation service leans on (D3).
docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -q -c \
  "ANALYZE public.merchants, public.offerings, public.reviews, public.availability_slots,
          public.locations, public.chunks, public.facts;"

log "load.sh  done. exact row counts:"
docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" -q -c "
do \$\$
declare t text; n bigint; names text[] := array['tenants','users','user_identities','user_preferences',
  'categories','merchants','merchant_users','permission_grants','locations','business_hours',
  'merchant_categories','offerings','offering_relations','resource_pools','availability_slots',
  'reviews','documents','chunks','facts','favorites','collections','review_summaries'];
begin
  foreach t in array names loop
    execute format('select count(*) from public.%I', t) into n;
    raise notice '           %', rpad(t, 22) || lpad(n::text, 9);
  end loop;
end
\$\$;" 2>&1 | sed -e 's/^NOTICE:  *//' -e '/^$/d'

log ""
log "next: docker exec -i $CONTAINER $PSQL -U $USER -d $DB -v ON_ERROR_STOP=1 < $HERE/quality.sql"
if [ "$SEED_ANCHOR" != "1" ]; then
  log "      ...but its generation-clock row will refuse this database: the row reads the window this loader"
  log "      ran inside, and SEED_ANCHOR was off. Re-run with SEED_ANCHOR=1, or use scripts/db_gate_fresh.sh."
fi

