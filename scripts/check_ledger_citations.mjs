#!/usr/bin/env node
/**
 * NEXUS — the ledger's own citations, read back out of the source (§84 residue (d)).
 *
 * WHY THIS EXISTS. `data/seed/quality.sql` answers name a `File.java:NNN` and `scripts/check_jsonb_reads.mjs`
 * (D87) now opens that file and refuses seven ways of being wrong about it. The ledgers — `docs/DECISIONS.md`
 * and `docs/STATUS.md` — are written in the same grammar and carry ~200 such citations between them, and
 * nothing has ever opened them. §84 claimed a hand census of that plane ("all 71 resolved, 3 sit one line
 * off"); this script replaces the hand census with a run, and the first run contradicted the claim, so §84 is
 * corrected in this same diff. What it does find is this lane's own text: grammar illustrations written as
 * file names that no repo holds, a nested-class cite (`MeController.FavoriteBody:59`), and D86's
 * `services/platform/.../growth/EventRepository.java:NN` — an elided path, which is a citation to a file
 * that does not exist.
 *
 * WHAT IT CHECKS, per citation-shaped token:
 *   FILE NOT FOUND   the name carries a source extension or a directory path and the index holds no such file
 *   AMBIGUOUS        the basename is held by more than one file, so the cite names none of them in particular
 *   PAST EOF         the cited line is beyond the file's last line (and the whole range is printed)
 *   BLANK LINE       the span starts on a line that holds nothing — judged in `--text` mode and inside a
 *                    section the plane being read is writing (D162, D191), counted-not-judged for the
 *                    committed backlog, because a committed row can only be corrected by appending (D161)
 *   BACKWARDS        a `78-84` range written `84-78`
 *   ZERO             line 0, which no editor can show
 *   UNTRACKED TARGET the resolved file is on this disk and in no commit, so a clean checkout of the ref this
 *                    run certifies cannot open it (D203) — counted on the committed plane, judged in a section
 *                    this run is writing, and counted on a plane handed over with `--untracked-backlog`
 *   UNCOMMITTED TARGET the file IS in HEAD's tree but not with the bytes this disk holds, so a line claim that
 *                    resolves here can be past HEAD's end (D204) — counted on the committed plane only when the
 *                    same cite is clean against this disk, which means a clean checkout can never claim it
 *
 * WHAT IS NOT A CITATION, stated because a checker that judged every `word:number` would be red on prose:
 * `127.0.0.1:5433` and `redis:6379` (host and port), `NEXUS_RL_AUTH:10` (an environment variable and its
 * value), `V1:574` is a migration cite and IS checked (`V1__…sql`), `EventsController:63` is a Java class
 * name without its extension and IS checked when the stem resolves to exactly one file, and a bare `:22`
 * continues the file before it — a continuation inherits its file, so it is counted, never judged alone.
 *
 * WHAT USED TO BE DROPPED WITHOUT BEING NAMED, and no longer is (D197): a path citation whose first segment is a
 * dot directory — the root-relative form, and a path under the CI workflows directory — was handed to the
 * bare-dotfile rule, which asks a basename-keyed table to hold a whole path. It never can, so those citations
 * reached no resolver at all. The instances in the two ledgers turned out to be sound; the finding is that
 * nothing had ever judged them, which is the same shape as a skip list that hides a file — see `isCitation`.
 *
 * TWO SNAPSHOTS, AND WHICH ONE THE GATE READS. The default census is strict on HEAD and reads the working
 * copy only to report what the next commit will inherit: three lanes append to `docs/STATUS.md` at once, so
 * the bare run over committed text is the one two lanes can both run and compare. `--worktree` makes the
 * working copy strict instead, and that is the mode `db_gate_fresh.sh` step 8 runs — because the other seven
 * steps all read the tree they are standing in, and a green run has to certify the text about to be
 * committed, not the text before it. The choice was made from a measurement, not a preference: over a tree
 * already holding three lanes' uncommitted STATUS sections, the worktree census is 151 citations, 0 offenders.
 *
 * D191 — both snapshots are read in both real-ledger modes, because the blank rule asks a two-plane question.
 * `--worktree` used to answer it with one census object on both sides of the question, so "is this section
 * new?" was always "no" there, and the sentence that promises a blank in a new section offends printed itself
 * over a count of zero. Measured on the same tree either way: the default plane printed
 * `1 blank(s) among 25 new section(s)` and exited 1, `--worktree` printed `0 blank(s) among 0 new section(s)`
 * and exited 0 — the gate's own mode was the one that could not see the rule the gate was given. HEAD is now
 * read under `--worktree` too, for newness only, and a HEAD it cannot read is refused as UNCHECKED rather
 * than guessed at: an unreachable committed plane would make every section look new.
 *
 * USAGE
 *   node scripts/check_ledger_citations.mjs                # strict on HEAD, working copy reported
 *   node scripts/check_ledger_citations.mjs --worktree     # strict on the working copy — what gate step 8 runs
 *   node scripts/check_ledger_citations.mjs --report       # never exit non-zero
 *   node scripts/check_ledger_citations.mjs --verbose      # list every citation and where it resolved
 *   node scripts/check_ledger_citations.mjs --text=<file>  # census one file instead of both ledgers (plants)
 *   node scripts/check_ledger_citations.mjs --text <file>  # the same request; both spellings are parsed
 *   node scripts/check_ledger_citations.mjs --untracked-backlog # with --text: the plane is all backlog, so
 *                                                          # an untracked target counts but does not offend
 *
 * A flag this reader does not know is refused with `RESULT: NOT CHECKED` and exit 2, never ignored. D157
 * measured why that matters: the old parser read only `--text=`, so `--text <plant>` was not an error, it was
 * a census of the two real ledgers that believed it had been aimed at a plant — 297 sections, 377
 * citation-shaped tokens, 0 offenders, exit 0.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { LEDGER_EXT, VENDOR_DIRS, walkFiles } from './source_index.mjs';
import { parseFlags } from './cli_args.mjs';

const ROOT = process.cwd();

/**
 * The vocabulary for "this run is not a verdict". Exit 2 already meant it in the ledger-read path below; D157
 * extends it to the argument path and the non-vacuity guards, which used to `throw` — a stack trace and exit 1,
 * the same code as "the ledgers hold a false citation", which is a claim about the citations and was not true.
 */
