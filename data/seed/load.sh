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
#   RESEED_DEPENDENTS=1 data/seed/load.sh  # also empty the 28 V1 tables that FK into the
#                                          # demo tables (orders/carts/conversations/...).
#                                          # Needed when the platform already wrote rows
#                                          # referencing the demo merchants. Destructive.
#   SKIP_GENERATE=1 data/seed/load.sh     # load the files as they are on disk
#   ONLY=09_locations,12_offerings data/seed/load.sh   # partial reload, FK order preserved
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
ONLY="${ONLY:-}"

log() { printf '%s\n' "$*"; }
die() { printf 'load.sh: ERROR: %s\n' "$*" >&2; exit 2; }

[ -d "$OUT" ] || die "no such directory $OUT — run: python $HERE/generate.py --out $OUT"

# --------------------------------------------------------------------------- preflight
if [ "${SKIP_GENERATE:-0}" != "1" ] && [ ! -f "$OUT/21_collections.sql" ]; then
  die "$OUT looks incomplete (no 21_collections.sql). Run generate.py first."
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

docker exec -i "$CONTAINER" "$PSQL" -U "$USER" -d "$DB" \
  -v ON_ERROR_STOP=1 --single-transaction -q < "$stream"

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

