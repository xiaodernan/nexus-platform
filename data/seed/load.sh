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
#                                         # (nexus.seed_started / nexus.seed_finished, epoch seconds) and with
#                                         # the instant the data itself calls "now" (nexus.seed_base, from
#                                         # generate.py's carrier line). Those are what quality.sql's
#                                         # generation-clock, TTL and horizon rows read instead of now() and
#                                         # current_date; see D89 and D90. Off by default because it is a write
#                                         # to the DATABASE entry, not to a table: on the throwaway gate
#                                         # database that is free, on a shared one it is somebody else's
#                                         # server setting.
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

# The instant the DATA calls "now", as the generator itself wrote it. Read here, in preflight, because the
# answer is on disk before any connection is made and a dataset whose base cannot be published should be
# refused before the loader has spent ten minutes loading it — not after, with the rows already written.
seed_base_instant=""
seed_base_read() {  # publish the instant the DATA calls "now", exactly as the generator wrote it
  # This one is not a clock reading. `nexus.seed_base` is the dataset's own claim — the instant generate.py
  # built its rows around — carried as a comment line in out/00_truncate.sql. The carrier lives inside a
  # script write_outputs() deletes before every run, so it cannot outlive the data it describes, and under
  # RESEED_DEPENDENTS=1 the line is still read from out/00_truncate.sql: that is the file the same
  # generate.py call wrote the loaded CSVs next to, whichever truncate the load then executes.
  # quality.sql's TTL and horizon rows measure against this instead of now()/current_date, which is what
  # makes them say the same thing on 2026-09-26 and on 2027-03-01 (D90).
  local v
  v=$(sed -n 's/^-- seed-base: //p' "$OUT/00_truncate.sql" 2>/dev/null | head -1)
  # The shape below is what generate.py's ts() emits — date, one space, time, offset — and it is also the
  # reason the string is safe to place inside SQL quotes: no quote, semicolon or backslash can match it.
  # Written as an alternation rather than as `{2}?`: bash's ERE took the latter as "the two digits are
  # optional", so a well-formed `+08` failed it — and the first time this check ever ran on a real gate
  # run, it refused a correct carrier line. The offset is required; its colon is not.
  local re='^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}[+-]([0-9]{2}:[0-9]{2}|[0-9]{4}|[0-9]{2})$'
  if [[ ! "$v" =~ $re ]]; then
    die "SEED_ANCHOR=1 needs a '-- seed-base: <instant>' line in $OUT/00_truncate.sql and found" \
        "'${v:-nothing}'. That line is written by data/seed/generate.py; the files on disk predate it," \
        "so regenerate them (drop SKIP_GENERATE=1) before stamping. Guessing the base from this host's" \
        "clock is the thing D90 exists to refuse."
  fi
  seed_base_instant="$v"
}

if [ "$SEED_ANCHOR" = "1" ]; then seed_base_read; fi

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

seed_base_record() {  # stamp the instant seed_base_read() validated, beside the load window
  docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 -q -c \
    "DO \$\$
     BEGIN
       EXECUTE format('ALTER DATABASE %I SET nexus.seed_base = %L', current_database(),
                      '$seed_base_instant');
       RAISE NOTICE 'load.sh  seed base = %', '$seed_base_instant';
     END
     \$\$;"
}

if [ "$SEED_ANCHOR" = "1" ]; then seed_window_record started; fi

docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" \
  -v ON_ERROR_STOP=1 --single-transaction -q < "$stream"

# The window's other bound is taken immediately after the commit, before ANALYZE and the count report: those
# open sessions of their own, and the row's claim is about the transaction that wrote the rows. The base
# instant is stamped beside them so one flag records everything quality.sql needs from outside the data.
if [ "$SEED_ANCHOR" = "1" ]; then seed_window_record finished; seed_base_record; fi

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
  log "      ...but three of its rows will refuse this database: the generation-clock, fact-TTL and slot-"
  log "      horizon rows read the anchors this loader can stamp (nexus.seed_started / nexus.seed_finished"
  log "      from the server clock, nexus.seed_base from generate.py's carrier), and SEED_ANCHOR was off."
  log "      Re-run with SEED_ANCHOR=1, or use scripts/db_gate_fresh.sh."
fi

