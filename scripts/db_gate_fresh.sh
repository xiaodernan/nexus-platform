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
#   LEDGER_SECTIONS_DIR  step 10 only: compare HEAD's ledgers against this checkout instead of this one
#                        (inert when unset; the reachability arm, not a way to skip the check)
#   NEXUS_FALSIFIERS     step 11 only: validate this registry copy instead of data/seed/falsifiers.tsv
#                        (inert when unset; the same kind of reachability arm)
#   GATE_LEDGER_TEXT     step 8 only: census this file instead of both ledgers (inert when unset; the fifth
#                        instance of the same arm, and step 8's harness re-asks it on every run — see step 8)
#   GATE_COMMENT_PLANE   step 9 only: read comments out of this directory instead of the repository
#                        (inert when unset; both are the same reachability arm, see steps 8-9)
#   GATE_STATUS_DIR      step 12 only: scan this directory for spelled §-citations instead of the repository
#                        (inert when unset; the third instance of the same arm, see step 12)
#   GATE_QUALITY_SQL     step 7 only: run its read census over this copy of data/seed/quality.sql instead of
#                        the tracked one (inert when unset; the fourth instance, see step 7 — and it moves only
#                        the census reader, never the loader that seeded the database)
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
    -h|--help)       # Print the whole header block rather than a hand-counted line range: the header grew by
                     # three knob paragraphs after the range was written (D152, D156) and `--help` stopped
                     # naming GATE_COMMENT_PLANE, GATE_STATUS_DIR and GATE_QUALITY_SQL while the script still
                     # honoured all three (D157). An undocumented arm is an arm nobody drives.
                     awk 'NR>1 { if ($0 ~ /^$/) { print ""; next } if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
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
step "1/12  create $GATE_DB from template0 (empty, no inherited objects)"
psql_maint "CREATE DATABASE \"$GATE_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
[ "$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'pg_%'")" = "0" ] \
  || die "the fresh database is not empty — template1 pollution would make this gate meaningless"

# --------------------------------------------------------------------------- 2. migrations + roles
step "2/12  apply infra/db/migrations/V*.sql + 00_roles.sql"
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_NAME="$GATE_DB" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" | sed -e 's/^/    /'
TABLES="$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")" \
  || die "cannot read the gate schema"
SCHEMA_VERSION="$(psql_gate "SELECT count(*) FROM schema_migrations")" || die "no schema_migrations in the gate database"
echo "    -> gate database now has tables=$TABLES migrations=$SCHEMA_VERSION"

# --------------------------------------------------------------------------- 3. generate the dataset
if [ "$SKIP_GENERATE" = "1" ]; then
  step "3/12  seed generation skipped (--skip-generate): loading data/seed/out/ as found"
else
  step "3/12  generate the synthetic dataset from the CSVs (generate.py self-checks FK integrity)"
  PYTHON="${PYTHON:-python}"
  ( cd "$ROOT" && "$PYTHON" data/seed/generate.py ) 2>&1 | tail -4 | sed -e 's/^/    /'
fi

# --------------------------------------------------------------------------- 4. load
step "4/12  load the seed into the fresh database"
# RESEED_DEPENDENTS=1 states the blast radius rather than discovering it. The truncate script now
# closes itself over the live foreign keys (D63), so it would clear these 27 tables on a fresh
# database anyway — they are empty there. The gate names them because a from-scratch proof should not
# depend on nothing having been written yet.
# SEED_ANCHOR=1 records the three anchors step 5 reads instead of the host clock: the window this load runs
# inside (nexus.seed_started / nexus.seed_finished, from the server's clock) and the instant the dataset calls
# "now" (nexus.seed_base, carried in from generate.py). Without them the generation-clock row asks whether a
# timestamp is near the reading instant — and D88 measured two official runs of one unchanged seed file, red
# in the morning and green 25 minutes later, separated by nothing but how long this host took to get here —
# while the fact-TTL and slot-horizon rows ask the same question of now() and current_date, which is how a
# gate ends up carrying a date it never wrote down: the horizon row reddened on 2026-09-30 with the tree
# unchanged, and the TTL arm had been unable to fail for days before that. See D89 and D90.
# Only this database is stamped: the gate owns it and drops it, and the live demo database's settings are not
# this script's to change.
CONTAINER="$CONTAINER" DB="$GATE_DB" USER="$PGUSER" RESEED_DEPENDENTS=1 SEED_ANCHOR=1 \
  "$ROOT/data/seed/load.sh" | tail -12 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 5. gate