const notCheckable = (m) => {
  console.log('NEXUS — ledger citation census');
  console.log(`  RESULT: NOT CHECKED — ${m}`);
  process.exit(2);
};

/**
 * D157 — the argument grammar, in one place. Two spellings have ever been pointed at this reader:
 * `--text=<path>` (gate step 8, and `check_comment_citations.mjs:364`) and `--text <path>` (what a person types
 * from the USAGE line). Only the first was parsed, so the second did not fail — it silently censused the wrong
 * plane and printed a truthful-looking green about it. Both are parsed now, and a request that cannot be aimed
 * is refused rather than dropped: unknown flag, missing value, empty value, a value that reads as another flag,
 * and a flag given twice are each a refusal.
 *
 * D158 — the grammar itself moved to `cli_args.mjs`, because by then four readers had each grown the same
 * table by hand and #102 named that as the debt: two dialects parsed by four copies differ in their fine
 * print, and the fine print is where the defect lives. The refusal sentences this reader prints are the
 * module's, and `scripts/falsify_ledger_text.mjs` pins several of them verbatim — which is how the move is
 * shown to preserve behaviour rather than assumed.
 */
const FLAGS = {
  '--text': { kind: 'value' },
  // D163 — the two planes separately addressable. `--dir` is where the working-copy ledger files are read
  // from and `--head-dir` where the committed ones come from, both as plain files instead of `git show`.
  // WHY: D162 armed the blank-line class for "a section this run is writing", and its red side could only be
  // observed once, by this lane's own ledger draft, because no harness may write a new section into the real
  // `docs/`. A witness that cannot re-run its own red is a story, so the seam exists to make the arm possible
  // — and, as D96 put it, because it is an interface someone would use for a reason that happens to be testable.
  // WHAT STAYS AT THE REPOSITORY: the source index and the `git show` fallback. A fixture's citations point at
  // real files (`scripts/cli_args.mjs:NN`), so the plane that moves is the ledgers, never the thing cited.
  '--dir': { kind: 'value', unit: 'directory' },
  '--head-dir': { kind: 'value', unit: 'directory' },
  '--report': { kind: 'switch' },
  '--worktree': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
  // D203 — see the BLANK_JUDGED note below for why a whole-plane census needs this, and the LIMITS block for
  // what it does NOT turn off.
  '--untracked-backlog': { kind: 'switch' },
};

const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) notCheckable(parsed.reason);
const ARGS = {
  text: parsed.value['--text'] ?? null,
  dir: parsed.value['--dir'] ?? null,
  headDir: parsed.value['--head-dir'] ?? null,
  report: Boolean(parsed.flag['--report']),
  worktree: Boolean(parsed.flag['--worktree']),
  verbose: Boolean(parsed.flag['--verbose']),
  untrackedBacklog: Boolean(parsed.flag['--untracked-backlog']),
};
/**
 * `--text` replaces the ledger list with one file, read as written. It exists for the same reason
 * D87's `--quality=` does: a witness must be able to show an arm failing without writing a tracked file that
 * two other lanes are appending to.
 */
const LEDGERS = ARGS.text === null ? ['docs/DECISIONS.md', 'docs/STATUS.md'] : [ARGS.text];
const REPORT_ONLY = ARGS.report;
const WORKTREE = ARGS.worktree || ARGS.text !== null;
const VERBOSE = ARGS.verbose;
/**
 * D161 — the blank-line class is judged in `--text` mode and not on the two real ledgers, and the reason is a
 * measured count rather than convenience. `scripts/citation_blank_census.mjs` found 12 citations in the ledgers
 * landing on a line that holds nothing (D160): 6 existed before D160 was written and 6 are the sentences D160
 * itself wrote to name those 6. This project corrects a committed row by appending, and an append cannot move
 * the number the older row printed, so arming the class on the reading plane would red the gate on history;
 * a hand-typed `file:line` allow list is the exemption shape §-conventions already rejected, because an
 * exemption keyed on a line number expires silently on the next edit. The plane a run is WRITING is where the
 * predicate has no backlog: `--text` is what the falsifier plants use and what gate step 9 feeds its generated
 * comment-plane census through, so every row scored there is new by construction.
 */
const BLANK_JUDGED = ARGS.text !== null;
/**
 * D203 — a caller's declaration that the plane it is handing over is entirely a pre-existing backlog, for the
 * UNTRACKED TARGET class alone. The need came from a measurement, not a preference: gate step 9 feeds its
 * generated comment-plane census through `--text`, and the first run of the new class over that plane printed
 * `untracked targets 12 of 59` with 12 offenders and exit 1 — every one of them a cite inside shipped text
 * (`data/seed/quality.sql` pointing into `SeoRepository.java` and `AdminListRepository.java`, among others)
 * whose target is on this disk and in no commit. Those rows are exactly the debt the class was written to name,
 * and they are not this run's to fix: the correction is `git add` of another lane's files, which this gate has
 * no authority over, so arming the class on that plane would red the gate on a backlog and say nothing new.
 * `--worktree` mode does not need the switch, because newness is decidable there from the two planes it reads.
 *
 * What this does NOT do: it turns off one class on one plane. FILE NOT FOUND, AMBIGUOUS, PAST EOF, BACKWARDS,
 * ZERO and BLANK LINE keep judging the same text — the class's own witness arms that sentence by planting a
 * plane carrying both an untracked target and a blank cite, which is what makes the switch a statement about
 * the plane rather than a mute button.
 */
const UNTRACKED_BACKLOG = ARGS.untrackedBacklog;
/** Where a plane's ledger files live. An absolute path is taken as given; a relative one is the repository's. */
const plane = (p) => (p === null ? null : (isAbsolute(p) ? p : join(ROOT, p)));
const DIR = plane(ARGS.dir);
const HEAD_DIR = plane(ARGS.headDir);
/**
 * The two planes are addressed as a pair, and one without the other is refused rather than guessed. Measured
 * on the seam fixture before this guard existed: `--head-dir` alone compared a two-section committed plane
 * against the REAL ledgers, so the 12 blank citations D161 deliberately leaves counted became `12 blank(s)
 * among 311 section(s) this run is writing` and the run exited 1 — the exemption inverted by a typo. `--dir`
 * alone ran the other way and printed `1 blank(s) among -310 section(s)`, a negative count of sections being
 * written, which is the two planes' heading totals being subtracted across trees. Neither question is the one
 * a caller means, and a verdict that silently mixes trees is worse than a refusal that names its partner.
 */
