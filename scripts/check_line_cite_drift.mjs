#!/usr/bin/env node
/**
 * NEXUS — the ledger's line-number citations, asked whether the line they name is still the line that was named.
 *
 * WHY THIS EXISTS. `scripts/check_ledger_citations.mjs` (D88) asks four questions of a `File.ext:NNN` cite — does
 * the file exist, is the basename ambiguous, is NN past EOF, is the line blank — and every one of them is about
 * whether the cited line IS THERE. None of them is about whether it is the line the sentence was written against.
 * STATUS §203 named line 62 of `scripts/source_index.mjs` for the `VENDOR_DIRS` declaration standing at line 60
 * in the commit that wrote that sentence, and 0418b22 then added 19 lines above it: the pointed-at line still
 * exists and
 * still holds text, so PAST EOF and BLANK LINE both stay silent, and the strict census exempts a section that is
 * already committed (D162's newness predicate), so no reader on this plane could see it at all. That is a class,
 * not an incident — and this script is the reader for the class.
 *
 * THE TEST, AND WHY IT NEEDS NO GUESS ABOUT MEANING. For each citation: blame the ledger LINE that holds it — at
 * HEAD, the same plane its text is read from, because blaming the working copy dates an uncommitted line to no
 * commit at all and every citation on an edited line then escapes judgement (D577, and the arm that keeps it so) —
 * read the cited file at THAT commit and at HEAD, and compare the text of line NN.
 * Content equality is derivable from two refs; "does this sentence still describe that line" is not, so this
 * reader never asks it. It reports four states for the line the cite pointed at when it was written:
 *   EXACT       line NN at HEAD holds exactly the text line NN held when the citation was committed.
 *   MOVED       that text is in HEAD's file, at ONE line and no more. The target survived; the NUMBER is stale,
 *               and the new number is derivable — which is what makes this class re-aimable by a script.
 *   NOT-UNIQUE  the text moved but has no single new line: it was BLANK when the citation was written (so the
 *               cite never pointed at anything, whatever the number says), or HEAD holds it more than once (so
 *               `:NN` would be a guess about which occurrence was meant). Fixable, but only by reading the
 *               sentence, so the reader says the reason and stops short of naming a number.
 *   GONE        that text is nowhere in HEAD's file. The code was rewritten, reworded or removed since.
 *   NO-BASE     the file, or line NN inside it, did not exist at the commit that wrote the citation — the cite was
 *               committed against bytes that were not in the tree yet.
 *   UNPATHED    this reader resolves only paths spelled from the repository root. A bare basename
 *               (`EventService:88`) is counted and named, never judged: the shipped reader does basename lookup
 *               against the shared index and would judge more than this one does. A rooted path naming no file at
 *               HEAD is the sibling class NOT-AT-HEAD, which `check_ledger_citations.mjs` already refuses as
 *               FILE NOT FOUND.
 *
 * ONE SHAPE THE GRAMMAR SEES AND THIS READER DOES NOT JUDGE: a `file:LINE:COL` triple. That is how a runtime
 * spells "where it crashed", and a ledger quoting a stack trace inside a fenced block is reporting the plane
 * that crashed, not claiming where a declaration stands today. The `Error: spawnSync git EBUSY` frame quoted in
 * `docs/STATUS.md` is the case — the file moved underneath the quote months later, and the drift census filed it
 * as a stale citation of a comment line. Such tokens are counted, printed on their own line, and left out of the
 * judged population; a plane made of nothing but frames refuses rather than reporting a clean census.
 *
 * WHY GONE DOES NOT REDDEN BY DEFAULT, stated because it is a limit and not a preference. A cite to a COMMENT
 * line that was reworded — and still says what the sentence claims — lands in GONE exactly like a cite whose
 * target was deleted. The two are indistinguishable without reading meaning, so GONE is a queue for a human, while
 * `--strict MOVED,NOT-UNIQUE` is what a gate can carry: neither has a false positive of that kind, because in both
 * cases the text the cite pointed at is still in the file, which proves the sentence named real code.
 *
 * `--reaim` is the mode that makes MOVED cheap to clear: it prints one tab-separated line per stale citation —
 * site, file, old number, derived new number — and nothing else decides the numbers. The list comes out of the
 * same census as the verdicts, so a lane that moved code re-aims its own citations by applying the reader's own
 * rows instead of hunting line numbers by hand.
 *
 * WHAT THIS READER CANNOT SEE, printed rather than assumed. The citation grammar below is its own extension
 * list, so a cite into a file type the list does not name is not counted at all. `scripts/source_index.mjs`
 * declares the index's accepted extensions; the run prints the two vocabularies' difference, so the gap is a
 * measurement instead of a silence. `.md` cites (ledger-to-ledger) are deliberately outside the list: the drift
 * of a section number is a different question, censused by `check_status_citations.mjs`.
 *
 * NON-VACUITY. A census that resolved nothing refuses rather than reporting a clean plane: no citation matched,
 * no ledger line read, no blame author resolved, or nothing surviving both reads each end the run with
 * `RESULT: NOT CHECKED` and exit 2. The preflight printout for this gate first said "416 citations · at risk 0"
 * while its blame parser read no author at all (every line fell through a `if (!writer) continue`), which is
 * exactly the green that exit 2 is for.
 *
 * USAGE (parsed by `scripts/cli_args.mjs`, the shared flag parser — D158/D159)
 *   node scripts/check_line_cite_drift.mjs                      # census the committed ledgers, report mode
 *   node scripts/check_line_cite_drift.mjs --strict MOVED,NOT-UNIQUE   # exit 1 if a number is stale or aimable
 *   node scripts/check_line_cite_drift.mjs --reaim              # print the derived re-aim list, change nothing
 *   node scripts/check_line_cite_drift.mjs --limit 20           # detail rows per class (default 12)
 *   node scripts/check_line_cite_drift.mjs --repo <dir> --ledgers a.md,b.md   # another plane, for the arm harness
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './cli_args.mjs';
import { SOURCE_EXT } from './source_index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DEFAULT_LEDGERS = ['docs/STATUS.md', 'docs/DECISIONS.md'];
// The grammar's extension vocabulary is data, not a literal inside a regex: the disclosure line below asks the
// shared index whether each of these is an extension the repository's own census accepts.
const EXT_VOCAB = ['java', 'py', 'ts', 'tsx', 'mjs', 'cjs', 'js', 'sh', 'sql', 'yml', 'yaml'];
const CITE = new RegExp(`(?:^|[^\\w./-])([\\w.\\-/]+\\.(?:${EXT_VOCAB.join('|')})):(\\d+)\\b`, 'g');

// The classes a gate may refuse on. `main` checks each against the census's own `counts` keys, so renaming a
// class here without renaming it there stops the run instead of silently strict-ing on nothing.
export const STRICT_CLASSES = ['MOVED', 'NOT-UNIQUE', 'GONE'];

export const FLAGS = {
  '--repo': { kind: 'value', unit: 'directory' },
  '--ledgers': { kind: 'value', unit: 'file,file' },
  '--limit': { kind: 'value', unit: 'integer' },
  '--strict': { kind: 'value', unit: 'MOVED,NOT-UNIQUE,GONE' },
  '--reaim': { kind: 'switch' },
  '--resolve-basenames': { kind: 'switch' },
};

/** Blame `path` AT `rev` and return Map<lineNumber, commitSha>. Porcelain headers carry the line number and each
 *  text line starts with a tab; reading the author off the wrong half of the record is how the preflight produced
 *  its fake zero, so this walker binds the number from the header and the commit from the same iteration.
 *
 *  WHY THE REV IS ARGUED (D577). The census reads the ledger's text out of HEAD (`git show HEAD:<ledger>`), so the
 *  line numbers it holds are HEAD's. Blaming the working copy asks a different plane: `git blame <path>` with no rev
 *  dates an uncommitted line to the all-zero sha, and the all-zero sha resolves to no tree, so every citation
 *  sitting on a line somebody is editing fell to NO-BASE — which is not a judgement, it is a skipped one. Measured
 *  on a throwaway plane, and kept reproducible by the last arm of `scripts/falsify_line_cite_drift.mjs`: a
 *  committed ledger whose citation is stale reports `MOVED 1` and `--strict MOVED` exits 1 while the worktree is
 *  clean, and editing that same line ON DISK — no target moved, no commit made — reported `MOVED 0 · NO-BASE 1`
 *  and the same strict run exited 0. A green the editor can reach by typing is not a gate. Blaming HEAD makes
 *  basis and text one plane again; what the editor's own bytes represent is counted and printed instead of
 *  silently grading a plane that does not exist yet. */
