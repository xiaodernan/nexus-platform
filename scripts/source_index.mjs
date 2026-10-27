/**
 * NEXUS — the one file index the census scripts share.
 *
 * `scripts/check_jsonb_reads.mjs` (D87) and `scripts/check_ledger_citations.mjs` (D88) both answer the same
 * question — "is there a file at this citation?" — over the same repository, and §84's residue (e) named the
 * cost of letting each keep its own exclusion list: a hand list, and a new vendored directory silently joins
 * the source index. The ledger checker's first run is the case that made one list out of two: it grew four
 * tool-cache names (`.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tmp-out`) the site checker never needed.
 * Measured, for the record: drop those four from the set and the ledger index grows from 569 files to 573,
 * every extra from `.pytest_cache` at the root and under `apps/ai/` — two `.gitignore` and two `README.md`.
 * That is not cosmetic: the index would then name `.gitignore` four times instead of twice, so a paragraph
 * citing the file the repo root owns would be reported AMBIGUOUS on account of a directory no author meant to
 * cite. The other three names are insurance against a build that leaves output behind; today they contribute
 * nothing either predicate accepts — 247 `.class` files sit under `target/` and `.tmp-out/`, and `.class`
 * matches neither list, so no compiled class can enter either index.
 *
 * The two consumers still choose their own file predicate: the site census indexes source the build compiles,
 * while the ledger census has to resolve a documentation or config path a paragraph cites. What cannot drift
 * is which directories are not part of the repository's own text.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories that hold no first-party claim: a citation into one is a bug in the citation.
 *
 * ONE LIST, THREE READERS (section 84 residue (e)). `check_jsonb_reads.mjs` (D87) and
 * `check_ledger_citations.mjs` (D88) have imported this set since D85 made one list out of two; the comment
 * census folded in when `check_comment_citations.mjs` began importing it.
 *
 * D197 put a history claim in this paragraph that the refs contradict, so it is corrected here instead of being
 * left for a later reader to disprove: it said the comment census "kept its own SKIP and was never folded in".
 * `git log -S VENDOR_DIRS -- scripts/check_comment_citations.mjs` names one commit, 656ab7e, so the import landed
 * there — eleven units after the ruling that ordered it, whose text is D181 (the comment inside that file numbers
 * it D180, one ruling early). What D181 ruled and the bytes never carried is the second half: it states "`VENDOR_DIRS
 * is 21 names", naming `out_smoke`, `vendor`, `.qoder`, `.specraft` and `logs` as the union's additions, and the set
 * read from `5e5bfe3`, `656ab7e` and `af9bf2c` each holds 14 names with none of those five present. `f024260` (D197)
 * is the first commit whose set is the ruled union — 21 names — and `.scratch` on top of it makes 22. So the fold
 * unified on the SHORTER list, and between 656ab7e and D197 every reader walked the directories the ruled union
 * excludes; no census has been reading the set D181 described for eleven units.
 *
 * The radius of that, measured on this working tree by the shared walker itself: with the 14 names it returns 735
 * files for `LEDGER_EXT` against 592 for the union, and 591 against 496 for `SOURCE_EXT`. The 143 extra sit under
 * `.scratch` (83), `.tmp-p4` (35), `data/seed/out_smoke` (22) and `.workbuddy-ai` (3), and of the 21 `.sql` files
 * in the smoke directory none is tracked. This matters because the census resolves a citation against whatever the
 * walker returned: a directory absent from this set is a directory whose files the readers certify as cite targets.
 *
 * D181's own measurements were the same three, and one of them has since grown: it walked 21 generated `.sql`
 * files under the gitignored `data/seed/out_smoke/` (still 21, still untracked), the source files of `.tmp-p4/` —
 * this project's documented scratch directory (PLAN.md: take `.tmp-p4/mvnlock` before any `mvn`), six when D181
 * measured and 21 by `SOURCE_EXT` on this tree, which is what a scratch directory's size is — and the three notes
 * of `.workbuddy-ai/memory/`. None of those is a file the repository ships, so a citation into one is the bug this
 * set exists to prevent. The set below is the UNION of both hand lists, so no reader lost a directory another kept;
 * it is also wider than either, because `.tmp-p4` and `.workbuddy-ai` were excluded by neither list before the
 * fold. That direction was deliberate — a name added here makes a census refuse a citation, never certify one —
 * and the four names only the ledger census had are insurance against a build that leaves output behind, with
 * `out_smoke` covering the seed smoke directory exactly as `out` already covers `data/seed/out`.
 *
 * D197 added `.scratch` — the name is spelled out here because the cost of NOT having it was measured, not
 * guessed. `.scratch/` is a lane's working directory for witness scripts and drafts; it holds no tracked file, and
 * until now the three readers walked it as if it were part of the repository. A D196 landing found what that
 * means: a stale copy of `cli_args.mjs` left in `.scratch/d194_meta/` made the basename the shared walker returns
 * appear twice, so a citation naming exactly one shipped file read AMBIGUOUS, gate step 9's falsifier refused
 * with exit 2, and because `db_gate_fresh.sh` runs under `set -euo pipefail` that refusal stops whichever session
 * runs the gate next. The residue D196 recorded — "nothing charges the write" — is the gap this name answers.
 *
 * A skip list is a hiding place unless a clause proves nothing reaches through it, so three measurements were
 * taken before the name went in, and `scripts/falsify_ledger_text.mjs` arms the property both ways:
 *   · no tracked code refers to it — `git grep -F '.scratch'` returns nothing (the ten hits a first measurement
 *     printed were the English phrase "from scratch", produced by an unescaped `.` in a regex, not by a path);
 *   · it holds no claim the comment plane reads — `check_comment_citations.mjs --plane` aimed at it prints
 *     `COMMENT CITATIONS: 0 tokens found`, which is this project's refusal for an empty plane, not a green;
 *   · excluding it costs nothing else — every file the shared walker loses sits under a directory named
 *     `.scratch` (73 for `LEDGER_EXT`, 47 for `SOURCE_EXT` at landing; an arm prints the live count and the
 *     predicate that a mirror walk reproduces the shipped index name for name), and no ledger citation names a
 *     `.scratch` path or resolves today only through one.
 */