if ((DIR === null) !== (HEAD_DIR === null)) {
  notCheckable(DIR === null
    ? `--head-dir was given without --dir — the two planes are addressed as a pair, and this run would compare ${HEAD_DIR} against the ledgers of this tree`
    : `--dir was given without --head-dir — the two planes are addressed as a pair, and this run would compare this tree's HEAD against ${DIR}`);
}
/**
 * D203 — the backlog declaration is only accepted for a plane that cannot decide newness for itself. On the two
 * real ledgers, or any pair of planes, `isNewSection` answers "is this row being written right now", so the
 * class has a judged subset and a switch that declares the WHOLE plane a backlog would silence it exactly where
 * it has a verdict — including for gate step 8, the one caller that must not be able to. Refused rather than
 * ignored, in the same shape as the half-pair refusal above: an exemption that quietly narrows a class is the
 * D157 disease with a flag on it.
 */
if (UNTRACKED_BACKLOG && ARGS.text === null) {
  notCheckable('--untracked-backlog was given without --text — the plane this run reads can decide which sections are new, so the class has a judged subset there and declaring the whole plane a backlog would silence it on the one plane where it carries a verdict');
}

/* ------------------------------------------------------------------ the source index */

/**
 * What a paragraph is allowed to point at: the build's own sources, which `source_index.mjs` names for D87's
 * site census, plus the docs, config and lock files a ledger cites — `docs/DATABASE.md:NN`, `.github/workflows/ci.yml:NN`,
 * `package.json:NN`. The directory exclusion is NOT local: it is the shared list in `source_index.mjs`, which
 * this checker grew by four tool-cache names — because that index would otherwise name `.gitignore` four times
 * instead of twice (`.pytest_cache` at the root and under `apps/ai/`) and report a true root cite AMBIGUOUS.
 */
// The predicate lives in `source_index.mjs` beside the exclusion list and `SOURCE_EXT`, because D166 found a
// second reader of the same claim carrying its own copy — which is how one sentence came to be quoted with
// three different counts.
const FILES = walkFiles(ROOT, (name) => LEDGER_EXT.test(name) || name.startsWith('.'));

/**
 * D203 — HEAD's tree, as the authoritative answer to "will this cite resolve anywhere else?".
 *
 * `FILES` is a filesystem walk, so it certifies a path this machine happens to hold. Measured at landing on
 * `026a04d`, this working copy: 513 citation-shaped tokens, 0 offenders, exit 0 — and 46 of those cites point
 * at a file no commit holds. The same ref frozen with `git worktree add --detach … HEAD`, read by the reader
 * as it shipped before this class existed, files 47 offenders: 46 FILE NOT FOUND and 1 PAST EOF. The 46 name
 * 18 distinct paths (`MerchantContentController`, `AdminListRepository.java`, `AdminConsoleApiTest` and their
 * neighbours in the untracked commerce/admin test packages), while `git ls-files --others --exclude-standard`
 * counts 377 untracked paths on this tree — a wider predicate than "a ledger names it", which is why the two
 * numbers are different and both are written down.
 *
 * So a clean checkout of the ref the gate just certified is a plane where 46 ledger citations point at a file
 * that does not exist, and nothing the disk plane printed said so. The single PAST EOF row is the same
 * conflation one line deeper: it is the cite of `scripts/falsify_ledger_text.mjs` at line 858, where HEAD's
 * blob has 736 lines and this disk has 887, so the cite is inside bounds on the disk plane and past the end on
 * the committed one. (Written without a colon so this comment does not add a citation of its own to the drift
 * backlog while that file is being edited by another lane.)
 *
 * That is the mirror of D197's exclusion lesson, read the other way: a directory absent from `VENDOR_DIRS` is
 * a directory whose files the readers certify as cite targets, and a file absent from git's tree is a file only
 * this machine can offer.
 *
 * The list comes from `git ls-tree -r --name-only HEAD` rather than `git ls-files`, because the claim being
 * checked is about the commit a clean checkout reproduces, not about this machine's index: a staged-but-not-
 * committed file is exactly as unreachable from that checkout as an untracked one, and asking the index would
 * let a half-landing look shipped.
 *
 * A run that cannot ask git gets `TRACKED === null`, and the class prints UNCHECKED instead of a number — it
 * never silently becomes "0 offenders". Measured on the harness's own fixture roots (`--dir` planes under the
 * OS temp directory, which are not repositories): 3 arms there expect exit 0 with a green verdict, so a
 * refusal would turn a plane with no git into a red gate. Disabling one class and saying so is what a plane
 * without history looks like; inventing its green is what D157 was written against.
 */
let TRACKED = null;
let TRACKED_REASON = null;
try {
  TRACKED = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'],
    { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).split(/\r?\n/).filter(Boolean));
} catch (error) {
  TRACKED = null;
  TRACKED_REASON = `git ls-tree HEAD failed — ${error.code ?? error.message}`;
}

const BY_BASENAME = new Map();
const BY_STEM = new Map();
for (const rel of FILES) {
  const base = rel.split('/').pop();
  BY_BASENAME.set(base, [...(BY_BASENAME.get(base) ?? []), rel]);
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  BY_STEM.set(stem, [...(BY_STEM.get(stem) ?? []), rel]);
}
/** `V1` -> `db/migration/V1__….sql`, the notation the ledgers use for a Flyway migration line. */
const MIGRATIONS = new Map();
for (const rel of FILES) {
  const m = rel.split('/').pop().match(/^(V\d+)__/);
  if (m) MIGRATIONS.set(m[1], [...(MIGRATIONS.get(m[1]) ?? []), rel]);
}

