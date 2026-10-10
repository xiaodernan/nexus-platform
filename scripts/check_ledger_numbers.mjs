#!/usr/bin/env node
/**
 * NEXUS — the ledger's numeric claims, and whether the newest one is still true (task #126).
 *
 * WHY THIS EXISTS. `check_line_cite_drift.mjs` judges a `file:line` citation by asking whether the text it
 * was written against is still at that line. This is the same reader aimed at **figures instead of
 * positions**: the ledger says "216 quality checks" 120 times, "8 arms" 26 times, "22 files" 21 times, and
 * nothing links any of those numbers to the thing that produces them. When a check is added, the number
 * moves and 120 sentences go quietly stale — the failure mode this repository has already been bitten by in
 * three other shapes (a declared jsonb read whose key stopped shipping, a route no service serves, a
 * citation aimed at a line that no longer holds its text).
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO. The ledger is append-only, so **it legitimately contains more
 * than one value for the same noun**: a section written when the gate filed 215 checks says 215, and that
 * sentence is not wrong, it is dated. A checker that flagged every disagreement would be red forever and
 * would teach its reader to ignore it. So this tool:
 *
 *   1. prints a census — per noun, every distinct value, how many times each appears, and which section of
 *      which ledger carries the **newest** one. That is the sentence a reader has to trust today;
 *   2. judges exactly one thing, and only when told what to judge against: whether the newest claim for a
 *      noun matches an expectation passed in. With no expectation it prints `UNCHECKED` and exits 2 —
 *      "I have no idea what the right number is" and "the number is right" must not print the same way.
 *
 * WHAT IT CANNOT DO. It reads numbers, not meanings: `4 rows` is counted for the noun `rows` and this tool
 * cannot tell whether the four rows are the ones the sentence meant. It also cannot see a claim whose noun
 * it does not know, and it will not guess one — an unknown noun is reported as unknown rather than filed
 * under the nearest match.
 *
 * USAGE
 *   node scripts/check_ledger_numbers.mjs                        # census, UNCHECKED, exit 2
 *   node scripts/check_ledger_numbers.mjs --expect "quality checks=216" --expect "arms=8"
 *   node scripts/check_ledger_numbers.mjs --expect-file numbers.json
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { parseFlags } from './cli_args.mjs';

const ROOT = process.cwd();
// STATUS last on purpose: "newest" means the newest *section*, and STATUS is the ledger of record for
// where the build stands. Reading DECISIONS second made its last incidental mention of a noun win — the
// first run of this tool reported `checks newest 8 (docs/DECISIONS.md:NN)`, which is a number in a
// sentence about something else, not the newest claim about checks.
const LEDGERS = ['docs/DECISIONS.md', 'docs/STATUS.md'];

/** The nouns this reader knows, and the artefact that would answer for each if it could be read here. */
const NOUNS = {
  'quality checks': 'the gate’s own printout (scripts/db_gate_fresh.sh)',
  checks: 'the gate’s own printout',
  assertions: 'the gate’s own printout',
  plants: 'the plant tuples in data/seed/falsifier_plants.py',
  arms: 'the arms in the falsifier harnesses',
  cases: 'the cases in a harness’s own run',
  steps: 'the steps of scripts/db_gate_fresh.sh',
  sites: 'a reader’s own count (citation drift, jsonb census, …)',
  citations: 'a reader’s own count',
  files: 'a reader’s own corpus size',
  rows: 'the database, or a census’s own count',
};

// One parser for every reader that takes flags (D158), so `--expect x` and `--expect=x` cannot disagree.
// `--expect` is comma-separated rather than repeatable because the parser refuses a value flag given twice,
// and a second spelling of "give me two expectations" is how two dialects start.
const parsed = parseFlags(process.argv.slice(2), {
  '--expect': { kind: 'value', unit: 'noun=value[,noun=value…]' },
  '--expect-file': { kind: 'value', unit: 'path' },
  '--gate-log': { kind: 'value', unit: 'path' },
  '--census': { kind: 'switch' },
  '--top': { kind: 'value', unit: 'N' },
});
if (!parsed.ok) {
  console.log(`RESULT: NOT CHECKED — ${parsed.reason}`);
  process.exit(2);
}
const optValue = parsed.value ?? {};
const optFlag = parsed.flag ?? {};