export const VENDOR_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'target', 'build', 'dist',
  '.next', 'out', 'out_smoke', 'coverage', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tmp-out', '.tmp-p4',
  '.workbuddy-ai', 'vendor', '.qoder', '.specraft', 'logs', '.scratch']);

/** Files the build compiles or the seed runs — the site census's predicate. */
export const SOURCE_EXT = /\.(java|py|ts|tsx|mjs|cjs|sql|sh)$/;

/**
 * What a ledger is allowed to cite: the build's sources plus the docs, config and lock files a paragraph
 * points at. `check_ledger_citations.mjs` (gate step 8) is its only other user, and the reason it lives here
 * is D166: a second reader of the same claim kept its own copy of this predicate, so the two resolved
 * different file sets and the project quoted three different blank-citation counts for one sentence.
 */
export const LEDGER_EXT = /\.(java|py|ts|tsx|mjs|cjs|sql|sh|md|ya?ml|json|toml|txt|properties|cfg|ini)$/;

/**
 * The repository's extensionless root files — the build's own entry points.
 *
 * `LEDGER_EXT` names a file by its extension, so it structurally cannot name a file that has none, and the
 * repository has one that the ledgers point at: the root `Makefile`. D571 cited it — "the Makefile's own dev
 * plane is `WEB_PORT ?= 3002`, `PLATFORM_PORT ?= 8090`, `AI_PORT ?= 8010` (`Makefile:20-22`)" — and gate
 * step 8 filed that citation as **FILE NOT FOUND**: the file is real, tracked, and holds exactly those three
 * knobs on exactly those lines, but no indexed file had that name or path.
 *
 * The class is the reader's own grammar, not the writer's: `isCitation()` admits any capitalised
 * extensionless word as a class stem (`EventsController:63`), so `Makefile:20-22` was a citation the reader
 * had promised to judge and then could not open. Two ways out existed. Spelling the cite `./Makefile:20-22`
 * would have taken the path branch, whose last segment is not a held file, so the citation would have been
 * silently dropped from the census — a green that says nothing (D193's chain). Teaching the index the file
 * keeps it judged.
 *
 * A hand list, and it can go stale: a root file added later and cited by a paragraph would be filed FILE NOT
 * FOUND again. That is the good direction — a stale entry is a red, not a silence, and the reader that raises
 * it names the file it could not open. It is ONE list beside `LEDGER_EXT`, not a copy inside a reader (D166).
 */
export const EXTENSIONLESS = new Set(['Makefile']);

/**
 * The one predicate for "a file a ledger may cite": extensioned by `LEDGER_EXT`, one of the repository's
 * extensionless root files, or a dot file the repository owns. Three readers walk the ledger population with
 * it — `check_ledger_citations.mjs`, `citation_blank_census.mjs` and `citation_blank_sites.mjs` — and D166's
 * lesson is that they must not keep private copies of it: two copies resolved two file sets and the project
 * quoted three different blank-citation counts for one sentence.
 */
export const LEDGER_FILE = (name) => LEDGER_EXT.test(name) || EXTENSIONLESS.has(name) || name.startsWith('.');

/**
 * Every file under `root` that `accept` names, as forward-slash paths relative to it, skipping VENDOR_DIRS.
 * A directory it cannot read is skipped rather than thrown on: the walk runs over a working tree another
 * lane may be mid-write in.
 */
export function walkFiles(root, accept, dir = '', out = []) {
  let entries;
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    if (VENDOR_DIRS.has(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) walkFiles(root, accept, rel, out);
    else if (accept(name)) out.push(rel);
  }
  return out;
}
