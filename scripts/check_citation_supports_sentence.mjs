#!/usr/bin/env node
/**
 * NEXUS — does a citation point at something that could support its sentence? A CENSUS, not a verdict.
 *
 * WHY THIS EXISTS, AND WHY IT IS THE THIRD READER ON THE SAME CITATIONS. The other two answer questions
 * that are checkable:
 *
 *   `check_ledger_citations.mjs`      does the cited file exist, is the name unique, is the line in range?
 *   `check_line_cite_drift.mjs`       is the text the citation was written against still at that line?
 *
 * Neither asks whether the line is *about* what the sentence says. §206 states the limit plainly ("it cannot
 * check that the line says what the sentence claims"), and this session hit the limit twice in one hour: a
 * citation to `falsifier_plants.py:NN` whose sentence names a marker the file does not contain, and a
 * `--reaim` that would have moved it to the marker-*validation* loop, making a visibly stale citation
 * invisibly wrong. Re-aiming launders; nothing checks meaning.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO. It does not read prose. It takes the **identifiers** in the
 * sentence a citation sits in — backticked spans, `snake_case`, `camelCase`, dotted names, SQL-ish tokens —
 * and asks whether the cited line's neighbourhood mentions **any** of them. A sentence about
 * `orphan: favorites.offering` cites a line that never says `favorites`; that is a mechanical fact and it is
 * the shape of the defect above.
 *
 * It is a CENSUS and exits 0 whatever it finds, because the proxy is weak in one direction and the report is
 * the deliverable:
 *
 *   - **zero shared identifiers** is a question, not a defect. A sentence may cite a line for its *position*
 *     in a narrative ("the third arm below") or for a value the neighbourhood does not spell.
 *   - **one or more shared identifiers** is not proof either — it is the same "consistent with, not proof of"
 *     standard `check_jsonb_reads.mjs` uses for its sites.
 *
 * So the output is a list of citations worth a human's minute, sorted by how little the neighbourhood shares.
 * A reader that cannot decide must not print a verdict, and this one cannot decide.
 *
 * `--list` is the reading copy of that list. The default output names each citation and the identifiers its
 * sentence wanted, but judging "does this line support this sentence" means reading two texts the default
 * never prints: the clause the citation is responsible for, and the line it cites. `--list` prints both, with
 * the ledger section each row sits in, for every sharing-nothing row — `--limit` does not truncate the list,
 * because the point of the mode is to be read whole.
 *
 * USAGE
 *   node scripts/check_citation_supports_sentence.mjs [--window N] [--ledger path] [--limit N] [--list]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { parseFlags } from './cli_args.mjs';

const ROOT = process.cwd();
const parsed = parseFlags(process.argv.slice(2), {
  '--window': { kind: 'value', unit: 'N lines around the cited line' },
  '--ledger': { kind: 'value', unit: 'path (default: both ledgers)' },
  '--limit': { kind: 'value', unit: 'N rows of the census to print' },
  '--list': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
});
if (!parsed.ok) {
  console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
  process.exit(2);
}
const WINDOW = Number(parsed.value['--window'] ?? 3);
const LIMIT = Number(parsed.value['--limit'] ?? 40);
const LEDGERS = parsed.value['--ledger'] ? [parsed.value['--ledger']] : ['docs/STATUS.md', 'docs/DECISIONS.md'];

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
// A fresh regex per use, never a shared global one. `CITE` was module-level and `g`-flagged, and the
// `clauseFor` call added to attribute identifiers to the nearest citation consumed its `lastIndex`, so the
// outer walk resumed mid-line: the census reported 418 citations where the same code had reported 159, and
// 263 of them "not at HEAD" because the paths it had matched were fragments. A global regex is state, and
// state shared between two readers of the same text is a bug that only shows up as a wrong number.
const citePattern = () => /([A-Za-z0-9_./-]+\.(?:java|py|ts|tsx|mjs|js|sql|sh|yml|yaml|json|md|txt)):(\d+)/g;

// The list mode prints prose; an unbounded clause would bury the row after it. Clipped, not skipped — a row
// that arrives already truncated still tells the reader where to open the ledger.
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Identifiers a span is about: the ones a code neighbourhood could plausibly spell.
 *
 * Every candidate is trimmed of the punctuation prose wraps around it. The first run kept a trailing hyphen
 * (`agent_runs.plan-`, from `agent_runs.plan-` inside a clause) and a trailing colon, which can never appear
 * in the neighbourhood it is compared against — a token that cannot match is a false positive by
 * construction, and 62 rows were measured with that noise in them.
 */
