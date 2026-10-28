#!/usr/bin/env node
/**
 * NEXUS D606 -- both sides of scripts/check_ui_script.mjs, shown rather than asserted.
 *
 * The census decides what a Hong Kong reader is answered in, so its arms decide what the census IS: which
 * characters it charges, which it counts and lets go, what it refuses to read, and what it refuses to
 * pronounce on. Each arm states its verdict BEFORE the shipped reader runs, and the harness exits non-zero
 * if a prediction misses. The arms come in pairs that differ in exactly one property, so no arm can hold
 * by luck or by never having been seen:
 *
 *   THE DEFECT        a Simplified character planted in a dict literal reddens the carrier -- and the same
 *                     planted literal one character apart, holding a character the reader EXCLUDES, does
 *                     not. That pair is what proves the exclusion list is doing work rather than sitting
 *                     under a green run: 台 is charged by the product's own table and let go by this
 *                     reader's judgement, and the arm says which.
 *
 *   PROSE vs COPY     a `//` comment inside the block carrying 对比 and 商户 is not charged -- the comment
 *                     also holds an apostrophe, which is the exact shape a regex scanner reads as the start
 *                     of a string literal. The same two characters inside a backtick literal ARE charged.
 *
 *   THE POPULATION    admission is by the declaration's own shape: a `zh` block nothing in its file reads
 *                     is DISCLOSED as unreferenced (and its copy is still judged), an `en` block with the
 *                     identical body is not read at all, and a `zh` block whose closing `};` this reader
 *                     cannot find is a REFUSAL -- a truncated population would report a greener file than
 *                     the one on disk.
 *
 *   THE DERIVATION    the reader charges what the product's tables know. A character neither canonical.py
 *                     nor lexicon.py maps is not charged; the same literal reddens once the pair is added
 *                     to the AI lexicon, with no edit to this reader. That is the property the whole design
 *                     buys -- AI gates D435/D446/D447 keep those tables honest, so their honesty is this
 *                     census's reach.
 *
 *   THE REFUSALS      tables absent, tables cut away, carriers absent, an unknown flag, `--repo` twice --
 *                     all exit 2. "Did not run" and "found nothing" are different answers.
 *
 *   THE KNOBS         --report reddens nothing but prints the offender; --verbose prints the derived fix
 *                     beside it. Both are measured on a planted red, because a knob only proved on a green
 *                     tree has never been shown to carry a verdict.
 *
 * Every arm gets its own copy of the AI tables and the i18n carriers under the system temp directory, so no
 * arm can borrow another arm's redness and the working tree is never the fixture. Every mutation asserts
 * the text it rewrites is present in the copy, so an arm cannot pass by silently running an unmutated tree.
 *
 * Usage: node scripts/falsify_ui_script.mjs
 * Exit:  0 every prediction held; 1 an arm missed (the reader cannot do what its docblock says)
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSpawnFailure, safeRemove, spawnReason } from './spawn_guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_ui_script.mjs');
const FIX = join(tmpdir(), 'nexus-ui-script-falsify');
const TABLES = ['apps/ai/nexus_ai/nlu/canonical.py', 'apps/ai/nexus_ai/nlu/lexicon.py'];
const CARRIERS = 'apps/web/src/lib/i18n';
const ROOTS = [...TABLES, CARRIERS];

const DICT = `${CARRIERS}/dict.ts`;
const TRUST = `${CARRIERS}/trust-labels.ts`;
const SERVER = `${CARRIERS}/server.ts`;

const missing = ROOTS.filter((r) => !existsSync(join(ROOT, r)));
if (missing.length) {
  console.log(`RESULT: NOT CHECKED — ${missing.length} of ${ROOTS.length} path(s) this harness copies are `
    + `absent: ${missing.join(', ')}. No arm was run.`);
  process.exit(2);
}

safeRemove(FIX);  // batched: a bulk `rmSync` of >50 files is refused by this host's delete shim
mkdirSync(FIX, { recursive: true });

/** Copy a file or a tree by hand: `cpSync(..., {recursive:true})` on a directory kills this Node host. */
function copyTree(src, dest) {
  if (statSync(src).isFile()) { mkdirSync(dirname(dest), { recursive: true }); copyFileSync(src, dest); return; }
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const a = join(src, e.name);
    const b = join(dest, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else copyFileSync(a, b);
  }
}

/** One fixture plane per arm: a copy of the tables and the carriers, under the system temp directory. */
function fixture(slug, roots = ROOTS) {
  const dir = join(FIX, slug.replace(/[^\w]+/g, '_').slice(0, 44));
  for (const r of roots) copyTree(join(ROOT, r), join(dir, r));
  return dir;
}