export function blameByLine(git, path, rev = 'HEAD') {
  const map = new Map();
  let cur = null;
  let line = 0;
  for (const l of git('blame', '--line-porcelain', rev, '--', path).split(/\r?\n/)) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (h) { line = Number(h[2]); cur = h[1]; continue; }
    if (/^\t/.test(l) && cur) map.set(line, cur);
  }
  return map;
}

export function census({ repo, ledgers, limit, resolveBasenames = false }) {
  // stderr is dropped on purpose: `git show` writes a `fatal: path ... does not exist` for every citation into a
  // file that is not at this ref, which this reader has already classified. Left attached it printed 63 fatal
  // lines over a run whose own report says the same thing in three rows.
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  const blobCache = new Map();
  const linesAt = (ref, path) => {
    const k = `${ref}|${path}`;
    if (!blobCache.has(k)) {
      let text = null;
      try { text = git('show', `${ref}:${path}`); } catch { text = null; }
      blobCache.set(k, text === null ? null : text.replace(/\r\n/g, '\n').split('\n'));
    }
    return blobCache.get(k);
  };

  /**
   * Every path at HEAD, indexed by every suffix it has, so a citation written as a path *tail*
   * (`search/sql.py:137`) can be resolved instead of refused.
   *
   * WHY THIS EXISTS. The reader classified those as NOT-AT-HEAD and left them out of the judged
   * population, which is the honest thing to print but the wrong thing to conclude: measured on
   * 2026-09-30, all twelve of the sites it refused name files that exist at HEAD with the cited line
   * inside them (`apps/ai/nexus_ai/search/sql.py` is 520 lines and the citation asks for :137). The
   * verdict said "names no file at HEAD", which was true of `HEAD:search/sql.py` and false of the
   * citation. A reader that cannot judge a citation must say so — it did — but a reader that *can*
   * judge it and does not is a blind spot with a label on it.
   *
   * A suffix matching two or more files is NOT guessed at: it is counted as AMBIGUOUS and printed, so
   * the number of unjudged citations stays visible instead of being spent on a coin flip.
   */
  const suffixIndex = (() => {
    const index = new Map();
    let files = [];
    try {
      files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
    } catch {
      return index; // an unreadable tree leaves the index empty and every suffix refusal stands
    }
    for (const p of files) {
      const parts = p.split('/');
      for (let i = 0; i < parts.length; i += 1) {
        const suffix = parts.slice(i).join('/');
        const hits = index.get(suffix);
        if (hits) hits.push(p);
        else index.set(suffix, [p]);
      }
    }
    return index;
  })();

  const rows = [];
  const counts = { EXACT: 0, MOVED: 0, 'NOT-UNIQUE': 0, GONE: 0, 'NO-BASE': 0, UNPATHED: 0, 'NOT-AT-HEAD': 0, AMBIGUOUS: 0 };
  // Every MOVED citation, uncapped by `--limit`: this is the list `--reaim` prints and a capped list would let a
  // lane re-aim twelve citations and believe it had cleared twenty-four.
  const moves = [];
  // The same for the un-aimable half: a person has to choose among the candidate lines, so the candidates are
  // returned whole rather than as the truncated phrase the detail row prints.
  const unaimable = [];
  // The plane guard. `actions/checkout@v4` defaults to fetch-depth 1, and blame on a shallow clone attributes
  // every line to the grafted commit — the census would then read a whole ledger as written by one commit and
  // print a confident row of EXACTs. A plane this reader cannot date is refused, not guessed at.
  const shallow = (() => { try { return git('rev-parse', '--is-shallow-repository').trim() === 'true'; } catch { return false; } })();
  // The judged population is this list, and the printout below walks these keys, so the reader has one
  // vocabulary: a class added to `counts` is printed and censused without a sentence being retyped.
  const JUDGED = ['EXACT', 'MOVED', 'NOT-UNIQUE', 'GONE', 'NO-BASE'];
  const keep = (row) => { if (rows.filter((x) => x.verdict === row.verdict).length < limit) rows.push(row); };
  let total = 0;
  let frames = 0;
  let ledgerLines = 0;
  let blamed = 0;
  let noLedger = 0;
  let dirtyLines = 0;
  let absentLedgers = 0;

  for (const ledger of ledgers) {
    let headText;
    try { headText = git('show', `HEAD:${ledger}`); } catch { headText = null; }
    if (headText === null) { noLedger += 1; keep({ verdict: 'NO-BASE', site: ledger, detail: 'committed ledger unreadable on this plane' }); continue; }
    const map = blameByLine(git, ledger, 'HEAD');
    const lines = headText.replace(/\r\n/g, '\n').split('\n');
    // The editor's own bytes, counted rather than judged: they have no basis commit, so nothing here can say what
    // they will mean once committed. Printed as one number per run so a PASS cannot be read as a verdict on the
    // working copy — which is what this census's reader used to invite by blaming that copy and dating its lines
    // to no commit at all.
    let diskText = null;
    try { diskText = readFileSync(join(repo, ledger), 'utf8'); } catch { diskText = null; }
    if (diskText !== null) {
      const disk = diskText.replace(/\r\n/g, '\n').split('\n');
      for (let i = 0; i < Math.max(disk.length, lines.length); i += 1) if (disk[i] !== lines[i]) dirtyLines += 1;
    } else {
      absentLedgers += 1;
    }
    lines.forEach((l, i) => {
      const ln = i + 1;
      ledgerLines += 1;
      for (const m of l.matchAll(CITE)) {
        const [, file, numStr] = m;
        const num = Number(numStr);
        // A `file:LINE:COL` triple is a quoted error frame — the position a crash reported on the plane that
        // crashed — not a pointer into today's source, and no content test can age it. Counted, printed, and
        // left out of the judged population rather than dropped without a trace.
        if (/^:\d/.test(l.slice(m.index + m[0].length))) { frames += 1; continue; }
        total += 1;
        const writer = map.get(ln);
        if (!writer) { keep({ verdict: 'NO-BASE', site: `${ledger}:${ln}`, detail: `${file}:${num} has no blame author` }); continue; }
        blamed += 1;
        let atHead = linesAt('HEAD', file);
        let path = file;
        // `--resolve-basenames` widens the same suffix lookup to bare names. It is a switch and not the
        // default because refusing basenames is a decision this file states in its own header, and a reader
        // that silently changed its own population would be doing what this repository spends its ledgers
        // objecting to. What the switch buys is a measurement: how many of the UNPATHED citations would
        // resolve, and how many of those are MOVED or GONE rather than clean.
        if (atHead === null && (file.includes('/') || resolveBasenames)) {
          // Not a repo-relative path — try it as a tail before refusing it. `file` is kept for the message
          // because that is what the ledger wrote; `path` is what it resolves to.
          const hits = suffixIndex.get(file) ?? [];
          if (hits.length === 1) {
            path = hits[0];
            atHead = linesAt('HEAD', path);
          } else if (hits.length > 1) {
            counts.AMBIGUOUS += 1;
            keep({ verdict: 'AMBIGUOUS', site: `${ledger}:${ln}`, detail: `${file}:${num} matches ${hits.length} files at HEAD (${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ', …' : ''}) — not judged, and not guessed` });
            continue;
          }
        }
        if (atHead === null) {
          const basenameOnly = !file.includes('/');
          const v = basenameOnly ? 'UNPATHED' : 'NOT-AT-HEAD';
          counts[v] += 1;
          // Two different reasons wear the same verdict, and they call for different work. A path that is
          // absent everywhere is a stale citation. A path that exists in the working copy but not at HEAD
          // is a citation into **uncommitted code**: resolvable on this machine and unresolvable from a
          // clean checkout, which is the same objection D113 made to a witness kept outside the repo. The
          // reader can tell them apart — it just has to look at the working tree as well as at HEAD.
          const inWorktreeOnly = !basenameOnly && existsSync(join(repo, file));
          keep({
            verdict: v,
            site: `${ledger}:${ln}`,
            detail: basenameOnly
              ? `${file}:${num} is a basename, which this reader will not resolve`
              : inWorktreeOnly
                ? `${file}:${num} is not tracked at HEAD — the file exists in the working copy only, so a clean checkout cannot resolve this citation`
                : `${file}:${num} names no file at HEAD — step 8's FILE NOT FOUND, not judged twice`,
          });
          continue;
        }
        const atWriter = linesAt(writer, path);
        const target = atHead[num - 1];
        if (atWriter === null || atWriter[num - 1] === undefined) {
          counts['NO-BASE'] += 1;
          keep({ verdict: 'NO-BASE', site: `${ledger}:${ln}`, detail: `${file}:${num} absent at ${writer.slice(0, 7)}, the commit that wrote the citing line` });
          continue;
        }
        const written = atWriter[num - 1];
        if (written === target) { counts.EXACT += 1; continue; }
        // MOVED promises a NUMBER, so the number must be derivable: exactly one line of HEAD's file holds the
        // text the citation pointed at. A line that was BLANK when the cite was written has no text to find
        // anywhere, and text the file holds more than once has no single new position — naming one of them would
        // be this reader guessing which occurrence the sentence meant. Those are NOT-UNIQUE.
        const matches = atHead.reduce((a, l2, i) => (l2 === written ? [...a, i + 1] : a), []);
        if (written.trim() === '' || matches.length > 1) {
          counts['NOT-UNIQUE'] += 1;
          unaimable.push({ site: `${ledger}:${ln}`, ledger, ln, file, from: num, matches, written, now: target });
          const reason = written.trim() === ''
            ? `named a blank line when it was written, so it never pointed at text`
            : `${matches.length} lines at HEAD hold it (${matches.slice(0, 8).join(', ')}${matches.length > 8 ? ', …' : ''})`;
          keep({ verdict: 'NOT-UNIQUE', site: `${ledger}:${ln}`, detail: `${file}:${num} ${reason} · text ${JSON.stringify(written.trim().slice(0, 30))} · holds ${String(target).trim().slice(0, 40)}` });
          continue;
        }
        if (matches.length === 0) {
          counts.GONE += 1;
          keep({ verdict: 'GONE', site: `${ledger}:${ln}`, detail: `${file}:${num} held ${written.trim().slice(0, 44)} · holds ${String(target).trim().slice(0, 44)}` });
          continue;
        }
        const found = matches[0];
        counts.MOVED += 1;
        moves.push({ site: `${ledger}:${ln}`, ledger, ln, file, from: num, to: found });
        keep({ verdict: 'MOVED', site: `${ledger}:${ln}`, detail: `${file}:${num} -> :${found} (${found - num >= 0 ? '+' : ''}${found - num}) ${written.trim().slice(0, 58)}` });
      }
    });
  }

  const judged = JUDGED.reduce((a, c) => a + counts[c], 0);
  const floors = [];
  if (shallow) floors.push('this clone is shallow, so blame dates every line to the grafted commit and no verdict would be about the commit that wrote it — fetch the full history (fetch-depth: 0)');
  if (noLedger === ledgers.length) floors.push(`none of the ${ledgers.length} ledger file(s) is readable at HEAD on this plane`);
  if (total === 0 && frames === 0) floors.push('the census matched no citation-shaped token in the ledger text it read');
  if (total === 0 && frames > 0) floors.push(`every citation-shaped token on this plane is a quoted error frame (file:LINE:COL) — ${frames} of them, and a crash position is not a claim about today's line numbering`);
  if (ledgerLines === 0) floors.push('the census read no ledger lines');
  if (blamed === 0 && total > 0) floors.push('the census resolved no blame author for any citation — it read nothing');
  if (judged === 0) floors.push('no citation survived both reads, so the content test judged nothing');
  return { counts, rows, moves, unaimable, total, frames, blamed, ledgerLines, dirtyLines, absentLedgers,
    judged, judgedClasses: JUDGED, floors };
}