/**
 * The numbers these ledgers write as words, because a digits-only reader misses them.
 *
 * Measured before writing this: `two arms` 30 times, `two rows` 29, `two files` 26, `three rows` 22,
 * `eleven steps` 10, `seven steps` 8, `twenty-seven files` 2, `forty-four citations` 2, `fifty-eight
 * tables` 2 — roughly 200 claims the reader was not seeing. §61 says "the schema has **25**, and the
 * seeded dataset writes **five** of them", which is a claim about this repository written in words.
 *
 * Compounds are `twenty-seven` and `twenty seven`; there is no `one hundred and` form in these ledgers,
 * and a form the map does not know is not counted rather than guessed at.
 */
const ONES = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const TEENS = ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const WORDS = new Map();
ONES.forEach((w, i) => WORDS.set(w, i + 1));
TEENS.forEach((w, i) => WORDS.set(w, i + 10));
TENS.forEach((w, i) => WORDS.set(w, (i + 2) * 10));
// The hundred-compound is measured, not speculative (2026-10-11): seven claims in unfenced prose —
// `two hundred sixteen rows` (the standing assertion count, read as sixteen before this), `one hundred
// forty-seven citations` (read as forty-seven), `four hundred forty-four citations` (read as forty-four)
// — every one mis-valued by the bare-word form. The compound is a multiplier, an optional remainder and
// nothing else: no `and`, no thousands, no `hundred hundred`. A form outside the map stays uncounted.
// The optional remainder after a hundred: `two hundred sixteen`, `hundred forty-four`.
const hundredRemainder =
  `(?:\\s+(?:(?:${[...TENS].join('|')})[-\\s](?:${ONES.join('|')})|(?:${[...TEENS, ...TENS].join('|')})|(?:${ONES.join('|')})))?`;
const wordNumber =
  `(?:${[...ONES, ...TEENS, ...TENS].join('|')})\\s+hundred${hundredRemainder}` +
  `|(?:${[...TENS].join('|')})[-\\s](?:${ONES.join('|')})` +
  `|(?:${[...TEENS, ...TENS].join('|')})` +
  `|hundred${hundredRemainder}`;

function numberOf(raw) {
  const text = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^\d/.test(text)) return Number(text.replace(/,/g, ''));
  const words = text.split(/[\s-]+/).filter(Boolean);
  let total = 0;
  let pending = 0;
  let afterHundred = false;
  for (const w of words) {
    if (w === 'hundred') {
      pending = (pending || 1) * 100;
      afterHundred = true;
      continue;
    }
    const v = WORDS.get(w);
    if (v === undefined) return NaN;
    if (afterHundred) {
      pending += v; // `hundred forty-four` = 144, `hundred sixteen` = 116
      afterHundred = false;
      continue;
    }
    if (pending === 0) {
      pending = v; // the first word: `forty-` of `forty-four`, `two` of `two hundred`
      continue;
    }
    if (pending >= 20 && pending % 10 === 0 && v < 10) {
      pending += v; // the `-four` of `forty-four`
      continue;
    }
    return NaN; // a sequence the map does not compose is refused, not summed blind
  }
  return pending + total === 0 ? NaN : pending + total;
}

const nounPattern = Object.keys(NOUNS)
  .sort((a, b) => b.length - a.length) // longest first: `quality checks` must win over `checks`
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
// One hyphenated modifier may sit between the number and the noun — `eleven legal-write arms`,
// `65 comment-plane citations`. Census before the grammar moved (2026-10-11): 148 such claims across
// roughly fifty shapes in the two ledgers, every one invisible to the plain-adjacency form, so a
// section could hold two values for one noun and the reader would judge the one it happened to see
// (`ten arms` in a heading beat `eleven legal-write arms` in the body, and the verdict read MISMATCH
// where the honest answer was AMBIGUOUS). Exactly the measured shape is added — one hyphenated token —
// and nothing looser: a plain adjective is a different population nobody has counted.
const CLAIM = new RegExp(
  `(?<![\\w.])(\\d[\\d,]*|${wordNumber})(?:\\s+[A-Za-z][\\w-]*-[\\w-]+)?\\s+(${nounPattern})\\b`,
  'gi',
);

