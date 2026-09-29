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
 * THE TEST, AND WHY IT NEEDS NO GUESS ABOUT MEANING. For each citation: blame the ledger LINE that holds it to
 * the commit that wrote it, read the cited file at THAT commit and at HEAD, and compare the text of line NN.
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
};

/** Blame `path` and return Map<lineNumber, commitSha>. Porcelain headers carry the line number and each text
 *  line starts with a tab; reading the author off the wrong half of the record is how the preflight produced its
 *  fake zero, so this walker binds the number from the header and the commit from the same iteration. */
export function blameByLine(git, path) {
  const map = new Map();
  let cur = null;
  let line = 0;
  for (const l of git('blame', '--line-porcelain', path).split(/\r?\n/)) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (h) { line = Number(h[2]); cur = h[1]; continue; }
    if (/^\t/.test(l) && cur) map.set(line, cur);
  }
  return map;
}

export function census({ repo, ledgers, limit }) {
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

  const rows = [];
  const counts = { EXACT: 0, MOVED: 0, 'NOT-UNIQUE': 0, GONE: 0, 'NO-BASE': 0, UNPATHED: 0, 'NOT-AT-HEAD': 0 };
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

  for (const ledger of ledgers) {
    let headText;
    try { headText = git('show', `HEAD:${ledger}`); } catch { headText = null; }
    if (headText === null) { noLedger += 1; keep({ verdict: 'NO-BASE', site: ledger, detail: 'committed ledger unreadable on this plane' }); continue; }
    const map = blameByLine(git, ledger);
    const lines = headText.replace(/\r\n/g, '\n').split('\n');
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
        const atHead = linesAt('HEAD', file);
        if (atHead === null) {
          const basenameOnly = !file.includes('/');
          const v = basenameOnly ? 'UNPATHED' : 'NOT-AT-HEAD';
          counts[v] += 1;
          keep({ verdict: v, site: `${ledger}:${ln}`, detail: basenameOnly ? `${file}:${num} is a basename, which this reader will not resolve` : `${file}:${num} names no file at HEAD — step 8's FILE NOT FOUND, not judged twice` });
          continue;
        }
        const atWriter = linesAt(writer, file);
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
  return { counts, rows, moves, unaimable, total, frames, blamed, ledgerLines, judged, floors };
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

  const r = census({ repo: parsed.value['--repo'] ?? REPO, ledgers, limit });
  // The refusal vocabulary is one list; the classes the census actually emits are another. If they ever stop
  // agreeing, the run stops — a `--strict` aimed at a class the reader no longer counts would else PASS forever.
  const unemitted = STRICT_CLASSES.filter((c) => !(c in r.counts));
  if (unemitted.length) { console.log(`RESULT: NOT CHECKED — STRICT_CLASSES names ${unemitted.join(', ')} which this census does not emit`); return 2; }
  console.log(`ledger lines read: ${r.ledgerLines} · citation-shaped tokens into code: ${r.total} · blamed: ${r.blamed}`);
  console.log(`quoted error frames skipped (file:LINE:COL): ${r.frames}`);
  // One line per class, walked off the census's own `counts` object: a prose sentence that carries a digit
  // (`step 8's class`) was read as that digit by the first version of the arm harness, and a machine-parseable
  // line has no such collision.
  for (const [k, v] of Object.entries(r.counts)) console.log(`verdict ${k}: ${v}`);
  console.log(`judged by content: ${r.judged}`);
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
