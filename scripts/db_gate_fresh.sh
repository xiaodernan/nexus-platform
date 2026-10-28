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
#   GATE_LEDGER_DIR      step 8 only: read the working-copy ledgers from this directory instead of this tree
#                        (inert when unset; D164's second half of the same reachability arm)
#   GATE_LEDGER_HEAD_DIR step 8 only: read the COMMITTED plane from this directory instead of `git show`
#                        (inert when unset; with GATE_LEDGER_DIR it is what makes "a section this run is
#                        writing" a state a drive can reach, which is the point of D163's seam)
#   GATE_COMMENT_PLANE   step 9 only: read comments out of this directory instead of the repository
#                        (inert when unset; both are the same reachability arm, see steps 8-9)
#   GATE_STATUS_DIR      step 12 only: scan this directory for spelled §-citations instead of the repository
#                        (inert when unset; the third instance of the same arm, see step 12)
#   GATE_QUALITY_SQL     step 7 only: run its read census over this copy of data/seed/quality.sql instead of
#                        the tracked one (inert when unset; the fourth instance, see step 7 — and it moves only
#                        the census reader, never the loader that seeded the database)
#
# WHAT THESE PLANE KNOBS DO NOT MOVE (D178). Each of them relocates the TEXT being censused — the ledgers, the
# comments, the seed file — while the reader's SOURCE INDEX stays on the directory it was started in, because
# that index is built from `process.cwd()`. So `GATE_LEDGER_DIR=/tmp/x` asks "do /tmp/x's sentences name files
# that exist HERE", which is the right question for a harness fixture and the wrong one for a clean-checkout
# certification. Step 13 therefore runs its reader legs with `cd "$WT"` and no knob, and prints both legs'
# counts for each of its three readers (D190) rather than for one.
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
step "1/18  create $GATE_DB from template0 (empty, no inherited objects)"
psql_maint "CREATE DATABASE \"$GATE_DB\" TEMPLATE template0 ENCODING 'UTF8'" >/dev/null
[ "$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'pg_%'")" = "0" ] \
  || die "the fresh database is not empty — template1 pollution would make this gate meaningless"

# --------------------------------------------------------------------------- 2. migrations + roles
step "2/18  apply infra/db/migrations/V*.sql + 00_roles.sql"
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_NAME="$GATE_DB" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/db_apply_migrations.sh" | sed -e 's/^/    /'
TABLES="$(psql_gate "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")" \
  || die "cannot read the gate schema"
SCHEMA_VERSION="$(psql_gate "SELECT count(*) FROM schema_migrations")" || die "no schema_migrations in the gate database"
echo "    -> gate database now has tables=$TABLES migrations=$SCHEMA_VERSION"

# --------------------------------------------------------------------------- 3. generate the dataset
if [ "$SKIP_GENERATE" = "1" ]; then
  step "3/18  seed generation skipped (--skip-generate): loading data/seed/out/ as found"
else
  step "3/18  generate the synthetic dataset from the CSVs (generate.py self-checks FK integrity)"
  PYTHON="${PYTHON:-python}"
  ( cd "$ROOT" && "$PYTHON" data/seed/generate.py ) 2>&1 | tail -4 | sed -e 's/^/    /'