/** Sections whose fence count is odd, so nothing in them was parsed. Reported, never silently dropped. */
const fenceUnbalancedSections = new Set();

/** Every claim, with the section it sits in — the section is what makes a stale number a dated one. */
function claims() {
  const out = [];
  for (const ledger of LEDGERS) {
    let text;
    try {
      text = readFileSync(join(ROOT, ledger), 'utf8');
    } catch {
      continue;
    }
    const raw = text.replace(/\r\n/g, '\n').split('\n');
    const FENCE = /^\s*```\s*$/;
    // Fences are paired **per section**, and a section whose fence count is odd is not parsed at all.
    // Naive toggling across the whole file is off by one from the first unbalanced section onwards, and this
    // ledger has thirteen of them (STATUS.md carries 265 fence lines, an odd number — measured 2026-09-30).
    // A section that cannot be split into prose and evidence cannot be read for claims, and saying so is the
    // only honest option: guessing which half a number belongs to is how a quoted census line became a claim.
    const sectionOf = [];
    let sec = '(before the first heading)';
    let secIndex = 0;
    raw.forEach((line) => {
      if (/^## /.test(line)) {
        sec = line.replace(/^##+ /, '').slice(0, 60);
        secIndex += 1;
      }
      sectionOf.push({ section: sec, sectionIndex: secIndex });
    });
    const fencesInSection = new Map();
    raw.forEach((line, i) => {
      if (!FENCE.test(line)) return;
      const key = `${sectionOf[i].sectionIndex}`;
      fencesInSection.set(key, (fencesInSection.get(key) ?? 0) + 1);
    });
    const unbalanced = new Set(
      [...fencesInSection].filter(([, n]) => n % 2 === 1).map(([k]) => Number(k)),
    );

    let fenced = false;
    raw.forEach((line, i) => {
      const meta = sectionOf[i];
      if (unbalanced.has(meta.sectionIndex)) {
        fenceUnbalancedSections.add(`${ledger} §${meta.sectionIndex} ${meta.section}`);
        return;
      }
      // A number inside a fenced block is **evidence, not an assertion**: these ledgers quote their own
      // command output, and a quoted census line (`63 216 assertions`) is a record of what a tool printed,
      // not a sentence the ledger is claiming today. Counting it made the section written to record that the
      // gate now files 217 report its own evidence block as a claim of 216 — measured on this tool's second
      // run, on the section that documents it.
      if (FENCE.test(line)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const m of line.matchAll(CLAIM)) {
        out.push({
          ledger,
          line: i + 1,
          section: meta.section,
          sectionIndex: meta.sectionIndex,
          value: numberOf(m[1]),
          noun: m[2].toLowerCase(),
        });
      }
    });
  }
  return out;
}

const all = claims();
if (all.length === 0) {
  // The floor, in the same spirit as the other readers: a scan that finds nothing has not read the ledger.
  console.log('RESULT: NOT CHECKED — no numeric claim matched any known noun; the ledger was not read');
  process.exit(2);
}

const byNoun = new Map();
for (const c of all) {
  const bucket = byNoun.get(c.noun) ?? new Map();
  bucket.set(c.value, (bucket.get(c.value) ?? 0) + 1);
  byNoun.set(c.noun, bucket);
}

/**
 * The newest SECTION that claims a value for this noun, and **every** value it claims there.
 *
 * "Newest" is the latest section, not the latest line: a noun can be mentioned incidentally in an old
 * section that happens to sit late in a file, and the first run of this tool mistook exactly that for a
 * current claim (`checks newest 8`, docs/DECISIONS.md:NN).
 *
 * The values come back as a set because a section *about* a stale number necessarily contains the stale
 * number. The first version took the last match, so the section written to record that the gate now files
 * 217 was itself read as claiming 216 — it discusses both. When the newest section carries more than one
 * value for a noun, no single claim is being made, and this reader says so rather than choosing.
 */
function newestSection(noun) {
  const rows = all.filter((c) => c.noun === noun);
  if (rows.length === 0) return null;
  const ledgerOrder = new Map(LEDGERS.map((l, i) => [l, i]));
  const top = rows.reduce((best, r) => {
    const a = [ledgerOrder.get(r.ledger), r.sectionIndex];
    const b = [ledgerOrder.get(best.ledger), best.sectionIndex];
    for (let i = 0; i < 2; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? r : best;
    }
    return r.line > best.line ? r : best;
  });
  const inSection = rows.filter((r) => r.ledger === top.ledger && r.sectionIndex === top.sectionIndex);
  return {
    ledger: top.ledger,
    line: inSection[inSection.length - 1].line,
    section: top.section,
    values: [...new Set(inSection.map((r) => r.value))].sort((a, b) => b - a),
    occurrences: inSection.length,
  };
}

const top = Number(optValue['--top'] ?? 0);
console.log('NEXUS — the ledger’s numeric claims, per noun, newest first');
console.log(`  claims read              ${all.length} over ${LEDGERS.join(', ')}`);
console.log(`  nouns known              ${Object.keys(NOUNS).length}`);
console.log('');
const rows = [...byNoun].sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) - [...a[1].values()].reduce((x, y) => x + y, 0));
for (const [noun, values] of top > 0 ? rows.slice(0, top) : rows) {
  const n = newestSection(noun);
  const distinct = [...values].sort((a, b) => b[0] - a[0]);
  const shown = distinct.slice(0, 6).map(([v, c]) => `${v}×${c}`).join(' · ');
  const head = n.values.length === 1 ? String(n.values[0]) : `{${n.values.join(', ')}}`;
  console.log(`  ${noun.padEnd(16)} newest ${head.padStart(6)}  ${n.ledger}:${n.line}`);
  console.log(`  ${''.padEnd(16)} values ${shown}${distinct.length > 6 ? ` · … ${distinct.length - 6} more` : ''}`);
  console.log(`  ${''.padEnd(16)} answered by ${NOUNS[noun]}`);
}

/* ------------------------------------------------------------------ judgement */

const expectations = [];
for (const raw of (optValue['--expect'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const eq = raw.lastIndexOf('=');
  if (eq < 1 || Number.isNaN(Number(raw.slice(eq + 1).trim()))) {
    console.log(`RESULT: NOT CHECKED — --expect ${raw} is not noun=value`);
    process.exit(2);
  }
  expectations.push({ noun: raw.slice(0, eq).trim().toLowerCase(), value: Number(raw.slice(eq + 1).trim()) });
}
// `--gate-log` is the source the number was missing. The ledger says 216 and the gate files 217, and the
// only artefact that can say which is right is the gate's own printout — so the reader reads it rather than
// asking an operator to carry the number across by hand, which is how 216 came to be written 120 times. It
// scrapes the LAST `N quality checks` line, because a log can hold more than one run.
if (optValue['--gate-log']) {
  let log;
  try {
    // `join(ROOT, 'C://...')` produced `D://获客平台//C://...` on this machine: a Windows absolute path
    // is not a relative one, and joining it to a root is how a flag that works with a relative path
    // fails with the path an operator actually has.
    const logPath = isAbsolute(optValue['--gate-log']) ? optValue['--gate-log'] : join(ROOT, optValue['--gate-log']);
    log = readFileSync(logPath, 'utf8');
  } catch (e) {
    console.log(`RESULT: NOT CHECKED — --gate-log unreadable: ${String(e.message).split('\n')[0]}`);
    process.exit(2);
  }
  const hits = [...log.matchAll(/(\d[\d,]*)\s+quality checks passed/gi)];
  if (hits.length === 0) {
    console.log(`RESULT: NOT CHECKED — --gate-log ${optValue['--gate-log']} carries no "N quality checks passed" line;`);
    console.log('  the gate may not have reached step 5, and an unread count is not a zero.');
    process.exit(2);
  }
  const measured = Number(hits[hits.length - 1][1].replace(/,/g, ''));
  console.log(`  expectation source        --gate-log ${optValue['--gate-log']} → ${measured} quality checks`);
  console.log('');
  expectations.push({ noun: 'assertions', value: measured });
}