/** The copy's own line endings, so a splice cannot plant a mixed-EOL file the reader would then read twice. */
const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

function read(dir, rel) {
  const abs = join(dir, rel);
  if (!existsSync(abs)) throw new Error(`${rel} is not in this fixture, so this arm has nothing to rewrite`);
  return { abs, text: readFileSync(abs, 'utf8') };
}

/** Swap one exact span of text; refuse when the span is not there (the D110 "unmutated tree" failure). */
function swap(dir, rel, from, to) {
  const { abs, text } = read(dir, rel);
  if (!text.includes(from)) {
    throw new Error(`${rel} does not hold the text this arm rewrites: ${JSON.stringify(from.slice(0, 60))}`);
  }
  writeFileSync(abs, text.replace(from, () => to), 'utf8');
}

/** Insert whole lines directly after the line that holds `anchor`; refuse when the anchor is absent. */
function insertAfter(dir, rel, anchor, ...lines) {
  const { abs, text } = read(dir, rel);
  if (!text.includes(anchor)) {
    throw new Error(`${rel} does not hold the anchor line this arm splices after: ${JSON.stringify(anchor.slice(0, 60))}`);
  }
  const eol = eolOf(text);
  writeFileSync(abs, text.replace(anchor, () => `${anchor}${eol}${lines.join(eol)}`), 'utf8');
}

/** Add whole lines at the end of a file — how a new top-level block is planted. */
function append(dir, rel, ...lines) {
  const { abs, text } = read(dir, rel);
  const eol = eolOf(text);
  writeFileSync(abs, `${text}${eol}${lines.join(eol)}${eol}`, 'utf8');
}

/** Replace a file's whole contents; refuse when the file the arm overwrites is not there. */
function overwrite(dir, rel, text) {
  const { abs } = read(dir, rel);
  writeFileSync(abs, text, 'utf8');
}

/* ---------------------------------------------------------------- the plants */

// The defect this unit repaired, put back one character at a time.
const plantSimplifiedTagline = (d) => swap(d, DICT,
  "tagline: '用一句話，找到今天想去的地方'", "tagline: '用一句话，找到今天想去的地方'");

// A planted top-level key inside the zhHK block, holding exactly one table character: excluded (台) or
// charged (对). The pair differs in that one property and nothing else.
const BRAND = "  brand: { name: 'NEXUS', tagline: '用一句話，找到今天想去的地方' },";
const plantExcluded = (d) => insertAfter(d, DICT, BRAND, "  plantedExcluded: '平台',");
const plantCharged = (d) => insertAfter(d, DICT, BRAND, "  plantedCharged: '对比',");
// Prose carrying the same charged characters, and the apostrophe that a regex scanner takes for a quote.
const plantComment = (d) => insertAfter(d, DICT, BRAND,
  "  // planted note: it's 对比 and 商户 — this repository's English discussion of Chinese");
// The other comment state, and the one that spans lines: the census must stay blind to the prose and
// ALIVE to every literal after it. A first version of the scanner kept `//` mode open to the end of the
// block, so a planted note cut the read population from 814 literals to 50 and still printed PASS.
const plantBlockComment = (d) => insertAfter(d, DICT, BRAND,
  '  /* planted: 对比 spans', '     several lines, 商户 still prose */');
// The same text as copy rather than comment, and in the third quote state the scanner tracks.
const plantTemplate = (d) => insertAfter(d, DICT, BRAND, '  plantedTemplate: `对比`,');
// A character neither product table maps: charged only once the tables learn it.
const plantUnknown = (d) => insertAfter(d, DICT, BRAND, "  plantedUnknown: '前后',");
const teachUnknown = (d) => insertAfter(d, 'apps/ai/nexus_ai/nlu/lexicon.py',
  '_TRAD_SIMP_PAIRS: tuple[tuple[str, str], ...] = (', '    ("後", "后"),');

// Whole new top-level blocks in server.ts, which ships none: the population's admission rule under test.
const plantUnreferencedClean = (d) => append(d, SERVER,
  'const zhPlantedClean: UiLabels = {', "  a: '測試',", '};');
const plantUnreferencedDirty = (d) => append(d, SERVER,
  'const zhPlantedDirty: UiLabels = {', "  a: '对比',", '};');
const plantEnBlock = (d) => append(d, SERVER,
  'const enPlanted: UiLabels = {', "  a: '对比',", '};');
const plantUnterminated = (d) => append(d, SERVER,
  'const zhPlantedTrunc: UiLabels = {', "  a: '測試',", '    };');