const TEXT = new Map();
/**
 * D204 — the cited file's lines, read from the plane the census is judging.
 *
 * Until this function took a plane, `census(true, …)` asked HEAD's ledgers whether their line numbers exist
 * and then answered from this disk: measured at landing on `8fd6c7e`, 10 of the 31 path-exact files the two
 * ledgers cite differ between HEAD's bytes and this working copy's, and the two verdicts the conflation
 * produced were both wrong — one cite past HEAD's end was reported clean (0 strict offenders printed where a
 * frozen HEAD said 1), and two blank cites were counted as HEAD's committed backlog when HEAD holds no blank
 * line at them at all (21 printed, 19 true). Same disease as D203, one level deeper: D203 asked whether HEAD
 * holds the *path*, and this asks whether HEAD holds the *bytes*.
 *
 * `null` means the plane holds no readable copy of the path, which is a different thing from "no lines": the
 * caller must not judge a line claim out of nothing. When HEAD's own tree lists the path but `git show` cannot
 * print it, that is a plane this run cannot read, so it is recorded in `HEAD_FAILS` and refused below rather
 * than quietly answered from the disk.
 */
const HEAD_FAILS = [];
function fileText(rel, committed) {
  const key = `${committed ? 'head' : 'disk'}:${rel}`;
  if (TEXT.has(key)) return TEXT.get(key);
  let lines = null;
  if (!committed) {
    lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
  } else if (HEAD_DIR !== null) {
    try {
      lines = readFileSync(join(HEAD_DIR, rel), 'utf8').split(/\r?\n/);
    } catch {
      lines = null;                     // the supplied committed plane simply does not hold this file
    }
  } else {
    try {
      lines = execFileSync('git', ['show', `HEAD:${rel}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 })
        .split(/\r?\n/);
    } catch (error) {
      lines = null;
      if (TRACKED === null || TRACKED.has(rel)) {
        HEAD_FAILS.push({ rel, reason: error.code ?? error.message });
      }
    }
  }
  TEXT.set(key, lines);
  return lines;
}

/**
 * Every line-level claim one cite makes against one copy of one file: which of them offend, and how many span
 * starts land on an empty line. Factored out of `census` because D204 puts the identical question to two
 * copies of the same file — HEAD's and this disk's — and a second inline copy of these four rules is how one
 * sentence about a blank line came to carry three different counts (D166).
 */
function citeLines(cite, rel, lines, section, where, judgedHere) {
  const found = [];
  let blanks = 0;
  const n = lines.length;
  if (cite.backwards) {
    found.push({ kind: 'BACKWARDS', where, cite, detail: `${cite.name}:${cite.backwards} in ${rel}, which has ${n} lines` });
  }
  for (const span of cite.spans) {
    const [a, b = a] = span;
    if (a === 0 || b === 0) {
      found.push({ kind: 'ZERO', where, cite, detail: `${rel} has no line 0` });
      continue;
    }
    if (b > n) {
      found.push({ kind: 'PAST EOF', where, cite, detail: `${cite.name}:${span.join('-')} — ${rel} has ${n} lines` });
      break;
    }
    // D161 — counted on both planes, offended on one. A span that starts on a line holding nothing
    // cannot be the line its sentence describes, whichever plane the sentence sits in; the reading
    // plane just cannot afford the verdict yet, because four of the twelve blank cites there are in
    // committed rows whose correction channel is an append that leaves the old number standing.
    if (!lines[a - 1].trim()) {
      blanks += 1;
      if (judgedHere(section)) {
        found.push({ kind: 'BLANK LINE', where, cite,
          detail: `${rel}:${a} is empty — a blank line cannot hold the claim this cite makes` });
      }
    }
  }
  return { found, blanks };
}

/**
 * Resolve a cited name the way D87's site checker does — a path is matched by suffix, a bare name by
 * basename — plus three shapes the ledgers use and `quality.sql` does not: an extensionless Java class stem
 * (`EventsController`), an outer-class/nested-record pair (`MeController.FavoriteBody`), and an elided
 * path. The header has claimed since D86 that "an elided path ... is a citation to a file" while no branch
 * implemented it: an elided-prefix token tokenizes to a leading-slash path (the elision mark is a non-word
 * character, so the tokenizer eats it and keeps the slash), and the suffix branch below then asked for
 * `rel.endsWith('//merchant/...')`, which nothing holds — so the §257 census row quoting that form was
 * filed FILE NOT FOUND by the gap between the header's promise and the code. An elision is now judged on
 * the segments it left, which is the one reading a width-saving abbreviation can be given; a tail more
 * than one file holds is AMBIGUOUS, because the elision is exactly what would have separated them.
 */
function resolve(name) {
  // `./.gitignore` is the root-relative form the ledgers need for a file the repo root owns twice over:
  // bare `.gitignore` is held by the root AND by packages/sdk, so a root cite has to say it is at the root.
  if (name.startsWith('./')) return FILES.filter((rel) => rel === name.slice(2));
  // An elided prefix arrives in two spellings: `…/a/b.java`, whose `…` the tokenizer strips and leaves a
  // leading slash; and `x/.../a/b.java`, whose dots survive inside the token. Both are resolved by suffix
  // on the tail after the elision.
  if (name.startsWith('/')) {
    const tail = name.slice(1);
    return FILES.filter((rel) => rel === tail || rel.endsWith(`/${tail}`));
  }
  if (name.split('/').includes('...')) {
    const segs = name.split('/');
    const tail = segs.slice(segs.lastIndexOf('...') + 1).join('/');
    return FILES.filter((rel) => rel === tail || rel.endsWith(`/${tail}`));
  }
  if (name.includes('/')) return FILES.filter((rel) => rel === name || rel.endsWith(`/${name}`));
  if (MIGRATIONS.has(name)) return MIGRATIONS.get(name);
  if (LEDGER_EXT.test(name)) return BY_BASENAME.get(name) ?? [];
  const outer = name.match(/^([A-Z][A-Za-z0-9_]*)\.[A-Z][A-Za-z0-9_]*$/);       // Outer.Nested
  const stem = outer ? `${outer[1]}.java` : name;
  return BY_BASENAME.get(stem) ?? BY_STEM.get(stem) ?? [];
}

/* ------------------------------------------------------------------ what is a citation */

const HOST = /^[\d.]+$/;                                  // 127.0.0.1, 1.2.3
const ENV = /^[A-Z][A-Z0-9_]*$/;                          // NEXUS_RL_AUTH, HTTP
const SECTION = /^§?\d+$/;                                 // §81, D84 (no extension, no capital stem)
const FILE_SUFFIX = /\.[a-z][a-z0-9]{0,5}$/;              // something.java, generate.py, quality.sql
const CLASS_NAME = /^[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)?$/;   // EventsController, MeController.FavoriteBody

/**
 * True when the token is claiming to point at a file.
 *
 * D197 — the path clause has to be asked before the bare-dotfile clause. The old order returned on
 * `name.startsWith('.')` for a name that also carries a slash, and asked `BY_BASENAME` — which is keyed on
 * basenames, never paths — to hold it. It cannot, so every citation whose path begins with a dot directory was
 * dropped before it ever reached `resolve()`: ten such tokens in the two ledgers at this commit — four to
 * `.github/workflows/ci.yml` and six to `./.gitignore`, the root-relative form this file's own resolver has a
 * branch for and the CI form the arms cite — none of them judged by any run since D88 wrote the classifier. The
 * count came out of this file's own tokenizer and its own `isCitation` read back off its bytes, because a hand
 * copy of a scanner finds a different number (the first pass over this claim, with a regex of mine, printed 4).
 * A rule the classifier never lets run is not a rule the census has
 * (D193's chain), and the shape of the bug is the one this unit set out to arm: the skip list was the question,
 * and the answer was that the hiding place was one clause earlier, in what counts as a citation at all.
 */
function isCitation(name) {
  if (HOST.test(name) || ENV.test(name) || SECTION.test(name)) return false;
  if (name.includes('/')) {
    // A path is judged on its last segment, and a segment that is itself a dot file (`.gitignore`) counts only
    // when the index holds that name — so `./.gitignore` is a citation and `some/dir/notes` is prose.
    const last = name.split('/').pop();
    return FILE_SUFFIX.test(last) || LEDGER_EXT.test(last) || BY_BASENAME.has(last);
  }
  if (name.startsWith('.')) return BY_BASENAME.has(name);   // .gitignore, .env.example
  if (MIGRATIONS.has(name)) return true;
  return LEDGER_EXT.test(name) || CLASS_NAME.test(name);
}

/* ------------------------------------------------------------------ the scan */

/**
 * `name:12`, `name:217,:289`, `name:78-84` all yield spans; a span is `a` or `a-b`. Bare `:22` has no name
 * here and is counted separately as a continuation of the previous cite.
 */
function citeTokens(line) {
  const out = [];
  for (const m of line.matchAll(/(?:^|[^\w./-])([\w.\-/]+):(\d+(?:[-,:]\d+)*)/g)) {
    const spans = [];
    let backwards = null;
    for (const part of m[2].split(/[,:]/)) {
      if (!part.includes('-')) { spans.push([Number(part)]); continue; }
      const [a, b] = part.split('-').map(Number);
      spans.push([a, b]);
      if (b < a && backwards === null) backwards = `${a}-${b}`;
    }
    out.push({ name: m[1], spans, backwards });
  }
  return out;
}

/**
 * The text of one ledger, or `null` with a reason when it cannot be read.
 *
 * The `git show` half used to be a bare `execFileSync`, which meant a sandbox that refuses to spawn `git`
 * (this machine's does, with `EBUSY`) took the whole checker down as an uncaught `spawnSync` stack trace —
 * a tool reporting a crash where it owed a verdict. Reading a ledger is not the thing being checked, so a
 * failure here is now data the report carries, not an exception it throws.
 */
function ledgerText(ledger, committed) {
  if (committed && HEAD_DIR !== null) {
    // The committed plane supplied as files. This is the whole point of D163's seam: the red side of "a blank
    // line inside a section this run is writing" needs a head plane with one section and a disk plane with
    // two, and no harness may write that into the real `docs/`.
    const p = join(HEAD_DIR, ledger);
    try {
      return { text: readFileSync(p, 'utf8'), reason: null };
    } catch (error) {
      return { text: null, reason: `the supplied committed plane ${p} could not be read — ${error.code ?? error.message}` };
    }
  }
  if (committed) {
    try {
      return {
        text: execFileSync('git', ['show', `HEAD:${ledger}`], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }),
        reason: null,
      };
    } catch (error) {
      return { text: null, reason: `git show HEAD:${ledger} failed — ${error.code ?? error.message}` };
    }
  }
  try {
    return { text: readFileSync(isAbsolute(ledger) ? ledger : join(DIR ?? ROOT, ledger), 'utf8'), reason: null };
  } catch (error) {
    return { text: null, reason: `could not read ${ledger} — ${error.code ?? error.message}` };
  }
}

/**
 * One pass over one ledger. `committed` selects HEAD text vs the working copy; the section a token sits in is
 * carried so an offender can be attributed to the entry that made it, and the section count doubles as the
 * non-vacuity floor: a scan that reaches zero sections has not read the file it claims to have read.
 *
 * D203 renames the second argument from `blankOffends`: it is the newness predicate, and it now decides which
 * sections are judged for two classes, not one. Keeping the old name would have made the second call site read
 * like a blank-line rule that also charges an untracked target. The third argument exists because those two
 * classes turned out to need different exemptions on one plane — see `UNTRACKED_BACKLOG`.
 */
function census(committed, judgedHere, untrackedHere = judgedHere) {
  const stats = { tokens: 0, citations: 0, continuations: 0, sections: 0, blanks: 0, judged: 0, untracked: 0, untrackedJudged: 0, uncommitted: 0, uncommittedRows: [], titles: new Set(), files: new Set(), offenders: [], unread: [] };
  for (const ledger of LEDGERS) {
    const { text, reason } = ledgerText(ledger, committed);
    if (text === null) {
      // A ledger nobody could open is not a ledger with no offenders: it is an unmeasured one, and the two
      // must not print the same way.
      stats.unread.push({ ledger, reason });
      continue;
    }
    let section = '(before the first heading)';
    // The preamble exists in both planes, so it must never read as a section this run is writing.
    stats.titles.add(section);
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^## /.test(line)) { stats.sections += 1; stats.titles.add(section = line.replace(/^##+ /, '').slice(0, 46)); }
      for (const m of line.matchAll(/(?:^|[^\w./-]):(\d+)/g)) stats.continuations += 1;
      for (const cite of citeTokens(line)) {
        stats.tokens += 1;
        if (!isCitation(cite.name)) continue;
        stats.citations += 1;
        const where = `${ledger} ${section} :${i + 1}`;
        const cands = resolve(cite.name);
        if (cands.length === 0) {
          stats.offenders.push({ kind: 'FILE NOT FOUND', where, cite, detail: 'no indexed file has that name or path' });
          continue;
        }
        if (cands.length > 1) {
          stats.offenders.push({ kind: 'AMBIGUOUS', where, cite,
            detail: `${cands.length} files hold it: ${cands.slice(0, 3).join(', ')}${cands.length > 3 ? ', …' : ''}` });
          continue;
        }
        const rel = cands[0];
        stats.files.add(rel);
        // D203 — the target resolves on THIS disk and in no commit. Counted on the committed plane, judged
        // only in a section this run is writing, which is D161's bargain for a class whose whole backlog is
        // other people's already-committed prose. The correction is `git add`, not a re-aim: the line number
        // is fine and the file simply is not in the tree a checkout reproduces.
        if (TRACKED !== null && !TRACKED.has(rel)) {
          stats.untracked += 1;
          if (untrackedHere(section)) {
            stats.untrackedJudged += 1;
            stats.offenders.push({ kind: 'UNTRACKED TARGET', where, cite,
              detail: `${rel} is on this disk but not in HEAD's tree — a clean checkout cannot open the file this cite points at` });
          }
        }
        const lines = fileText(rel, committed);
        // The plane holds no copy of the file to read a line number out of. On the committed plane that is the
        // UNTRACKED TARGET row above having just spoken, so nothing is added here — and nothing may be judged
        // here against this disk while pretending to speak about HEAD.
        if (lines === null) continue;
        const here = citeLines(cite, rel, lines, section, where, judgedHere);
        stats.blanks += here.blanks;
        // D204 — the cite offends against HEAD's copy of the file and is clean against this disk's copy of the
        // same path. That is a claim about a rewrite nobody has committed yet, and the gate has no authority
        // over it: the fix is that lane committing the file it holds dirty, not a re-aim that would break the
        // moment the rewrite lands. The exemption is self-limiting rather than a switch — if the two copies had
        // the same bytes, an offender here would be an offender there, so the pair below could not fire — and
        // on a clean checkout, including CI's, the two copies ARE the same file and the class is unreachable.
        let found = here.found;
        if (committed && found.length > 0) {
          const disk = fileText(rel, false);
          if (disk !== null && citeLines(cite, rel, disk, section, where, judgedHere).found.length === 0) {
            stats.uncommitted += 1;
            stats.uncommittedRows.push({ where, cite, rel, kinds: found.map((f) => f.kind),
              head: lines.length, disk: disk.length });
            found = [];
          }
        }
        for (const f of found) {
          if (f.kind === 'BLANK LINE') stats.judged += 1;
          stats.offenders.push(f);
        }
      }
    });
  }
  return stats;
}