if (optValue['--expect-file']) {
  try {
    const doc = JSON.parse(readFileSync(join(ROOT, optValue['--expect-file']), 'utf8'));
    for (const [noun, value] of Object.entries(doc)) expectations.push({ noun: noun.toLowerCase(), value: Number(value) });
  } catch (e) {
    console.log(`RESULT: NOT CHECKED — --expect-file unreadable: ${String(e.message).split('\n')[0]}`);
    process.exit(2);
  }
}

// `--census` is the CI mode, and it exists because the judged path needs a number only a gate run can
// produce. It asserts the three things a census can know on its own: the reader still reads the ledger, the
// ledger's prose is still parseable, and no section has slipped back into unbalanced fences — which is the
// P1 defect (thirteen sections missing their closing fence) and the one regression nothing else would catch.
if (parsed.flag['--census']) {
  console.log('');
  if (all.length === 0) {
    console.log('RESULT: NOT CHECKED — the census read no claim at all; the reader has lost the ledger');
    process.exit(2);
  }
  if (fenceUnbalancedSections.size > 0) {
    console.log(`RESULT: FAIL — ${fenceUnbalancedSections.size} section(s) have an odd number of code fences, so nothing in them was parsed:`);
    for (const sec of fenceUnbalancedSections) console.log(`    ${sec}`);
    console.log('  This is the P1 defect returning: a missing closing fence swallows the text after it.');
    process.exit(1);
  }
  console.log(`RESULT: PASS — ${all.length} numeric claim(s) read, every section's fences balanced, ${byNoun.size} noun(s) seen`);
  console.log('  Scoped: this asserts the census can run and the prose is parseable. It does not judge any');
  console.log('  number — only a gate run can say what the gate filed. That path is step 5 of db_gate_fresh.sh.');
  process.exit(0);
}

