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
 *   EXACT     line NN at HEAD holds exactly the text line NN held when the citation was committed.
 *   MOVED     that text is in HEAD's file, at a different line. The target survived; the NUMBER is stale.
 *   GONE      that text is nowhere in HEAD's file. The code was rewritten, reworded or removed since.
 *   NO-BASE   the file, or line NN inside it, did not exist at the commit that wrote the citation — the cite was
 *             committed against bytes that were not in the tree yet.
 *   UNPATHED  this reader resolves only paths spelled from the repository root. A bare basename (`EventService:88`)
 *             is counted and named, never judged: the shipped reader does basename lookup against the shared
 *             index and would judge more than this one does. A rooted path naming no file at HEAD is the sibling
 *             class NOT-AT-HEAD, which `check_ledger_citations.mjs` already refuses as FILE NOT FOUND.
 *
 * WHY GONE DOES NOT REDDEN BY DEFAULT, stated because it is a limit and not a preference. A cite to a COMMENT
 * line that was reworded — and still says what the sentence claims — lands in GONE exactly like a cite whose
 * target was deleted. The two are indistinguishable without reading meaning, so GONE is a queue for a human, while
 * `--strict=MOVED` is a flag a gate can carry: MOVED has no false positive of that kind, because the text the cite
 * pointed at is present in the file, which proves the sentence named real code and the code has since moved.
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
 *   node scripts/check_line_cite_drift.mjs --strict MOVED       # exit 1 if any citation's line number is stale
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

export const FLAGS = {
  '--repo': { kind: 'value', unit: 'directory' },
  '--ledgers': { kind: 'value', unit: 'file,file' },
  '--limit': { kind: 'value', unit: 'integer' },
  '--strict': { kind: 'value', unit: 'MOVED|GONE' },
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
  const counts = { EXACT: 0, MOVED: 0, GONE: 0, 'NO-BASE': 0, UNPATHED: 0, 'NOT-AT-HEAD': 0 };
  // The plane guard. `actions/checkout@v4` defaults to fetch-depth 1, and blame on a shallow clone attributes
  // every line to the grafted commit — the census would then read a whole ledger as written by one commit and
  // print a confident row of EXACTs. A plane this reader cannot date is refused, not guessed at.
  const shallow = (() => { try { return git('rev-parse', '--is-shallow-repository').trim() === 'true'; } catch { return false; } })();
  // The judged population is this list, and the printout below walks these keys, so the reader has one
  // vocabulary: a class added to `counts` is printed and censused without a sentence being retyped.
  const JUDGED = ['EXACT', 'MOVED', 'GONE', 'NO-BASE'];
  const keep = (row) => { if (rows.filter((x) => x.verdict === row.verdict).length < limit) rows.push(row); };
  let total = 0;
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
        const found = atHead.findIndex((l2) => l2 === written);
        if (found >= 0) {
          counts.MOVED += 1;
          keep({ verdict: 'MOVED', site: `${ledger}:${ln}`, detail: `${file}:${num} -> :${found + 1} (${found + 1 - num >= 0 ? '+' : ''}${found + 1 - num}) ${written.trim().slice(0, 58)}` });
        } else {
          counts.GONE += 1;
          keep({ verdict: 'GONE', site: `${ledger}:${ln}`, detail: `${file}:${num} held ${written.trim().slice(0, 44)} · holds ${String(target).trim().slice(0, 44)}` });
        }
      }
    });
  }

  const judged = JUDGED.reduce((a, c) => a + counts[c], 0);
  const floors = [];
  if (shallow) floors.push('this clone is shallow, so blame dates every line to the grafted commit and no verdict would be about the commit that wrote it — fetch the full history (fetch-depth: 0)');
  if (noLedger === ledgers.length) floors.push(`none of the ${ledgers.length} ledger file(s) is readable at HEAD on this plane`);
  if (total === 0) floors.push('the census matched no citation-shaped token in the ledger text it read');
  if (ledgerLines === 0) floors.push('the census read no ledger lines');
  if (blamed === 0) floors.push('the census resolved no blame author for any citation — it read nothing');
  if (judged === 0) floors.push('no citation survived both reads, so the content test judged nothing');
  return { counts, rows, total, blamed, ledgerLines, judged, floors };
}

export function main(argv) {
  const parsed = parseFlags(argv, FLAGS);
  if (!parsed.ok) {
    console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
    return 2;
  }
  const ledgers = (parsed.value['--ledgers'] ?? DEFAULT_LEDGERS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Number(parsed.value['--limit'] ?? '12');
  const strict = parsed.value['--strict'] ?? 'none';
  if (ledgers.length === 0) { console.log('RESULT: NOT CHECKED — --ledgers resolved to an empty list, so the census would read no text'); return 2; }
  if (!Number.isInteger(limit) || limit < 0) { console.log(`RESULT: NOT CHECKED — --limit ${limit} is not a non-negative integer`); return 2; }
  if (strict !== 'none' && !(strict in { MOVED: 1, GONE: 1 })) { console.log(`RESULT: NOT CHECKED — --strict ${strict} names no class this reader emits (MOVED, GONE)`); return 2; }

  const r = census({ repo: parsed.value['--repo'] ?? REPO, ledgers, limit });
  console.log(`ledger lines read: ${r.ledgerLines} · citation-shaped tokens into code: ${r.total} · blamed: ${r.blamed}`);
  // One line per class, walked off the census's own `counts` object: a prose sentence that carries a digit
  // (`step 8's class`) was read as that digit by the first version of the arm harness, and a machine-parseable
  // line has no such collision.
  for (const [k, v] of Object.entries(r.counts)) console.log(`verdict ${k}: ${v}`);
  console.log(`judged by content: ${r.judged}`);
  const notInIndex = EXT_VOCAB.filter((e) => !SOURCE_EXT.test(`x.${e}`));
  console.log(`extensions this grammar judges that scripts/source_index.mjs SOURCE_EXT does not accept: ${notInIndex.join(', ') || '(none)'}`);
  for (const v of ['MOVED', 'GONE', 'NO-BASE', 'UNPATHED', 'NOT-AT-HEAD']) {
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
  if (strict !== 'none' && r.counts[strict] > 0) {
    console.log(`\nRESULT: FAIL — --strict=${strict} on ${r.counts[strict]} of ${r.judged} judged citation(s)`);
    return 1;
  }
  console.log(`\nRESULT: ${strict === 'none' ? 'REPORT' : 'PASS'} — ${r.counts.EXACT}/${r.judged} citations still name the line they were written against (strict=${strict})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