fi
# D576. THE COPY IS A CLAIM, AND THE ROWS ARE ITS ONLY SUPPORT. The seed's four collections advertise
# what their members are -- "every member is a quiet restaurant or cafe", "every member is in Tai Wai,
# under HK$100" -- and until this unit that copy was written BY HAND beside the rows it described. STATUS
# 571 measured what that cost: a quiet-meals list whose ten members include a Tailor and a Barber and
# span seven districts, under a title that says 安靜嘅用餐位 ("quiet dining places"); and a Tai Wai list
# where ONE of the nine stops is in Tai Wai -- five are in Sha Tin and the rest in Wan Chai, Tuen Mun and
# Kwun Tong. The claim vocabulary (data/seed/claim_vocabulary.json) is now the single place that says
# what each collection asserts, the generator renders its copy from that declaration, and this reader
# parses the SHIPPED copy back out of the shipped templates and holds every claim against the SHIPPED
# rows. So this step does not merely produce a dataset: it produces a dataset whose advertising copy is
# checked against that dataset.
#
# The reader runs on whatever rows are about to be loaded -- generated just above, or found on disk under
# --skip-generate -- because step 4 loads those rows either way, and a copy that lies is loaded just as
# eagerly as a copy that tells the truth. A reader that refuses (exit 2) stops the gate too: "not checked"
# is not "nothing found", and a gate that cannot tell those apart is the defect this lane keeps closing.
( cd "$ROOT" && node scripts/check_collection_claims.mjs ) 2>&1 | sed -e 's/^/    /'
# ...and the reader's own arms, for the reason every reader's arms are here: a census is only as good as
# the arms that show it reddening. 17 arms, one generated plane, about half a minute.
( cd "$ROOT" && node scripts/falsify_collection_claims.mjs ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 4. load
step "4/18  load the seed into the fresh database"
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
step "5/18  data/seed/quality.sql (the hard gate)"
VARS=""
for v in MIN_MERCHANTS MIN_OFFERINGS MIN_REVIEWS MIN_NEAR_SHA_TIN; do
  if [ -n "${!v:-}" ]; then VARS="$VARS -v $v=${!v}"; fi
done
# shellcheck disable=SC2086  # intentional word splitting of the -v pairs
GATE_OUT="$(mktemp "${TMPDIR:-/tmp}/nexus-gate-fresh.XXXXXX")"
trap 'rm -f "$GATE_OUT" "$GATE_OUT.ledger" 2>/dev/null || true; cleanup' EXIT
if printf '%s\n' "$(sed 's/\r$//' "$ROOT/data/seed/quality.sql")" \
   | docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -qtA $VARS -U "$PGUSER" -d "$GATE_DB" > "$GATE_OUT" 2>&1; then
  CHECKS="$(grep -ac '^  PASS' "$GATE_OUT" || true)"
  printf '    -> %s quality checks passed against a from-scratch schema (tables=%s, migrations=%s)\n' \
    "${CHECKS:-?}" "$TABLES" "$SCHEMA_VERSION"
  # The count this run just measured, judged against the ledger's own newest claim about it (task #126).
  # The ledger wrote "216 assertions" 120 times and linked it to nothing, so a check added here left 120
  # sentences stale with nothing reddening; this is the thing that reddens. It reads the number from THIS
  # run rather than from a flag an operator carries across by hand, which is how 216 came to be written
  # 120 times in the first place. A MISMATCH is a FAIL, deliberately: a step that cannot fail is the thing
  # D195 called out, and a ledger that disagrees with the gate is a real defect in the ledger.
  if ! node "$ROOT/scripts/check_ledger_numbers.mjs" --expect "assertions=$CHECKS" > "$GATE_OUT.ledger" 2>&1; then
    printf '\n' >&2
    tail -6 "$GATE_OUT.ledger" | sed -e 's/^/    /' >&2
    die "step 5 filed $CHECKS assertion(s) and the ledger's newest claim disagrees — see the judgement above"
  fi
  tail -3 "$GATE_OUT.ledger" | sed -e 's/^/    /'
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
step "6/18  scripts/seed_truncate_probe.sh — an empty stranger is cleared, one holding rows refuses"
# The probe builds its own throwaway database, so the gate's loaded dataset stays the way step 4 left
# it. Running it here is the point: a truncate that only ever succeeds proves nothing, and the branch
# that protects somebody else's rows is the branch nobody waits to see.
NEXUS_PG_CONTAINER="$CONTAINER" NEXUS_DB_SUPERUSER="$PGUSER" \
  "$SCRIPT_DIR/seed_truncate_probe.sh" 2>&1 | tail -8 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 7. the read census and the source
step "7/18  scripts/check_jsonb_reads.mjs — the build's jsonb reads and both answers' site citations"
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
step "8/18  scripts/check_ledger_citations.mjs — every File.java:NNN the ledgers claim, opened and read back"
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
# The two planes are addressable only as a pair: `--worktree` reads one file and calls it strict, so a run that
# supplied `--dir`/`--head-dir` alongside it would compare nothing and judge nothing while looking configured.
# With either knob set, step 8 runs in comparison mode instead — the default line below is byte-for-byte what it
# was before D164, so an unset environment reaches the reader exactly as it always did.
if [ -n "${GATE_LEDGER_DIR:-}" ] || [ -n "${GATE_LEDGER_HEAD_DIR:-}" ]; then
  ( cd "$ROOT" && node scripts/check_ledger_citations.mjs ${GATE_LEDGER_DIR:+--dir="$GATE_LEDGER_DIR"} ${GATE_LEDGER_HEAD_DIR:+--head-dir="$GATE_LEDGER_HEAD_DIR"} ) 2>&1 | sed -e 's/^/    /'
else
  ( cd "$ROOT" && node scripts/check_ledger_citations.mjs --worktree ${GATE_LEDGER_TEXT:+--text="$GATE_LEDGER_TEXT"} ) 2>&1 | sed -e 's/^/    /'
fi


# --------------------------------------------------------------------------- 9. the comment plane
step "9/18  scripts/check_comment_citations.mjs — the citations that live inside source comments"
# Step 8 reads docs/. Source comments make the same kind of claim — quality.sql's notes cite lines of
# load.sh, the two scanners cite Java sites — and nothing read that plane until D93 measured it: 68
# citation-shaped tokens, 5 offenders, every offender an example of the grammar written inside the sentence
# explaining the grammar. D94 retired those under the placeholder convention, so this step is what stops the
# plane drifting back: it slices step 8's token grammar out of the checker instead of copying it, scores the
# comments through that same resolver, and refuses to treat a scan that found nothing as green.
# D152: `GATE_COMMENT_PLANE` points that scan at another directory, which is what makes the refusal reachable
# from the gate — an empty plane is the case the guard exists for, and reaching it by editing shipped bytes
# mid-run is not a way to test a gate that runs nine steps against those same bytes.
# D159: the knob existed for four days without a witness, which is the same gap D150/D151 closed for step 11,
# D152 for steps 8 and 9's exit codes, D156 for step 7 and D157 for step 8's reader. `scripts/falsify_comment_plane.mjs`
# is 13 arms over fixture planes in the OS temp dir, no database and a few seconds: it shows a false comment-plane
# citation reddening the step, both `--plane` spellings reaching the same plane, and — the reason this harness
# exists as much as any other — that `--plane --verbose` is now a refusal where it used to throw ENOENT and exit
# 1, this file's own code for "a citation is wrong". Its last two arms read the text below, so the seam cannot be
# unwired again without a step of the gate going red.
( cd "$ROOT" && node scripts/falsify_comment_plane.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_comment_citations.mjs ${GATE_COMMENT_PLANE:+--plane="$GATE_COMMENT_PLANE"} ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 10. the two planes of one ledger
step "10/18 scripts/check_ledger_sections.mjs — every numbered section at HEAD is still in the file on disk"
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
# The ledgers' line endings, per section: byte-targeted repairs (the fence fix, the applier's splice) work
# one section at a time, and a section mixing CRLF and LF inside itself is where those tools break. The
# census reports the whole-file split and fails on a mixed section; a uniform split is neither spelling
# judged (D359's repair worked across CRLF and LF in one sitting, which is why this step exists).
( cd "$ROOT" && node scripts/check_ledger_eols.mjs ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 11. the record of shown redness
step "11/18 scripts/check_falsifier_registry.mjs — every falsifier row names a live assertion and an openable witness"
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
step "12/18 scripts/check_status_citations.mjs — every STATUS §NN written outside a code span names a heading"
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

# --------------------------------------------------------------------------- 13. the committed plane (clean checkout)
step "13/18  scripts/check_jsonb_reads.mjs + check_ledger_citations.mjs + check_comment_citations.mjs on a detached worktree of HEAD — the committed plane that the gate's reading steps certify"
# Steps 7, 8 and 9 read the working tree by default. D173 and D174 showed that on a clean checkout of HEAD
# step 7 exits 1 with eleven false sites, step 8 exits 1 with forty-one unresolved citations, and step 9
# fails as its consequence. The gate's headline green is a property of the directory, not the commit, because
# other lanes' uncommitted work makes the working-tree green. This step creates a detached worktree of HEAD,
# runs the same three readers there, and reports the committed-plane results so the operator can compare.
# The worktree is created read-only, its output captured, and removed immediately — no branch moves and no
# tracked file in the main tree is touched.
#
# D178: THE LEGS THAT MOVED, AND WHY. The first version of this step pointed the three readers at the worktree
# with the plane knobs — `--dir`/`--head-dir` for step 8, `--plane` for step 9, `--quality` for step 7 — and
# reported a committed plane those knobs cannot certify. Each reader builds its SOURCE INDEX from its own tree
# (`check_ledger_citations.mjs:58` is `process.cwd()`, `check_comment_citations.mjs:53` is the script's
# location, and step 9's child inherits that cwd), so the knobs moved the LEDGERS into the worktree while the
# files the ledgers cite were still indexed out of this directory, including the untracked ones. Measured on
# the same commit both ways: from the main tree with the knobs, 77 distinct files cited and 0 offenders; inside
# the worktree with no knob, 65 cited and 41 `FILE NOT FOUND`. So step 13's reader legs now `cd "$WT"` and run
# bare — the same invocation an operator would type after a clean checkout — and 13b prints both counts so the
# difference is visible instead of being a claim in a comment. The harness legs stay at `$ROOT`: they witness
# a reader's arms, and their fixtures cite real repository files on purpose, which is the very behaviour the
# knobs exist to allow (D163's seam). The knobs themselves are still forwarded by steps 7-8 for a drive.
# 13b's harness leg lost its `GATE_LEDGER_DIR`/`GATE_LEDGER_HEAD_DIR` prefix in the same pass: the harness reads
# no environment variable (its only mention of those names is a grep of this file, in its wiring arms), so the
# prefix was a label claiming a plane the arms never read. Measured 2026-09-28 with and without it: the same
# 28 held / 1 missed, and the miss is the working copy's own — an uncommitted STATUS section in another lane's
# paragraph cites a line of the seo controller that is empty. The default-mode arm judges the blank class in a
# section this tree is writing, which is D162's rule working, and the row's owner is the only lane that can
# move it. Step 13 does not fail the gate, so this prints there rather than stopping it.
#
# This step reports the committed plane but does NOT fail the gate — the committed plane's redness is
# caused by other lanes' uncommitted work; the fix belongs to those lanes. The gate's RESULT: PASS still
# requires the working-tree plane to be green (steps 7-12).
command -v git >/dev/null 2>&1 || die "step 13 needs git on PATH"
WT="$(mktemp -d "${TMPDIR:-/tmp}/nexus-gate-wt.XXXXXX")"
git worktree add --detach "$WT" HEAD 2>&1 | sed -e 's/^/    /'
trap 'git worktree remove "$WT" 2>/dev/null || true; cleanup' EXIT
# D190: THE RECONCILIATION IS ARITHMETIC, NOT A SENTENCE. 13b printed two counts and 13a/13c printed only the
# bare leg, so "the knob relocates the text and not the source index" was one step's measurement generalised to
# three steps by the same comment. All three legs now run their reader twice — from this directory with that
# step's own knob aimed at the worktree, and from inside the worktree with no knob — and one `reconcile` line
# prints what both runs said. Every number on the line comes out of a run: `num` pulls the first number that
# reader's own census line carries, `off` its `FALSE SITES (N)` / `FILE NOT FOUND (N)` header, and a leg that
# printed neither that header nor its own clean sentence reports `no-verdict` instead of a comfortable 0,
# because a reader that crashed must not appear on this line as a clean one. `gap` subtracts the two offender
# counts, and refuses to do arithmetic on words. Measured on one commit, three pairs, same direction: 13a 12
# files / 8 false sites from the main tree against 10 / 11 from inside the worktree; 13b 77 / 0 against 65 / 41;
# 13c 21 files / 0 offenders against 21 / 10. The `reconcile` body holds no digit, which is the claim
# `scripts/falsify_ledger_text.mjs` now pins — along with the three call sites, so a leg cannot quietly stop
# running its knob pair.
FILES_READS='citations resolved[[:space:]]*[0-9]+'          # step 7's census line
FILES_LEDGER='distinct files cited[[:space:]]*[0-9]+'       # step 8's
FILES_COMMENT='citation\(s\) across[[:space:]]*[0-9]+'      # step 9's closing RESULT line
# num <ERE pattern> <text> — the first number the pattern carries, or `no-count` when the text has no such line.
num() { local n; n="$(printf '%s\n' "$2" | grep -oE "$1" | head -1 | grep -oE '[0-9]+' || true)"
  printf '%s' "${n:-no-count}"; }
# off <text> — a reader's offender count from its own header; 0 only when the reader printed the sentence it
# prints instead of a header; `no-verdict` when it printed neither.
off() { local n; n="$(num '(FALSE SITES|FILE NOT FOUND) \([0-9]+\)' "$1")"
  if [ "$n" != no-count ]; then printf '%s' "$n"; return; fi
  printf '%s\n' "$1" | grep -qE 'every cited line names|every citation-shaped token resolves|all resolving' \
    && printf '0' || printf 'no-verdict'; }
# gap <knob offenders> <worktree offenders> — the difference, or the reason there isn't one.
gap() { case "$1 $2" in *no-count*|*no-verdict*) printf 'the two legs are not comparable' ;;
    *) printf 'the source index alone moves the offender count by %s' "$(( $2 - $1 ))" ;; esac; }
# reconcile <label> <census-line pattern> <knob-leg output> <in-worktree-leg output>
reconcile() {
  printf '    plane reconciliation %s — knob leg %s file(s) cited / %s offender(s), in-worktree leg %s / %s: %s.\n' \
    "$1" "$(num "$2" "$3")" "$(off "$3")" "$(num "$2" "$4")" "$(off "$4")" \
    "$(gap "$(off "$3")" "$(off "$4")")"
}
step "13a/18  quality reads on the committed plane (cwd inside the worktree; the knob leg printed for contrast)"
# D193: this leg used to carry `GATE_QUALITY_SQL="$WT/data/seed/quality.sql"` in front of the harness — the same
# inert prefix 13b's paragraph above records removing, still standing two legs further along. Every
# `scripts/falsify_*.mjs` was grepped for `process.env`: none of them reads any variable, and this harness builds
# its fixtures from `join(ROOT, 'data/seed/quality.sql')`, this directory's file. The harness legs stay at `$ROOT`
# by design (13b), so the label is what goes; `falsify_quality_seam.mjs` now carries the arm that keeps any such
# prefix from coming back, on this leg and on the two others.
( cd "$ROOT" && node scripts/falsify_quality_seam.mjs ) 2>&1 | sed -e 's/^/    /' || true
# `--report` on both captured legs: these are measurements, and a reader that exits 1 inside a command
# substitution would take the gate down through `set -e` on an assignment rather than on a verdict.
Q7_KNOB="$( cd "$ROOT" && node scripts/check_jsonb_reads.mjs --quality="$WT/data/seed/quality.sql" --report 2>&1 || true )"
Q7_WT="$( cd "$WT" && node scripts/check_jsonb_reads.mjs --report 2>&1 || true )"
printf '%s\n' "$Q7_WT" | sed -e 's/^/    /'
reconcile 13a "$FILES_READS" "$Q7_KNOB" "$Q7_WT"
step "13b/18  ledger citations on the committed plane (cwd inside the worktree; the knob leg printed for contrast)"
( cd "$ROOT" && node scripts/falsify_ledger_text.mjs ) 2>&1 | sed -e 's/^/    /' || true
KNOB_LINE="$( cd "$ROOT" && node scripts/check_ledger_citations.mjs --dir="$WT" --head-dir="$WT" --report 2>&1 || true )"
WT_LINE="$( cd "$WT" && node scripts/check_ledger_citations.mjs --report 2>&1 || true )"
printf '%s\n' "$WT_LINE" | sed -e 's/^/    /'
reconcile 13b "$FILES_LEDGER" "$KNOB_LINE" "$WT_LINE"
step "13c/18  comment citations on the committed plane (cwd inside the worktree; the knob leg printed for contrast)"
# D193: the same inert prefix as 13a's note — `falsify_comment_plane.mjs` reads no environment variable either
# (its seam is the `--checker=<path>` flag). The arm above covers every falsifier invocation in this file.
( cd "$ROOT" && node scripts/falsify_comment_plane.mjs ) 2>&1 | sed -e 's/^/    /' || true
C9_KNOB="$( cd "$ROOT" && node scripts/check_comment_citations.mjs --plane="$WT" 2>&1 || true )"
C9_WT="$( cd "$WT" && node scripts/check_comment_citations.mjs 2>&1 || true )"
printf '%s\n' "$C9_WT" | sed -e 's/^/    /'
reconcile 13c "$FILES_COMMENT" "$C9_KNOB" "$C9_WT"
printf '    A source this directory holds and HEAD does not answers a committed sentence in the knob leg and cannot in the other; three readers, three pairs, one direction — that difference is what step 13 is for.\n'
git worktree remove "$WT" 2>&1 | sed -e 's/^/    /'
trap - EXIT
trap cleanup EXIT

# --------------------------------------------------------------------------- 14. the console, and the readers nobody ran
step "14/18  scripts/check_console_i18n.mjs + check_console_a11y.mjs + check_slot_keys.mjs + check_duplicate_keys.mjs + check_ui_script.mjs + check_reader_reachability.mjs + check_citation_supports_sentence.mjs — the console's two promises, the client plane's list members, the script the zh-HK copy is written in, and whether every reader in scripts/ is reachable from a gate that can fail"
# D195. Three things were true at once on the shipped bytes, and each one is the same shape this lane has now
# closed four times (D98, D150-D152, D191, D192) — a rule that cannot fire on the plane the gate reads is not a
# rule the gate has, and a reader nothing runs is not a gate either.
#
#   1. Two readers were named by no surface at all. `scripts/check_console_i18n.mjs` (the copy + noindex
#      promises, 31 pages / 20 console / 0 offenders) and `scripts/check_console_a11y.mjs` (landmarks,
#      accessible names, focus order, printed contrast; 13 of 13 arms held) both PASSED, and nothing ran
#      either of them: not this script, not CI, not the Makefile. `docs/PLAN.md` recorded the accessibility
#      half of P3 as "unmeasured" while the census that measures it sat in the tree.
#   2. Three CI steps carried "Hard-fail" in their own comments and could not fail. They pipe a checker into
#      `tee` for the artifact, and GitHub's documented default for a `run:` step on Linux is `bash -e {0}`
#      (workflow-syntax reference, shell table: unspecified -> `bash -e {0}`; `shell: bash` ->
#      `bash --noprofile --norc -eo pipefail {0}`). A pipeline reports its last command, so the runner read
#      tee's 0 whatever the checker said. Measured in a shell rather than argued: `false | tee /dev/null`
#      under `bash -e` exits 0, under `bash -eo pipefail` it exits 1. Every one of those steps now declares
#      `shell: bash`, and `scripts/check_reader_reachability.mjs` censuses the workflow so the next one cannot
#      be added without it.
#   3. THIS script held its own pipes together and nothing said so. `set -euo pipefail` on line 51 is what
#      makes every `node ... | sed` below it able to stop the run, and D150/D151's proof that step 11 can
#      stop the gate is a proof about that one line. The census asserts the line is still there, because a
#      pipe in a shell without it reports the last command on both planes.
#
# The three readers need no database and no browser — they read the render tree and the text of this
# repository — so they run after step 13 rather than beside it, and the same pipe discipline applies to them.
# `scripts/falsify_console_a11y.mjs` is run here for the reason every reader's arms are: the census is only
# as good as the arms that show it reddening, and 13 of 13 held before this step existed.
#
# D574. `scripts/check_slot_keys.mjs` reads the same render tree from the other end. React's missing-key
# warning fires on the CLIENT plane only, and only for an element that crossed the RSC boundary: a plain
# element created in the same pass is marked validated before the reconciler walks the array, and the server
# plane never warns at all. The reader derives the client plane from the source — the modules carrying
# 'use client' plus their transitive import closure, `export * from` re-exports included — and reports every
# multi-child slot that renders a ReactNode-typed prop bare. Measured on the running dev server before the
# reader existed: the home page's rail action, passed from a server component into the client `CardRail`,
# drew exactly one such error, naming `EntityRail` and `HomePage`; with the value in a keyed fragment the
# console carries none. Its 15 arms run here for the same reason as the console census's 13: a census is
# only as good as the arms that show it reddening.
( cd "$ROOT" && node scripts/check_console_i18n.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_console_a11y.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/falsify_console_a11y.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_slot_keys.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/falsify_slot_keys.mjs ) 2>&1 | sed -e 's/^/    /'
# D575. `scripts/check_duplicate_keys.mjs` asks the OTHER half of the same React question, and it cannot be
# asked by a source scan: React's duplicate-key warning lives only in the client reconciler, is absent from
# every `react-dom-server*.development.js` build, and `renderToStaticMarkup` emits nothing for a list whose
# members share a key. So this reader RUNS the real component and walks the element tree it returns, and the
# rule it applies -- the members of one children array must carry distinct keys -- is a property of that tree.
# The defect it was written for: a card's `id` is its IDENTITY, and an identity is not unique inside a list
# that holds that card twice. The platform keeps those repeats deliberately (`CollectionsController` resolves a
# guide's items in the author's order and adds the card each item resolved), so the seeded Sha Tin guide
# cites ten merchants over nine shops and the card list rendered the same key twice. The fix names the
# OCCURRENCE rather than the identity (`packages/ui/src/trust/cardKeys.ts`), and this reader is what keeps a
# future list from keying by identity again. Its 16 arms run here for the reason every reader's arms are: a
# census is only as good as the arms that show it reddening.
( cd "$ROOT" && node scripts/check_duplicate_keys.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/falsify_duplicate_keys.mjs ) 2>&1 | sed -e 's/^/    /'
# D606. `scripts/check_ui_script.mjs` asks the script question the console census never thought to ask: the
# web plane's ONE zh-HK dictionary was written in the Simplified script, so a Hong Kong reader was answered
# in the script of another market — `精选` beside `精選合集` inside the same object. The census derives the
# characters it charges from the AI lane's own pair tables (canonical.py, lexicon.py) instead of keeping a
# third list, admits the blocks it reads by their declaration (`const zh…: … = {`), and charges only string
# literals — so this repository's English-language discussion of Chinese is not copy it can red. Its arms
# run here for the reason every reader's arms do, and their count is the battery's own print rather than a
# number kept in this comment; the pair that carries the design is the one where a planted 话 reddens the
# carrier and the same planted 台 does not, which is what shows the exclusion list doing work.
( cd "$ROOT" && node scripts/check_ui_script.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/falsify_ui_script.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/falsify_reader_reachability.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_reader_reachability.mjs ) 2>&1 | sed -e 's/^/    /'
# The sentence-support census is a reporting invocation BY DESIGN: it exits 0 whatever it finds, because
# "the neighbourhood shares no identifier" is a question, not a defect (its header says so in full). It
# runs here for the rule that moved the two console readers in D195 — a reader nothing runs is a
# measurement, not a gate — and the reachability census above is the check that keeps it here.
( cd "$ROOT" && node scripts/check_citation_supports_sentence.mjs ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 15. the ledger's line-number drift
step "15/18  scripts/check_line_cite_drift.mjs — the ledger's line-number citations asked whether the line they name still holds the text it was chosen for"
# check_ledger_citations.mjs (D88) asks four questions of a File.ext:NNN cite and none of them is about whether
# the cited line still holds the text it was chosen for. STATUS §203 named a line that was wrong twice over —
# two lines at the commit that wrote it, nineteen after a later one — and passed every reader on both planes,
# because the strict census exempts a committed section and a stale number is neither past EOF nor blank.
# This reader walks every File.ext:NNN citation in the ledgers, blames the citing line to the commit that
# wrote it, reads the cited file at THAT commit and at HEAD, and compares the text of line NN. It reports
# EXACT (the text is identical), MOVED (the text survives at one new line), NOT-UNIQUE (blank when written or
# multiple occurrences at HEAD), GONE (text nowhere at HEAD), NO-BASE (line didn't exist at the commit),
# UNPATHED (basename-only cite), NOT-AT-HEAD (rooted path absent at HEAD). The `--reaim` mode prints a
# derived re-aim list so a lane can clear MOVED citations by applying the reader's own rows.
# This step runs the reader in report mode (exit 0, prints all classes) and its harness to prove the reader
# can be stopped. It does NOT use --strict MOVED,NOT-UNIQUE by default — the gate reports the census and the
# operator decides whether to re-aim or escalate; the strict mode is an operator decision, not an automatic
# gate failure. The falsify harness proves every class can be reddened and the reader refuses a shallow
# clone (which would otherwise print a confident verdict about nothing).
command -v git >/dev/null 2>&1 || die "step 15 needs git on PATH"
( cd "$ROOT" && node scripts/falsify_line_cite_drift.mjs ) 2>&1 | sed -e 's/^/    /'
( cd "$ROOT" && node scripts/check_line_cite_drift.mjs ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 16. the ledger's line-number drift (strict mode)
step "16/18  scripts/check_line_cite_drift.mjs --strict MOVED,NOT-UNIQUE — the ledger's stale numbers that are re-aimable"
# Step 15 reports the drift census; step 16 enforces it. A citation whose target line has MOVED (text survives at one
# new line) or is NOT-UNIQUE (blank when written or multiple occurrences at HEAD) is a stale number that can be
# re-aimed. The `--reaim` mode prints the derived new numbers so a lane can clear MOVED citations by applying the
# reader's own rows. NOT-UNIQUE citations are either blank when written (never pointed at text) or duplicate at
# HEAD (the reader cannot guess which occurrence was meant); both are fixable only by reading the sentence, so
# they are reported rather than auto-re-aimed. This step runs with --strict MOVED,NOT-UNIQUE and exits 1 if any
# such citations exist, so the gate fails until the lane re-aims or documents them.
command -v git >/dev/null 2>&1 || die "step 16 needs git on PATH"
( cd "$ROOT" && node scripts/check_line_cite_drift.mjs --strict MOVED,NOT-UNIQUE ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 17. the ledger's numeric claims
step "17/18  scripts/check_ledger_numbers.mjs — the ledger's numeric claims verified against the gate's own printout"
# The ledger states numeric facts — "217 quality checks", "217 assertions", "217 checks", "38 arms", etc.
# These numbers must match what the gate actually files, otherwise a stale sentence goes uncorrected.
# This step runs the numbers census with expectations derived from the gate's own output.
# It prints PASS only when the newest claim for each expected noun matches the measured value.
command -v node >/dev/null 2>&1 || die "step 17 needs node on PATH"
# The expectations are the count step 5 just filed, not a figure an operator carries across by hand. The
# ledger originally had three nouns naming one measured quantity — "217 quality checks", "217 assertions",
# "217 checks" — but another lane's types gate has since claimed the noun "checks" with its own count (432),
# so the shared noun no longer belongs uniquely to this gate. We now judge only the two nouns this gate
# unambiguously owns: "quality checks" and "assertions". A literal here would agree with the ledger even
# when the run disagreed, which is the failure step 5 describes above: "216 assertions" was written 120
# times and linked to nothing.
case "${CHECKS:-}" in
  ''|*[!0-9]*) die "step 17 refuses: measured check count is not a positive integer ('${CHECKS:-}')" ;;
esac
[ "${CHECKS}" -gt 0 ] || die "step 17 refuses: step 5 filed 0 checks, so the derivation would judge an empty measurement"
EXPECT="quality checks=${CHECKS},assertions=${CHECKS}"
printf '    expectations derived from this run: %s\n' "${EXPECT}"
( cd "$ROOT" && node scripts/check_ledger_numbers.mjs --expect "${EXPECT}" ) 2>&1 | sed -e 's/^/    /'

# --------------------------------------------------------------------------- 18. the script counts its own steps
step "18/18  self-consistency — every step header's claimed total equals the total this script files"
# Each header announces N/D, and D was typed once, when its own step was the newest thing in the file, so every
# step added afterwards left that sentence stale and nothing read it — the same class step 17 was filed for, aimed
# at the gate's own printout. The total is therefore derived from this file rather than typed into it: the highest
# step number present is the total, and any header whose denominator is not that number stops the run.
command -v grep >/dev/null 2>&1 || die "step 18 needs grep on PATH"
SELF="${BASH_SOURCE[0]}"
STEP_TOTAL=$(grep -o 'step "[0-9][0-9]*' "$SELF" | sed 's/.*step "//' | sort -n | tail -1)
DRIFT=$(grep -o 'step "[0-9][0-9]*[a-z]*/[0-9][0-9]*' "$SELF" | sed 's|.*/||' | sort -n -u | grep -v "^${STEP_TOTAL}$" || true)
if [ -n "$DRIFT" ]; then
  printf '    step headers claiming a total other than %s: %s\n' "${STEP_TOTAL}" "$(printf '%s ' ${DRIFT})"
  die "step 18 — a step header announces a total the script does not file"
fi
printf '    self-total %s, every header denominator agrees\n' "${STEP_TOTAL}"

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
printf '        the console'"'"'s copy/noindex and accessibility promises, which two readers measured and no\n'
printf '        surface ran until the step that runs them, and the readers themselves: every check_*.mjs here\n'
printf '        named by a surface, every CI pipe that runs one declaring the shell that makes it able to fail.\n'
printf '        SYNTHETIC DEMO DATA. The live databases were not opened by this run.\n'