function identifiers(span) {
  const out = new Set();
  const clean = (w) => w.replace(/^[^A-Za-z_]+/, '').replace(/[^A-Za-z0-9_]+$/, '');
  for (const m of span.matchAll(/`([^`]+)`/g)) {
    for (const w of m[1].split(/[^A-Za-z0-9_.]+/)) {
      const t = clean(w);
      if (t.length >= 4) out.add(t);
    }
  }
  for (const m of span.matchAll(/\b[A-Za-z_][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g)) out.add(m[0]); // snake_case
  for (const m of span.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0]);            // camelCase
  for (const m of span.matchAll(/\b[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\b/g)) out.add(m[0]);    // dotted
  // Tokens that say nothing about what a line is for: prose connectives and file extensions.
  const NOISE = new Set(['this', 'that', 'with', 'from', 'into', 'line', 'lines', 'file', 'files', 'read', 'reads',
    'gate', 'ledger', 'status', 'docs', 'java', 'json', 'step', 'steps', 'test', 'tests', 'script', 'scripts']);
  return [...out].filter((w) => !NOISE.has(w.toLowerCase()) && w.length >= 4);
}

/**
 * The clause a citation introduces: the text between the previous citation in the sentence and this one.
 *
 * A sentence carrying two citations was judged twice against both, so a sentence naming `a.py` and `b.py`
 * charged each file with the other's identifiers — measured on the first run, where two rows cited
 * `docs/DATABASE.md:NN` and `.github/workflows/ci.yml:NN` with the identical 28-identifier list. What a
 * citation is responsible for is the clause that leads to it, not every clause in its paragraph.
 *
 * (D94: this comment *shows* the grammar, so its digits are `NN`. The first version wrote real numbers, and
 * `docs/DATABASE.md:NN` — an empty line — became a citation the ledger's own readers had to resolve. A
 * reader that illustrates its grammar with a live claim is a claim, and the plane that measures claims
 * measures it.)
 */
function clauseFor(lines, index) {
  const sentence = sentenceAt(lines, index);
  const here = lines[index];
  const at = sentence.indexOf(here.trim().slice(0, 40));
  const before = at > 0 ? sentence.slice(0, at) : sentence;
  const lastCite = [...before.matchAll(citePattern())].pop();
  const start = lastCite ? lastCite.index + lastCite[0].length : 0;
  // The span runs from the previous citation to the NEXT one, not to the end of the sentence. A claim about a
  // cited line is written on both sides of it — `MerchantService.java:NN passes principal.userId()` puts the
  // verb and the identifier AFTER the citation — and the first version took only what preceded it. Hand-checked
  // against a row this reader had flagged: the citation was exact, and the identifiers that "shared nothing"
  // came from the two lines of unrelated prose before it. Fixing the span is what stops the reader charging a
  // sentence with the previous sentence's subject.
  const after = sentence.slice(at > 0 ? at + here.trim().slice(0, 40).length : 0);
  const nextCite = after.match(citePattern());
  const end = nextCite ? sentence.length - after.length + nextCite.index : sentence.length;
  return sentence.slice(start, end);
}

/** The sentence a citation sits in: the run of non-empty lines around it, joined. */
function sentenceAt(lines, index) {
  let start = index;
  let end = index;
  const blank = (l) => l === undefined || l.trim() === '';
  while (start > 0 && !blank(lines[start - 1]) && !/^## /.test(lines[start - 1])) start -= 1;
  while (end + 1 < lines.length && !blank(lines[end + 1]) && !/^## /.test(lines[end + 1])) end += 1;
  return lines.slice(start, end + 1).join(' ');
}

/**
 * A basename -> path table, built from `git ls-files` and only when a citation needs it.
 *
 * About 262 of this reader's citations are written as a bare basename and were being skipped as "not at
 * HEAD" when the file is committed and perfectly readable. The gate's own step 8 resolves those, and names
 * AMBIGUOUS when two files share a name; this reader was not asking.
 *
 * `git ls-files` rather than a directory walk: what has to be resolved is whatever `git show HEAD:` can
 * serve, which is exactly the tracked set.
 *
 * **This feature was abandoned once, for the wrong reason.** Its first run was killed by a 240-second
 * timeout and the tool was reverted as "it hangs". Measured afterwards: the unmodified reader takes 4m07s,
 * so the timeout was simply shorter than the baseline. A tool that is slow and a tool that hangs look
 * identical to `timeout`, and only a stopwatch tells them apart.
 *
 * Only a **unique** hit is resolved: two files called `sql.py` is a citation to neither, and guessing would
 * charge a sentence with a neighbourhood it never named.
 */
let BY_BASENAME = null;
function basenameIndex() {
  if (BY_BASENAME) return BY_BASENAME;
  const map = new Map();
  try {
    for (const rel of git('ls-files').split('\n')) {
      if (!rel) continue;
      const base = rel.split('/').pop();
      const hits = map.get(base);
      if (hits) hits.push(rel);
      else map.set(base, [rel]);
    }
  } catch {
    // an unreadable tree leaves the index empty, and every basename stays unresolved rather than guessed
  }
  BY_BASENAME = map;
  return map;
}

const rows = [];
let citations = 0;
// The discriminator that settles a counting gap: the same pattern, scanned directly, with no walk in
// between. If this equals the loop's total the pattern is fine and the walk is losing matches; if it does
// not, the pattern the walk uses is not the pattern this file believes it uses. Printed, not reasoned about
// — two theories about this gap were already written into the log as wrong.
let direct = 0;
let basenameResolved = 0;
let ambiguousBasename = 0;
let unreadable = 0;
let unresolved = 0;
for (const ledger of LEDGERS) {
  let text;
  try {
    text = readFileSync(isAbsolute(ledger) ? ledger : join(ROOT, ledger), 'utf8');
  } catch {
    unreadable += 1;
    continue;
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) direct += [...line.matchAll(citePattern())].length;
  // The `## ` heading each citation sits under — the section a human reading `--list` output opens.
  let heading = '';
  lines.forEach((line, i) => {
    if (/^## /.test(line)) heading = line.replace(/^##\s+/, '').trim();
    for (const m of line.matchAll(citePattern())) {
      const [, path, numStr] = m;
      citations += 1;
      const num = Number(numStr);
      let target = null;
      let resolved = path;
      try {
        target = git('show', `HEAD:${path}`);
      } catch {
        target = null;
      }
      if (target === null && !path.includes('/')) {
        const hits = basenameIndex().get(path) ?? [];
        if (hits.length === 1) {
          resolved = hits[0];
          try { target = git('show', `HEAD:${resolved}`); } catch { target = null; }
          if (target !== null) basenameResolved += 1;
        } else if (hits.length > 1) {
          ambiguousBasename += 1;
        }
      }
      if (target === null) {
        unresolved += 1;
        continue; // not this reader's question: the other two already refuse it by name
        // `continue`, not `return`: the callback runs per LINE and the loop runs per MATCH, so `return`
        // ended the line and silently dropped every later citation on it. Measured: the same pattern
        // scanned directly found 470 matches where the walk counted 418, and the 52 were exactly the
        // citations that followed a `git show` failure on their own line. A reader that loses a fifth of
        // its population to its own control flow reports a smaller number, not a wrong one — which is the
        // hardest kind to notice.
      }
      const targetLines = target.replace(/\r\n/g, '\n').split('\n');
      const around = targetLines.slice(Math.max(0, num - 1 - WINDOW), num + WINDOW).join('\n');
      const clause = clauseFor(lines, i);
      const wanted = identifiers(clause);
      if (wanted.length === 0) continue; // a sentence with nothing mechanical in it cannot be judged here
      const shared = wanted.filter((w) => around.includes(w));
      rows.push({
        ledger: `${ledger}:${i + 1}`, cite: `${resolved}:${num}`, heading, clause,
        cited: (targetLines[num - 1] ?? '').trim(), wanted: wanted.length,
        shared: shared.length, missing: wanted.filter((w) => !shared.includes(w)).slice(0, 4),
      });
    }
  });
}

if (citations === 0) {
  console.log('RESULT: NOT CHECKED — no `file.ext:NNN` citation was found; the ledgers were not read');
  process.exit(2);
}

const worst = rows.filter((r) => r.shared === 0).sort((a, b) => b.wanted - a.wanted);
console.log('NEXUS — citations whose neighbourhood shares no identifier with their sentence (a census)');
console.log(`  citations seen           ${citations} over ${LEDGERS.join(', ')}`);
console.log(`  the same pattern, scanned directly   ${direct}${direct === citations ? '' : `  ← ${direct - citations} match(es) the walk did not count`}`);
console.log(`  judged (sentence had an identifier the file could spell)   ${rows.length}`);
console.log(`  skipped: target not at HEAD (the other readers own it)     ${unresolved}`);
if (unreadable > 0) console.log(`  ledgers unreadable       ${unreadable}`);
console.log(`  basenames resolved       ${basenameResolved} (bare name -> one committed file)`);
console.log(`  basenames ambiguous      ${ambiguousBasename} (two or more files share the name, not guessed)`);
console.log(`  window                   ±${WINDOW} line(s) around the cited line`);
console.log('');
console.log(`  sharing nothing          ${worst.length} of ${rows.length}`);
for (const r of worst.slice(0, LIMIT)) {
  console.log(`    ${r.ledger} -> ${r.cite}`);
  console.log(`      sentence names ${r.wanted} identifier(s); the neighbourhood has none of: ${r.missing.join(', ')}`);
}
if (worst.length > LIMIT) console.log(`    … ${worst.length - LIMIT} more (raise --limit)`);

if (parsed.flag['--list']) {
  console.log('');
  console.log(`  the sharing-nothing list, for a human   ${worst.length} row(s), read whole (--list ignores --limit)`);
  worst.forEach((r, k) => {
    console.log(`    [${k + 1}/${worst.length}] ${r.ledger}${r.heading ? ` in "${clip(r.heading, 72)}"` : ''} -> ${r.cite}`);
    console.log(`      clause : ${clip(r.clause.trim(), 200)}`);
    console.log(`      cited  : ${clip(r.cited, 160)}`);
    console.log(`      names none of: ${r.missing.join(', ')}`);
  });
}

console.log('');
console.log('RESULT: CENSUS — nothing was judged, deliberately.');
console.log('  Zero shared identifiers is a QUESTION, not a defect: a sentence may cite a line for its position in');
console.log('  a narrative, or for a value the neighbourhood does not spell. One shared identifier is not proof');
console.log('  either — "consistent with, not proof of", the standard the jsonb site census already uses. What');
console.log('  this list is for is the case measured on 2026-09-30: a sentence about `orphan: favorites.offering`');
console.log('  citing a file that never says `favorites`, where re-aiming would have laundered the citation green.');