/* ---------------------------------------------------------------- the baseline */

/** Run the shipped reader as a subprocess on `dir` and return its verdict text and exit code. */
function runArgv(argv) {
  try {
    return { out: execFileSync('node', [CHECKER, ...argv], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26,
    }), code: 0 };
  } catch (e) {
    if (isSpawnFailure(e)) {
      console.log(`RESULT: NOT CHECKED — the checker could not be started (${spawnReason(e)}).`);
      process.exit(2);
    }
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status === undefined ? -1 : e.status };
  }
}
const runChecker = (dir, extraArgs = []) => runArgv([`--repo=${dir}`, ...extraArgs]);

// The counts a planted literal must move, read off the same reader on an unmutated copy rather than typed
// into an assertion. An arm that only asks "does 台→臺 appear" holds while the planted literal is invisible
// to the census, so this arm asks for the exact count the plant produces.
const BASE = runChecker(fixture('baseline')).out;
const baseOf = (re, name) => {
  const m = re.exec(BASE);
  if (!m) throw new Error(`the baseline run does not print ${name}, so the arms that count it have no basis`);
  return Number(m[1]);
};
const baseLiterals = baseOf(/0 simplified character\(s\) over (\d+) literal\(s\)/, 'the literal count');
const baseTai = baseOf(/台→臺 (\d+)×/, 'the excluded 台 count');
const taiPlus = (n) => new RegExp(`台→臺 ${baseTai + n}×`);
const literalsPlus = (n) => new RegExp(`0 simplified character\\(s\\) over ${baseLiterals + n} literal\\(s\\)`);
const oneOffender = /RESULT: FAIL — 1 simplified character\(s\) in 1 literal\(s\) of \d+ zh block\(s\)/;

/* ---------------------------------------------------------------- the arms */