if (expectations.length === 0) {
  console.log('');
  console.log('RESULT: UNCHECKED — no expectation given, so no claim was judged.');
  console.log('  The census above is the whole verdict: it says which number a reader must trust today and');
  console.log('  where it is written. Pass --expect "quality checks=216" (from a real gate run) to judge it.');
  console.log('  Saying "the number is right" without a source for the number is the failure this tool exists');
  console.log('  to avoid, so it refuses to say it.');
  process.exit(2);
}

let mismatched = 0;
let unknownNoun = 0;
let ambiguous = 0;
console.log('');
console.log('JUDGEMENT — newest claim per expected noun');
for (const { noun, value } of expectations) {
  if (!(noun in NOUNS)) {
    unknownNoun += 1;
    console.log(`  ${noun}: UNKNOWN NOUN — this reader has no noun by that name, and will not guess one`);
    continue;
  }
  const n = newestSection(noun);
  if (n === null) {
    mismatched += 1;
    console.log(`  ${noun}: no claim found, expected ${value}`);
    continue;
  }
  if (n.values.length > 1) {
    // Not a mismatch: a section that names several values is not claiming one of them. Its own class, so a
    // reader can see the number is unsettled rather than wrong.
    ambiguous += 1;
    console.log(`  ${noun}: newest section names ${n.values.length} values {${n.values.join(', ')}} (${n.ledger}:${n.line}) — AMBIGUOUS, not judged against ${value}`);
    continue;
  }
  const ok = n.values[0] === value;
  if (!ok) mismatched += 1;
  console.log(`  ${noun}: newest ${n.values[0]} (${n.ledger}:${n.line}) vs expected ${value} — ${ok ? 'MATCHED' : 'MISMATCHED'}`);
}

if (unknownNoun > 0) {
  console.log(`RESULT: NOT CHECKED — ${unknownNoun} expectation(s) name a noun this reader does not know`);
  process.exit(2);
}
if (ambiguous > 0) {
  console.log(`RESULT: AMBIGUOUS — ${ambiguous} of ${expectations.length} noun(s) are claimed with more than one value in their newest section`);
  console.log('  A section about a number is not a claim of that number, and this reader will not pick one for it.');
  process.exit(2);
}
if (mismatched > 0) {
  console.log(`RESULT: MISMATCH — ${mismatched} of ${expectations.length} newest claim(s) disagree with the value passed in`);
  process.exit(1);
}
console.log(`RESULT: MATCHED — all ${expectations.length} newest claim(s) agree with the value passed in`);
console.log('  Scoped, deliberately: this says the newest sentence carries the number it was told to expect.');
console.log('  It does not say the number is right — only the artefact that produced it can say that.');