/**
 * How many of the sections the disk plane holds are absent from the committed one. Counted by set difference
 * rather than by subtracting the two heading totals, because a supplied pair of planes can hold sections the
 * other does not in EITHER direction — `--head-dir` alone once printed "311 section(s) this run is writing"
 * about a two-section fixture, and `--dir` alone printed a negative count, both of which are the subtraction
 * being honest about two trees rather than about newness.
 */
const newSections = (work, head) => [...work.titles].filter((t) => !head.titles.has(t)).length;

/**
 * D191 — the committed plane is read in every mode except `--text`, `--worktree` included. The two census
 * calls below used to collapse into one object there (`const work = WORKTREE ? head : …`), which made
 * `newSections(work, head)` 0 by construction: the same tree printed `1 blank(s) among 25 new section(s)`
 * with exit 1 on the default plane and `0 blank(s) among 0 new section(s)` with exit 0 under `--worktree`,
 * so the rule D162 wrote could not fire on the one plane gate step 8 runs. A rule that cannot fire on the
 * plane the gate reads is not a rule the gate has.
 */
const committed = ARGS.text === null ? census(true, () => false) : null;
const isNewSection = (section) => committed !== null && !committed.titles.has(section);
// D162 — on either real-ledger plane the blank class judges exactly the sections this tree is writing: a
// `## ` heading that does not exist at HEAD. That subset has no backlog (every one of the 14 blanks D161
// counted sits inside a committed section), it cannot be an allow list because it is derived from the two
// planes the census already reads, and it is the same bargain step 12 spells out for its own disk plane — a
// row that only this run has written is this run to answer for, including when the writer is another lane.
const writesSection = (section) => BLANK_JUDGED || isNewSection(section);
// D203 — the untracked-target class takes the same bargain, minus what `--untracked-backlog` declares away.
const work = census(false, writesSection, (section) => !UNTRACKED_BACKLOG && writesSection(section));
/** The plane a verdict is written on: the working copy when this run is strict there, HEAD otherwise. */
const strict = WORKTREE ? work : committed;