const ARMS = [
  {
    name: 'control: the repaired carriers as they stand',
    apply: () => {},
    expect: 0,
    must: [/RESULT: PASS/, new RegExp(`0 simplified character\\(s\\) over ${baseLiterals} literal\\(s\\) of 2 zh block\\(s\\)`),
      /pair table: \d+ simplified character\(s\) known \(canonical\.py \d+, lexicon\.py \d+\)/,
      /block zhLabels — apps\/web\/src\/lib\/i18n\/trust-labels\.ts:\d+-\d+/],
    // zhLabels is reached by the trustLabels() picker, not by a Record<Locale> map. An earlier draft of the
    // reader required the map and so accused shipped, rendered copy of being dead.
    absent: [/WRONG-SCRIPT/, /UNREFERENCED/],
  },
  {
    name: 'a Simplified character planted in a dict literal',
    apply: plantSimplifiedTagline,
    expect: 1,
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/dict\.ts:\d+ \[话\]/],
  },
  {
    name: 'the mirror: the planted literal holds an EXCLUDED character (台)',
    apply: plantExcluded,
    expect: 0,
    must: [/RESULT: PASS/, taiPlus(1), literalsPlus(1)],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'the pair: the planted literal holds a CHARGED character (对)',
    apply: plantCharged,
    expect: 1,
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/dict\.ts:\d+ \[对\]/],
  },
  {
    name: 'PROSE: a // comment inside the block is not copy (it holds an apostrophe too)',
    apply: plantComment,
    expect: 0,
    must: [/RESULT: PASS/, literalsPlus(0), taiPlus(0)],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'PROSE: a /* */ comment spanning lines is not copy, and the copy after it is still read',
    apply: plantBlockComment,
    expect: 0,
    must: [/RESULT: PASS/, literalsPlus(0), taiPlus(0)],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'COPY: the same two characters inside a backtick literal are copy',
    apply: plantTemplate,
    expect: 1,
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/dict\.ts:\d+ \[对\]/],
  },
  {
    name: 'a zh block nothing in its file reads: disclosed, its copy still judged',
    apply: (d) => { plantUnreferencedClean(d); plantUnreferencedDirty(d); },
    expect: 1,
    must: [oneOffender, /block zhPlantedClean — apps\/web\/src\/lib\/i18n\/server\.ts:\d+-\d+ {2}UNREFERENCED/,
      /disclosed, not charged/, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/server\.ts:\d+ \[对\]/],
  },
  {
    name: 'the same unreferenced block with clean copy: a flag, not an offender',
    apply: plantUnreferencedClean,
    expect: 0,
    must: [/RESULT: PASS/, /UNREFERENCED/, literalsPlus(1)],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'the identical body under an `en` name is outside the population',
    apply: plantEnBlock,
    expect: 0,
    must: [/RESULT: PASS/, literalsPlus(0)],
    absent: [/WRONG-SCRIPT/, /block enPlanted/],
  },
  {
    name: 'the derivation: a character the product tables do not map is not charged',
    apply: plantUnknown,
    expect: 0,
    must: [/RESULT: PASS/, literalsPlus(1)],
    absent: [/WRONG-SCRIPT/],
  },
  {
    name: 'the derivation: the same literal reddens once lexicon.py is taught the pair',
    apply: (d) => { plantUnknown(d); teachUnknown(d); },
    expect: 1,
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/dict\.ts:\d+ \[后\]/],
  },
  {
    name: 'REFUSAL: a zh block whose closing }; is not in column 0',
    apply: plantUnterminated,
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /server\.ts: const zhPlantedTrunc at line \d+ has no closing \}; in column 0/],
  },
  {
    name: 'REFUSAL: canonical.py emptied — a table this reader cannot cut charges nothing',
    apply: (d) => overwrite(d, 'apps/ai/nexus_ai/nlu/canonical.py',
      'CANONICAL_FORMS: dict[str, str] = {\n}\n'),
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /canonical\.py holds no CANONICAL_FORMS table this reader can cut/],
  },
  {
    name: 'REFUSAL: the AI pair tables are not in the plane at all',
    apply: () => {},
    expect: 2,
    roots: [CARRIERS],
    must: [/RESULT: NOT CHECKED/, /no canonical\.py at/, /no lexicon\.py at/],
  },
  {
    name: 'REFUSAL: the i18n carriers are not in the plane at all',
    apply: () => {},
    expect: 2,
    roots: TABLES,
    must: [/RESULT: NOT CHECKED/, /no i18n directory at/],
  },
  {
    name: 'REFUSAL: an unknown flag',
    apply: () => {},
    expect: 2,
    args: ['--nope=1'],
    must: [/RESULT: NOT CHECKED/, /unknown option --nope/],
  },
  {
    name: 'REFUSAL: --repo given twice — which plane is the run',
    apply: () => {},
    expect: 2,
    args: ['--repo=a', '--repo=b'],
    noRepo: true,
    must: [/RESULT: NOT CHECKED/, /--repo was given 2 times/],
  },
  {
    name: '--report over a red plant prints the offender and exits 0',
    apply: plantSimplifiedTagline,
    expect: 0,
    args: ['--report'],
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/dict\.ts:\d+ \[话\]/,
      /--report: printed, not enforced/],
  },
  {
    name: '--verbose prints the derived fix beside the offence',
    apply: plantSimplifiedTagline,
    expect: 1,
    args: ['--verbose'],
    must: [oneOffender, /→ {4}'用一句話，找到今天想去的地方'/],
  },
  {
    name: 'the trust carrier reddens on its own: the census reads both files',
    apply: (d) => swap(d, TRUST, "    price: '價格',", "    price: '价格',"),
    expect: 1,
    must: [oneOffender, /WRONG-SCRIPT apps\/web\/src\/lib\/i18n\/trust-labels\.ts:\d+ \[价\]/],
  },
];

const results = [];
for (const arm of ARMS) {
  const dir = fixture(arm.name, arm.roots);
  arm.apply(dir);
  const { out, code } = runChecker(dir, arm.args ?? []);
  const missed = (arm.must ?? []).filter((re) => !re.test(out));
  const printed = (arm.absent ?? []).filter((re) => re.test(out));
  results.push({ arm, code, missed, printed, out });
}

let fails = 0;
for (const r of results) {
  const ok = r.code === r.arm.expect && r.missed.length === 0 && r.printed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  const shown = () => r.out.split('\n').filter((l) => /RESULT|WRONG-SCRIPT|UNREFERENCED|pair table|no |holds/.test(l)).slice(0, 3).join(' | ');
  if (r.code !== r.arm.expect) console.log(`        verdict differs -- the arm printed: ${shown()}`);
  for (const m of r.missed) console.log(`        expected text missing: ${m}   -- printed: ${shown()}`);
  for (const m of r.printed) console.log(`        text printed that must not be: ${m}   -- printed: ${shown()}`);
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped reader as a subprocess on its own copy of the two AI');
console.log('           pair tables and the i18n carriers, so no arm can redden another; each mutation');
console.log('           refuses if the text it rewrites is absent, so no arm can pass on an unmutated tree.');
if (fails) {
  console.log('\nRESULT: FAIL -- the zh-HK script census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the census charges charged copy, lets excluded copy and prose go, admits blocks');
console.log('           by their declaration, derives its characters from the product tables, and refuses to');
console.log('           judge a plane it cannot read to the end.');