step "5/12  data/seed/quality.sql (the hard gate)"
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
  # D139: a gate that dies at step 5 used to report no numbers at all, which is how "214 assertions at
  # HEAD" became a figure quoted from a ledger entry instead of one read from a run. The success path
  # already prints its count; the failure path now prints the same census it was reading, plus the two
  # planes it was built on, before the tail.
  CHECKS="$(grep -ac '^  PASS' "$GATE_OUT" || true)"
  REDS="$(grep -ac '^  FAIL' "$GATE_OUT" || true)"
  printf '\nRESULT: FAIL — step 5 filed %s assertion(s), %s red (tables=%s, migrations=%s).\n' \
    "${CHECKS:-?}" "${REDS:-?}" "$TABLES" "$SCHEMA_VERSION" >&2
  printf 'Last lines of the gate:\n' >&2
  tail -25 "$GATE_OUT" >&2 || true
  exit 1
fi

# --------------------------------------------------------------------------- 6. the truncate's two branches
step "6/12  scripts/seed_truncate_probe.sh — an empty stranger is cleared, one holding rows refuses"
# The probe builds its own throwaway database, so the gate's loaded dataset stays the way step 4 left
# it. Running it here is the point: a truncate that only ever succeeds proves nothing, and the branch
# that protects somebody else's rows is the branch nobody waits to see.
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/seed_truncate_probe.sh" 2>&1 | tail -8 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 7. the read census and the source
step "7/12  scripts/check_jsonb_reads.mjs — the build's jsonb reads and both answers' site citations"
# Step 5's read list is a transcription of source text, and a transcription drifts silently: the D84 list named
# reads the build does not make and missed the ones made through a Java map accessor, which D85's scanner then
# counted. So the scanner runs as a reader rather than as a note, and since D87 it reads the `site` column of
# both answer tables too — every `File.java:NNN` is opened and compared with what the row claims. node missing
# is a FAIL, not a skip — see the script's own LIMITS.
command -v node >/dev/null 2>&1 || die "steps 7-12 need node on PATH; a skipped census step is not a passed one"
# D156: the seam this script now forwards (`GATE_QUALITY_SQL`) existed for four days as a note in the checker's
# own header — "Nothing in the gate itself passes the flag" — which was true, and meant the step's redness could
# only ever be shown by hand-running an invocation nobody else makes. Two things changed. The checker learned to
# read `--quality <path>` as well as `--quality=<path>`, because the equals-only parse silently ignored the
# other spelling and censused the tracked file while the operator believed they were scoring a plant (D154's
# defect, in its third reader); and `scripts/falsify_quality_seam.mjs` — 8 arms, no database needed, ~8 seconds
# — runs here so every drive re-asks whether the site census is reachable, rather than leaving that as a claim
# in a comment. The arms are counted, because a census that found nothing did not check anything.
( cd "$ROOT" && node scripts/falsify_quality_seam.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_jsonb_reads.mjs ${GATE_QUALITY_SQL:+--quality="$GATE_QUALITY_SQL"} ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 8. the ledger's own citations
step "8/12  scripts/check_ledger_citations.mjs — every File.java:NNN the ledgers claim, opened and read back"
# D87's site census stopped at the seed directory: it checked what the answer tables assert and left the prose
# above them unverified, while §84 had already shipped a hand count of "71 prose citations, all resolved" that
# nobody had ever measured. This step reads docs/DECISIONS.md and docs/STATUS.md and resolves every citation
# the same way step 7 resolves a `site` column. It runs with --worktree rather than the script's default HEAD
# for one reason: the other nine steps all read the working tree, so a step 8 pinned to HEAD would let a green
# run certify a ledger that this tree no longer holds. The cost is stated in the checker's own LIMITS — a
# citation in another lane's uncommitted paragraph can redden this run; the message names the file and line so
# the claim goes to its owner rather than being edited here.
#
# D152: `GATE_LEDGER_TEXT` aims the step at one file instead of the two ledgers, which is the arm that shows
# step 8 can stop the run from inside the gate — the same reason step 10 has LEDGER_SECTIONS_DIR and step 11
# has NEXUS_FALSIFIERS (D98's shape: prove a guard reachable without editing a tracked file mid-run). The
# checker already read the flag; what it never had was a path from the gate to it, so the only way to witness
# a red here was to run the checker by hand, which is a claim about a different invocation.
#
# D157: that paragraph claimed the seam without measuring it, and the measurement found the same hole D156
# found one step earlier — the checker parsed only `--text=`, so a space-separated `--text <path>` was not an
# error, it was a census of the two real ledgers that believed it had been aimed at a plant: 1 section and
# `FALSE LEDGER CITATIONS (1)` from the equals spelling, 297 sections, 377 citation-shaped tokens and exit 0
# from the space spelling of the same file. Step 8 passes the equals form, so the gate was never broken; what
# was unprovable was that this step can stop the gate at all. `scripts/falsify_ledger_text.mjs` now shows it in
# both directions on Temp fixtures (the plant reddens, an unknown flag and an unaimable `--text` refuse with
# exit 2 rather than silently censusing the ledgers), and it checks the two things that let the defect hide:
# that both spellings print the same verdict, and that `--help` still names every knob the header documents —
# the old `sed -n '2,26p'` stopped short of the three most recent ones, so an arm added after line 26 was
# reachable by environment but undiscoverable by reading.
( cd "$ROOT" && node scripts/falsify_ledger_text.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_ledger_citations.mjs --worktree ${GATE_LEDGER_TEXT:+--text="$GATE_LEDGER_TEXT"} ) 2>&1 | sed -e 's/^/    /'


# --------------------------------------------------------------------------- 9. the comment plane
step "9/12  scripts/check_comment_citations.mjs — the citations that live inside source comments"
# Step 8 reads docs/. Source comments make the same kind of claim — quality.sql's notes cite lines of
# load.sh, the two scanners cite Java sites — and nothing read that plane until D93 measured it: 68
# citation-shaped tokens, 5 offenders, every offender an example of the grammar written inside the sentence
# explaining the grammar. D94 retired those under the placeholder convention, so this step is what stops the
# plane drifting back: it slices step 8's token grammar out of the checker instead of copying it, scores the
# comments through that same resolver, and refuses to treat a scan that found nothing as green.
# D152: `GATE_COMMENT_PLANE` points that scan at another directory, which is what makes the refusal reachable
# from the gate — an empty plane is the case the guard exists for, and reaching it by editing shipped bytes
# mid-run is not a way to test a gate that runs nine steps against those same bytes.
( cd "$ROOT" && node scripts/check_comment_citations.mjs ${GATE_COMMENT_PLANE:+--plane="$GATE_COMMENT_PLANE"} ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 10. the two planes of one ledger
step "10/12 scripts/check_ledger_sections.mjs — every numbered section at HEAD is still in the file on disk"
# Steps 1-9 all read one plane: step 8 reads the working tree on purpose. This step's subject IS the relation
# between the two planes, so pinning it to either would make it vacuous — it compares `git show HEAD:docs/...`
# with the file as it stands. It exists because D114 found nine sections of this ledger that no commit had
# ever held, stranded there by the lane that wrote §109-§114 staging from HEAD, and because §86 (e) had
# named that exact cost three days earlier with nothing executing on it. A heading present at HEAD and absent
# on disk is the failure (the next `git add` deletes committed history); a heading only on disk is printed
# and allowed, because writing an entry starts there. LEDGER_SECTIONS_DIR points the comparison at another
# checkout: inert on a normal run, and the arm that shows this step can redden inside the gate without
# editing a tracked file while nine other steps are reading it (D98's shape).
( cd "$ROOT" && node scripts/check_ledger_sections.mjs ${LEDGER_SECTIONS_DIR:+--dir "$LEDGER_SECTIONS_DIR"} ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 11. the record of shown redness
step "11/12 scripts/check_falsifier_registry.mjs — every falsifier row names a live assertion and an openable witness"
# D103 wrote this file as the record of which assertions have been SHOWN able to fail, and D113 tightened what
# a witness may be — but nothing executed the checker. A record validated only when someone remembers to pass
# --db is a claim with a script next to it, so the validation goes where the precondition already exists:
# this script has a loaded database for steps 5-10 and drops it on exit. `NEXUS_FALSIFIERS` points the step at
# another registry copy, which is how the step is shown red without editing the shipped file mid-run (the same
# reachability move step 10 makes with LEDGER_SECTIONS_DIR).
#
# D150: the text plane's arms are only as good as the rule that their anchor matches exactly one sentence of
# this file, and until `--self-test` existed that rule had never been asked to refuse anything. It needs no
# database, so it runs first inside this step: a drifted or doubly-matching anchor reddens the gate here rather
# than turning a later drive's red into a red about the wrong row.
( cd "$ROOT" && "${PYTHON:-python}" data/seed/falsifier_plants.py --self-test ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_falsifier_registry.mjs --db "$GATE_DB" --container "$CONTAINER" \
  ${NEXUS_FALSIFIERS:+--registry "$NEXUS_FALSIFIERS"} ) 2>&1 | sed -e 's/^/    /'
# ------------------------------------------------------------------------ 12. the spelled §-citations
step "12/12 scripts/check_status_citations.mjs — every STATUS §NN written outside a code span names a heading"
# §126 shipped this checker unwired and said why: its first run on the real tree was red with two offenders in
# another lane's committed files, and "a step nobody can make green teaches running the gate with the step
# skipped". The condition was the two offenders, not the wiring; §149 repointed them to §121 and the checker has
# been green since, so the step goes in. This is a plane steps 8 and 9 do not cover: a ledger citation written as
# prose (`STATUS §106`) rather than as `File.java:NNN` is resolved against a heading, and a renumber that moves
# the heading reds it while every file:line citation in the same sentence still resolves. It reads HEAD, matching
# §126's grammar ("must be a `## N. ` heading at HEAD"). `scripts/falsify_status_citations.mjs` is the arm that
# shows this step can fail — 6 of 6 held at D117 — so the wiring is proved rather than assumed.
#
# D154: that falsifier ran the checker as its own subprocess, which proves the reader reddens but not that THIS
# step stops the run — the same gap D152 closed for steps 8 and 9 and D150/D151 for step 11. `GATE_STATUS_DIR`
# is the in-gate seam: aimed at a directory holding one planted `STATUS §NNN`, it makes step 12 exit 1 and the
# gate print no RESULT: PASS line. The flag reached the checker as `--dir=<path>`, a spelling
# `check_status_citations.mjs` did not parse and did not complain about: it scanned the repository, printed
# "568 candidates under D:\获客平台" and called that a PASS. Both spellings are parsed now and an unrecognised
# flag is a NOT CHECKED refusal, which is what made this arm honest to run rather than merely runnable.
( cd "$ROOT" && node scripts/check_status_citations.mjs ${GATE_STATUS_DIR:+--dir="$GATE_STATUS_DIR"} ) 2>&1 | sed -e 's/^/    /'

printf '\nRESULT: PASS — %s quality checks on a from-scratch schema (tables=%s, migrations=%s), plus the\n' \
  "${CHECKS:-?}" "$TABLES" "$SCHEMA_VERSION"
printf '        seed truncate shown clearing an empty stranger and refusing one that holds rows, the\n'
printf '        build'"'"'s jsonb reads and answered sites reconciled against that list of keys, and the\n'
printf '        ledgers'"'"' own source citations resolved against the files they name.\n'
printf '        the citations inside source comments, scored by that same resolver rather than by a\n'
printf '        second one: the comment plane is censused, its token count reported, an empty scan a FAIL.\n'
printf '        the ledger'"'"'s two planes compared, so a committed section cannot go missing from the tree\n'
printf '        that is about to be committed from.\n'
printf '        the falsifier registry reconciled with the assertions step 5 filed, so a row claiming a shown\n'
printf '        redness names an assertion that exists and a witness that still opens.\n'
printf '        the spelled §-citations in code and docs resolved against the headings that exist at HEAD,\n'
printf '        so a renumber that leaves a pointer behind reddens the gate instead of a manual run.\n'
printf '        the read census'"'"'s own seam shown able to stop this script, so the step that reads the seed\n'
printf '        answers is reachable from a drive and not only from a hand-run of an invocation nobody makes.\n'
printf '        SYNTHETIC DEMO DATA. The live databases were not opened by this run.\n'