// UNCHECKED comes before the vacuity guards: "I could not read the ledger" and "the ledger had nothing in
// it" are different failures, and a crash (the behaviour this replaced) said neither. Both planes are
// tested, because in the default mode the working copy is *reported*, and a report line that reads
// "0 citations, 0 offenders" for a file nobody opened is a clean verdict invented out of a missing read.
// D191 — and because in `--worktree` mode the committed read is now load-bearing: a HEAD this run cannot
// open would leave `committed.titles` holding nothing but the preamble, which makes every section on disk
// look brand new and turns D161's counted backlog into judged offenders.
const unread = [
  ...work.unread.map((u) => ({ ...u, plane: 'working copy' })),
  ...(committed === null ? [] : committed.unread.map((u) => ({ ...u, plane: 'HEAD' }))),
];
if (unread.length > 0) {
  console.log('NEXUS — ledger citation census');
  console.log(`  RESULT: UNCHECKED — ${unread.length} ledger read(s) failed across the ${LEDGERS.length} ledger file(s)`);
  for (const { ledger, reason, plane } of unread) console.log(`    ${plane} ${ledger}: ${reason}`);
  console.log('  Nothing is claimed about the citations in those files. Re-run where `git show` can spawn.');
  process.exit(2);
}

// D204 — the same shape as the guard above, aimed at the target reads: HEAD's tree says it holds the file,
// `git show` cannot print it, and a census that judged every line claim against nothing would report the
// cleanest verdict the gate has ever printed. `TRACKED === null` (git unusable) is in here too, because then
// nothing can certify which paths HEAD holds at all.
if (HEAD_FAILS.length > 0) {
  console.log('NEXUS — ledger citation census');
  console.log(`  RESULT: UNCHECKED — ${HEAD_FAILS.length} cited file(s) are named by HEAD's tree and could not be read from it`);
  for (const f of HEAD_FAILS) console.log(`    ${f.rel}: git show HEAD:${f.rel} failed — ${f.reason}`);
  console.log('  Nothing is claimed about the line numbers in those files. Re-run where `git show` can spawn.');
  process.exit(2);
}