export function main(argv) {
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) {
    console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
    return 2;
  }
  const ledgers = (parsed.value['--ledgers'] ?? DEFAULT_LEDGERS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Number(parsed.value['--limit'] ?? '12');
  const strictRaw = parsed.value['--strict'] ?? 'none';
  const reaim = Boolean(parsed.flag['--reaim']);
  if (ledgers.length === 0) { console.log('RESULT: NOT CHECKED — --ledgers resolved to an empty list, so the census would read no text'); return 2; }
  if (!Number.isInteger(limit) || limit < 0) { console.log(`RESULT: NOT CHECKED — --limit ${limit} is not a non-negative integer`); return 2; }
  const strict = strictRaw === 'none' ? [] : strictRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = strict.filter((c) => !STRICT_CLASSES.includes(c));
  if (unknown.length) { console.log(`RESULT: NOT CHECKED — --strict ${unknown.join(',')} names no class this reader can refuse on (${STRICT_CLASSES.join(', ')})`); return 2; }
  if (reaim && strict.length) { console.log('RESULT: NOT CHECKED — --reaim prints a derived list and passes no verdict, so it does not combine with --strict'); return 2; }

  const r = census({ repo: parsed.value['--repo'] ?? REPO, ledgers, limit,
    resolveBasenames: Boolean(parsed.flag['--resolve-basenames']) });
  // The refusal vocabulary is one list; the classes the census actually emits are another. If they ever stop
  // agreeing, the run stops — a `--strict` aimed at a class the reader no longer counts would else PASS forever.
  const unemitted = STRICT_CLASSES.filter((c) => !(c in r.counts));
  if (unemitted.length) { console.log(`RESULT: NOT CHECKED — STRICT_CLASSES names ${unemitted.join(', ')} which this census does not emit`); return 2; }
  console.log(`ledger lines read: ${r.ledgerLines} · citation-shaped tokens into code: ${r.total} · blamed: ${r.blamed}`);
  console.log(`quoted error frames skipped (file:LINE:COL): ${r.frames}`);
  // The plane this census graded, stated. D577: before the basis was pinned to HEAD, an uncommitted edit to a
  // citing line was dated to the all-zero sha and skipped as NO-BASE, so a lane re-aiming a stale number saw
  // `MOVED 0` and a PASS on the very class it was supposed to clear. The count below is the disclosure half of
  // that fix: it says how much of this machine's ledger is not in the reading above.
  console.log(`ledger lines differing between disk and HEAD: ${r.dirtyLines} (the census grades HEAD's copy, so a number edited on disk is not judged until it is committed)`
    + (r.absentLedgers ? ` — and ${r.absentLedgers} of the ${ledgers.length} ledger(s) named here have no disk copy on this plane, so their divergence is unknown rather than zero` : ''));
  // One line per class, walked off the census's own `counts` object: a prose sentence that carries a digit
  // (`step 8's class`) was read as that digit by the first version of the arm harness, and a machine-parseable
  // line has no such collision.
  for (const [k, v] of Object.entries(r.counts)) console.log(`verdict ${k}: ${v}`);
  console.log(`judged by content: ${r.judged}`);
  // The line above is parsed by an arm harness on the exact regex `^judged by content: (\d+)$`, so it keeps
  // its shape. What it does NOT say is which classes it counts, and one of them is not a content judgement at
  // all: `JUDGED` is ['EXACT','MOVED','NOT-UNIQUE','GONE','NO-BASE'], and NO-BASE means the citation has no
  // blame author — reached, not judged. Measured twice rather than reasoned: with NO-BASE at 13 the printed
  // total exceeded the content classes by 13, and with it at 1 the excess is 1. Naming the members costs a
  // line and stops the label from claiming something the arithmetic contradicts. It reads the list off the
  // census's own return value rather than the module scope: `JUDGED` lives inside `census()`, and the first
  // version of this line named it from outside, which threw ReferenceError and took the reader down with no
  // RESULT line at all. A reader that dies to add a clarifying sentence is worse than the unclear sentence.
  console.log(`  judged classes: ${r.judgedClasses.join(' + ')} — NO-BASE has no blame author, so it is reached rather than judged`);
  const notInIndex = EXT_VOCAB.filter((e) => !SOURCE_EXT.test(`x.${e}`));
  console.log(`extensions this grammar judges that scripts/source_index.mjs SOURCE_EXT does not accept: ${notInIndex.join(', ') || '(none)'}`);
  // EXACT has no rows by definition, so the detail sections are every other class the census declared.
  for (const v of Object.keys(r.counts).filter((k) => k !== 'EXACT')) {
    const sel = r.rows.filter((x) => x.verdict === v);
    if (sel.length) {
      const hidden = r.counts[v] > sel.length ? ` of ${r.counts[v]}` : '';
      console.log(`\n${v} — ${sel.length}${hidden} site(s):`);
      for (const x of sel) console.log(`  ${x.site} -> ${x.detail}`);
    }
  }
  if (r.floors.length) {
    console.log(`\nRESULT: NOT CHECKED — ${r.floors.join(' · ')}`);
    return 2;
  }
  if (reaim) {
    for (const m of r.moves) console.log(`reaim\t${m.site}\t${m.file}\t${m.from}\t${m.to}`);
    console.log(`\nRESULT: REAIM — ${r.moves.length} derived re-aim row(s), from the ${r.counts.MOVED} MOVED citation(s) on this plane (NOT-UNIQUE has no number to give)`);
    return 0;
  }
  const hits = strict.filter((c) => r.counts[c] > 0);
  if (hits.length) {
    console.log(`\nRESULT: FAIL — --strict ${strictRaw} on ${hits.map((c) => `${c} ${r.counts[c]}`).join(' + ')} of ${r.judged} judged citation(s)`);
    return 1;
  }
  if (!strict.length) {
    console.log(`\nRESULT: REPORT — ${r.counts.EXACT}/${r.judged} citations still name the line they were written against (strict=none)`);
    return 0;
  }
  console.log(`\nRESULT: PASS — --strict ${strictRaw} clean on ${r.judged} judged citation(s); ${r.counts.EXACT} still name the line they were written against`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