// Non-vacuity, in the same spirit as D87's row-count guard: a scan that resolves nothing is not a green scan.
// These refuse (exit 2) rather than throw, and the difference is the whole point of D157's second half: a
// `throw` printed a stack trace and exit 1, which is the code this reader uses for "the ledgers name a file
// that is not there". A census that cannot certify its own input has said nothing about the citations, so the
// red code would have been a claim about the ledgers invented out of a broken run.
if (FILES.length < 100) notCheckable(`the source index holds ${FILES.length} files; a walk that finds almost nothing cannot check a citation`);
if (strict.sections === 0) notCheckable(`the census read ${LEDGERS.join(', ')} and saw no "## " heading — it did not read the ledger it claims to have censised`);
if (strict.citations === 0) notCheckable(`no citation-shaped token in ${strict.tokens} name:number tokens — either the classifier or the index broke, and a run that checks nothing is the reddest kind of green`);
if (strict.files.size === 0) notCheckable(`${strict.citations} citation(s) found and ${strict.files.size} file(s) resolved — the index cannot see any file the ledgers name`);
// D191 — the committed plane is a denominator now, not only a report. Measured against a supplied empty HEAD:
// a committed read that holds no section makes every disk section new, so D161's counted backlog becomes
// judged offenders and the run reddens on history it was never meant to answer for. `unread` above catches a
// HEAD nobody could open; this catches one that opened and held nothing.
if (committed !== null && committed.sections === 0) {
  notCheckable(`the committed plane holds ${committed.sections} "## " section(s) over ${committed.tokens} name:number token(s), so no section on disk could be called old — a blank in the backlog would be judged as if it were being written`);
}
// D203 — the same shape as the guard above, aimed at the new denominator: HEAD's tree read as empty would make
// every resolved cite an UNTRACKED TARGET, turning a broken `ls-tree` into the largest finding the gate has ever
// printed. A size-0 set is not "the repo has no files"; it is this run having asked git the wrong question.
if (TRACKED !== null && TRACKED.size === 0) {
  notCheckable(`git ls-tree HEAD returned 0 paths, so every citation this run resolves would be charged as pointing outside the tree — the census cannot ask git what the repository holds`);
}

console.log('NEXUS — every file:line citation in docs/DECISIONS.md and docs/STATUS.md, read back out of the source');
console.log(`  text censised            ${WORKTREE
  ? `the working copy (strict)${ARGS.text === null ? '; HEAD is read only to say which sections are new' : ' — a plant has no second plane'}`
  : 'HEAD (strict); the working copy is reported'}`);
console.log(`  blank-line cites         ${BLANK_JUDGED
  ? `${work.blanks} span start(s) on an empty line — every one is an offender on this plane`
  : `${committed.blanks} at HEAD (counted, not judged — D161's backlog) · ${work.judged} blank(s) among ${newSections(work, committed)} new section(s), and a blank there offends`}`);
// D203 — printed in every mode, including the ones where the class is disabled: a count that vanishes when the
// question cannot be asked is indistinguishable from a count of zero, which is the D192 disease in a new line.
console.log(`  untracked targets        ${TRACKED === null
  ? `UNCHECKED — ${TRACKED_REASON}; nothing is claimed about whether HEAD's tree holds the files these cites resolve to`
  : BLANK_JUDGED && UNTRACKED_BACKLOG
    ? `${work.untracked} of ${work.citations} citation(s) point at a file no commit holds — counted, not judged: --untracked-backlog declares this whole plane a backlog, and the fix belongs to the lane that wrote those files`
    : BLANK_JUDGED
    ? `${work.untracked} of ${work.citations} citation(s) point at a file no commit holds — every one is an offender on this plane`
    : `${committed.untracked} at HEAD (counted, not judged — the fix is \`git add\`, and it belongs to the lane that wrote the file) · ${work.untrackedJudged} among ${newSections(work, committed)} new section(s), and one there offends`}`);
// D204 — printed in every mode, for the reason D192 established for the line above: a count that disappears on
// the planes where the question cannot be asked is indistinguishable from a count of zero. `--text` has no
// committed plane, so the honest number there is 0 with its cause attached, not a silent omission.
console.log(`  uncommitted targets      ${committed === null
  ? '0 — this run reads a plant, and a plant has no second copy of a target to disagree with'
  : `${committed.uncommitted} of ${committed.citations} citation(s) point at a line this disk's copy of the file has and HEAD's copy does not — counted, not judged: the rewrite is the lane holding the file dirty, and where the two copies agree the class cannot fire`}`);
console.log(`  headings seen            ${strict.sections} section(s)${WORKTREE && committed !== null ? `, ${committed.sections} at HEAD` : ''} — an offender is attributed to the section that wrote it`);
console.log(`  name:number tokens       ${strict.tokens}`);
console.log(`  citation-shaped          ${strict.citations} (the rest are host:port, ENV:value, §NN or prose)`);
console.log(`  bare :NN continuations   ${strict.continuations} — they inherit the file before them, so nothing is judged on them alone`);
console.log(`  distinct files cited     ${strict.files.size}`);
// D192 — this number used to print only as the working-copy line below, and only when this run was NOT strict
// there. Step 9's belt (`check_comment_citations.mjs`) reads an offender count out of the report, and step 9
// always runs this reader in `--text` mode, where WORKTREE is true and that line is suppressed: the belt's
// regex matched 0 characters on every plane step 9 uses (measured: 0 on --text, 0 on --worktree, 1 on the
// default plane). A count with no carrier is not a check, so the strict plane's own number prints here, once,
// in every mode.
console.log(`  strict offenders         ${strict.offenders.length} offender(s) on the plane this run judges`);
if (!WORKTREE) {
  console.log(`  working copy citations   ${work.citations} in ${work.sections} section(s), ${work.offenders.length} offender(s)`);
}
console.log('');

if (VERBOSE) {
  console.log(`EVERY CITATION AND WHERE IT RESOLVED (${WORKTREE ? 'working copy' : 'HEAD'} text):`);
  for (const ledger of LEDGERS) {
    for (const line of (ledgerText(ledger, !WORKTREE).text ?? '').split(/\r?\n/)) {
      for (const cite of citeTokens(line)) {
        if (!isCitation(cite.name)) continue;
        const c = resolve(cite.name);
        console.log(`  ${cite.name}:${cite.spans.map((s) => s.join('-')).join(',')} -> `
          + (c.length === 1 ? c[0] : c.length === 0 ? 'NOT FOUND' : `${c.length} candidates`));
      }
    }
  }
  console.log('');
}

// D204 — the backlog rows are printed by name and by both line counts, because "counted, not judged" is only
// honest if the operator can see which file is mid-rewrite and how far apart the two copies are. A list that
// prints a total and no rows is how D157's exemption read.
if (committed !== null && committed.uncommitted > 0) {
  console.log(`UNCOMMITTED TARGETS — cites whose line exists only in this disk's rewrite (${committed.uncommitted}):`);
  for (const r of committed.uncommittedRows) {
    console.log(`  - ${r.where}  ${r.cite.name}:${r.cite.spans.map((s) => s.join('-')).join(',')} — ${r.kinds.join('/')} would fire here; `
      + `HEAD's copy of ${r.rel} has ${r.head} line(s) and this disk's has ${r.disk}, so the line is in an uncommitted edit`);
  }
  console.log('');
}

if (strict.offenders.length > 0) {
  console.log(`FALSE LEDGER CITATIONS (${strict.offenders.length}):`);
  const byKind = new Map();
  for (const o of strict.offenders) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
  for (const [kind, rows] of byKind) {
    console.log(`  ${kind} (${rows.length}):`);
    for (const r of rows) console.log(`    - ${r.where}  ${r.cite.name}:${r.cite.spans.map((s) => s.join('-')).join(',')} — ${r.detail}`);
  }
  console.log('');
} else {
  console.log('LEDGER CITATIONS — every citation-shaped token resolves to one file, by name, within its bounds.');
  console.log('');
}

// A blank line inside a section this run is writing IS strict: it is listed here and it reddens the exit
// code below, because that section has an author right now — D162's whole point being that the backlog of
// committed blanks is the only reason the class is not strict on the plane it reads.
if (!WORKTREE && work.judged > 0) {
  console.log(`FALSE LEDGER CITATIONS — BLANK LINE IN A NEW SECTION (${work.judged}):`);
  for (const o of work.offenders.filter((x) => x.kind === 'BLANK LINE')) {
    console.log(`    - ${o.where}  ${o.cite.name}:${o.cite.spans.map((s) => s.join('-')).join(',')} — ${o.detail}`);
  }
  console.log('');
}

// D203 — the same bargain, its own header: a target that exists only on this disk, cited by a section this run
// is writing. It prints separately from the blank class because the two corrections are different actions —
// one re-aims a number, the other commits a file — and a reader that merged them would report one reason for
// two fixes. An existing section citing an untracked file is counted in the line above and left standing: the
// file is another lane's, and `git add` over their boundary is not this gate's call.
if (!WORKTREE && work.untrackedJudged > 0) {
  console.log(`FALSE LEDGER CITATIONS — UNTRACKED TARGET IN A NEW SECTION (${work.untrackedJudged}):`);
  for (const o of work.offenders.filter((x) => x.kind === 'UNTRACKED TARGET')) {
    console.log(`    - ${o.where}  ${o.cite.name}:${o.cite.spans.map((s) => s.join('-')).join(',')} — ${o.detail}`);
  }
  console.log('');
}

if (!WORKTREE && work.offenders.some((o) => o.kind !== 'BLANK LINE' && o.kind !== 'UNTRACKED TARGET')) {
  console.log('The other working-copy offenders are not strict, so what prints above is what the NEXT commit');
  console.log('will inherit — they are another lane\'s unwritten paragraph or this lane\'s own draft, and a gate');
  console.log('that reddened on the first would be a gate two lanes could not run at the same time.');
  console.log('');
}

console.log('LIMITS, stated rather than implied: this checks that a cited file exists, is named uniquely, and');
console.log('has the line it cites. It cannot check that the line says what the sentence claims — a ledger');
console.log('citation has no row identifiers to compare against, unlike a quality.sql answer site (D87). It is');
console.log('blind to a misspelled extension (`Foo.jva:12` is not file-shaped) and to a name written without');
console.log('capitalisation or extension, and a file deleted later still resolves if its line number survives.');
console.log(`The directory exclusion is ${VENDOR_DIRS.size} names, shared with D87 through source_index.mjs —`);
console.log('one hand list rather than two, but still a hand list, which is what §84 residue (e) owns.');
console.log('The untracked-target class asks only whether HEAD holds the resolved path: it does not decide that a');
console.log('file SHOULD be committed, and it never reaches a cite into a skipped directory, because the index');
console.log('does not hold that path and FILE NOT FOUND speaks first. It cannot fire where git cannot be asked.');
console.log('`--untracked-backlog` exempts that one class on the plane it is given, and no other class: a caller');
console.log('that censuses a whole pre-existing plane cannot attribute a row to a writer, which is the sentence');
console.log('the counted-not-judged report line above carries.');
console.log('The line a cite points at is read from the plane being judged (D204): HEAD\'s own copy on the');
console.log('committed plane, this disk\'s on a worktree or a plant, so a HEAD-plane line number is the');
console.log('commit\'s rather than this machine\'s. Where the two copies disagree and the cite is clean only on');
console.log('the disk, the row is counted as an UNCOMMITTED TARGET instead of judged — it is a claim about a');
console.log('file somebody is still editing, and a gate that reddened on it would stay red until that lane');
console.log('committed, which is not this run\'s action to take. The class cannot fire on a plane with no');
console.log('second copy (a plant), nor on a clean checkout, where the two copies are the same bytes; a cite');
console.log('that offends on BOTH copies stays a strict offender here, which is what keeps it a backlog and');
console.log('not a mute.');
if (WORKTREE) {
  console.log('This run is strict on the WORKING COPY, so a citation in another lane\'s uncommitted paragraph');
  console.log('can redden it; the message names that file, section and line, and the claim goes to its owner.');
}

process.exit((strict.offenders.length > 0 || work.judged > 0 || work.untrackedJudged > 0) && !REPORT_ONLY ? 1 : 0);
