#!/usr/bin/env node
/**
 * NEXUS D156 — show that gate step 7 can fail, and that its `--quality` seam reaches the ANSWER SITES census
 * rather than only the declared-reads half of it.
 *
 * WHY THIS EXISTS. `check_jsonb_reads.mjs` documents `--quality=<path>` as the seam a witness uses so a plant
 * does not have to edit the tracked seed gate mid-run. The seam's reach had never been asked: an earlier probe
 * planted six occurrences of one citation and the census printed the same numbers with exit 0, because five of
 * the six were comment lines and the site census only walks rows inside the two `INSERT INTO … VALUES` blocks.
 * Aimed at a row the census does parse, four plants each did what the step claims (D156). This file is that
 * measurement, kept as an arm so the next reader does not re-derive it, and gate step 7 runs it.
 *
 * Every arm runs the SHIPPED checker as a subprocess over its own copy of the seed gate, written into the
 * system temp directory, so no arm edits a tracked file and no two arms can redden each other. The checker's
 * own `ROOT` is its working directory, so all arms run from the repository root: the plants change only the
 * answers, never the source they are compared against.
 *
 * D193 ADDED THE OTHER HALF OF THAT ASK. Step 7 used to file every answer its read census missed under one
 * sentence — "stale answers, or reads outside what a textual scan can see; each is judged by hand" — which is a
 * bucket, not a verdict: on a clean checkout of HEAD two of its members are plane facts already reddened by the
 * site census, and the one failure mode a narrowed scan could produce (answers citing a directory the census was
 * never pointed at) could never stop the gate. The checker now splits the miss by the reason this run can decide
 * for itself, refuses when its own population is empty or read-less, refuses a kind its table has no branch for,
 * refuses an exemption it cannot attribute, and makes an out-of-roots answer fatal. The new arms below aim at each
 * of those, and the `--roots` seam is what makes the coverage class reachable without editing shipped bytes.
 *
 * D194 ARMED THE GUARD ITSELF. Every arm above relies on the reader having finished, and the file checked that
 * with a `crashed` flag no arm ever produced: nothing had died on purpose, so a guard that never fired and a
 * guard that could not fire were the same line in the report. Three deaths and one inversion now — die at import,
 * die after the verdict header (the case the old predicate, keying on that header, called a finished run), reach
 * a terminal report and then take a different exit code than it declares, and declare a crash on a run that
 * finished. The terminal report is the reader's own last line, carrying the reason count and the code; a run that
 * reaches neither it nor a refusal has judged nothing. The same unit reddens the census's unused vocabulary branch,
 * which printed `1 classify no row on this plane` and exited 0, and the seam's own path, which died inside
 * `readFileSync` at the verdict code because every plant had always written a real file.
 *
 * Usage: node scripts/falsify_quality_seam.mjs
 * Exit: 0 every arm held · 1 at least one did not · 2 a plant could not be built (a mutation that no longer
 *       matches its anchor is an arm that proves nothing).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_jsonb_reads.mjs');
const TRACKED = join(ROOT, 'data', 'seed', 'quality.sql');
const FIX = join(tmpdir(), 'nexus-d156-falsify');

const die = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

// Read as text and write as text: this file's plants anchor on ordinary sentences, and a byte-level rewrite of
// a UTF-8 source would re-encode every § it passed.
const BASE = readFileSync(TRACKED, 'utf8');
if (BASE.includes('\r\n')) die('the seed gate is LF here; this harness assumes one line ending for its row plant');

/** Write `from` → `to` into its own fixture copy. A plant must hit its anchor exactly once or it proves nothing. */
function plant(name, from, to) {
  const hits = BASE.split(from).length - 1;
  if (hits !== 1) {
    die(`plant ${name}: its anchor occurs ${hits} time(s) in the tracked seed gate, not 1 — the anchor is stale`);
  }
  const p = join(FIX, name);
  writeFileSync(p, BASE.replace(from, to), 'utf8');
  return p;
}

const PAST_END = plant('past_end.sql', 'CollectionsController.java:243', 'CollectionsController.java:999999');
const NO_LINE = plant('no_line.sql', 'ImportService.java:193 (from documents d)',
  'ImportService.java (from documents d)');
const ROW_DROPPED = plant('row_dropped.sql',
  [' (\'orders\', \'metadata\', \'session_id\', \'empty-by-guard\', \'OrderRepository.java:97\',',
    '  \'guest-order lookup by session; orders is EMPTY by D64 because §109 forbids fabricated transactions\'),']
    .join('\n') + '\n', '');
const MARKER_GONE = plant('marker_gone.sql', 'INSERT INTO read_answer VALUES', 'INSERT INTO read_answer_x VALUES');
const CONTROL = plant('control.sql', 'INSERT INTO read_answer VALUES', 'INSERT INTO read_answer VALUES');

// D193 — the reader's five parse refusals. Each of these is a rule that cannot fire on the shipped plane, which
// is exactly the standing defect this unit was opened for: a setup failure used to `throw`, print a stack, and
// exit 1 — the exit code the gate reserves for a verdict about reads and sites. They are now `RESULT: NOT CHECKED`
// refusals at exit 2, and an arm exists for every one of them, because a refusal no plant can reach is a caption.
// One plant per anchor the reader depends on, in the order the reader reaches them:
// the read_cat loop header, its column alias, the read_answer INSERT, the shape_answer INSERT (only valuesRows
// reads it, so it is the sole route to the missing-marker refusal), and a row that stops closing.
const CAT_HEADER_GONE = plant('cat_header_gone.sql', 'FOR p IN SELECT * FROM (VALUES',
  'FOR p IN SELECT * FROM ( VALUE_LIST');
const CAT_ALIAS_GONE = plant('cat_alias_gone.sql', ') v(tbl, col, key)', ') v_x(tbl, col, key)');
const SHAPE_MARKER_GONE = plant('shape_marker_gone.sql', 'INSERT INTO shape_answer VALUES',
  'INSERT INTO shape_answer_x VALUES');
const ROW_TAIL_GARBAGE = plant('row_tail_garbage.sql', "naming it here');", "naming it here')  stray_tail;");

/**
 * A plant that needs more than one edit, for a triple that has to exist in TWO places at once: the `read_cat`
 * VALUES list is what `declaredReads()` walks (the reader's answer list), and the `read_answer` row is where the
 * triple's kind comes from. A row invented in one place and not the other tests nothing — it lands in a class
 * the census refuses before it judges anything, which is its own arm.
 */
function plantMany(name, pairs) {
  let out = BASE;
  for (const [from, to] of pairs) {
    const hits = out.split(from).length - 1;
    if (hits !== 1) {
      die(`plant ${name}: its anchor occurs ${hits} time(s) in the tracked seed gate, not 1 — the anchor is stale`);
    }
    out = out.replace(from, to);
  }
  const p = join(FIX, name);
  writeFileSync(p, out, 'utf8');
  return p;
}

// D193 — the miss taxonomy's own plants. Each one moves a row into a bucket the reader claims to be able to
// name, so the arm proves the sentence under that bucket is a judgement and not a caption.
const UNKNOWN_KIND = plant('unknown_kind.sql',
  "'reachable', 'CollectionsController.java:295,:303',", "'maybe-read', 'CollectionsController.java:295,:303',");

// D194 — the other direction of the same drift. This census expects four kinds; re-filing the plane's only
// `reachable` row under `dead-reader` leaves a branch with no member. Both kinds expect a findable read, so the
// read census' own numbers do not move and the single observable change is the unused branch. Measured on the
// bytes before the rule existed: the run printed `1 classify no row on this plane (reachable)` and exited 0 — a
// sentence with no consequence, which is what D193 stopped doing for `--roots`.
const KIND_UNUSED = plant('kind_unused.sql', "('collections', 'seo', 'noindex', 'reachable'",
  "('collections', 'seo', 'noindex', 'dead-reader'");

// D194 — the seam's input itself. Every plant above writes a real file, so nothing ever pointed `--quality` at a
// path that is absent or is a directory, and such a request died inside `readFileSync` about forty lines later:
// exit 1 with `node:fs` frames, which is this step's code for a read or a site that is wrong.
const NO_SUCH_FILE = join(FIX, 'no_such_file.sql');

// The `read_cat` list is where a declared triple lives; `read_answer` is where its kind and its site live. A row
// appended AFTER that list's closing semicolon is invisible to `valuesRows` (it stops at the first top-level `;`)
// while `declaredReads`' line regex still reads its kind, so such a plant tests a parse mismatch instead of a
// miss class — measured. Every plant below files the invented answer in front of `read_answer`'s first row, which
// is a unique anchor inside the list, and shares the `read_cat` pair.
const READ_CAT_TAIL = "      ('tenants', 'config', 'currency_default')";
const FIRST_ANSWER = "INSERT INTO read_answer VALUES\n ('collections', 'seo', 'generated_by', 'dead-reader',";
const ADD_TRIPLE = [READ_CAT_TAIL, READ_CAT_TAIL + ",\n      ('merchants', 'settings', 'brand_color')"];
const inventedRow = (cells) => [FIRST_ANSWER,
  `INSERT INTO read_answer VALUES\n ('merchants', 'settings', 'brand_color', ${cells}),`
  + "\n ('collections', 'seo', 'generated_by', 'dead-reader',"];
// `brand_color` is read by nothing on any plane, so the read census misses the row by construction and the only
// thing that decides WHICH miss class prints is the `site` these plants give it. Five sites, five classes.
const ABSENT_SITE = plantMany('plane_file.sql', [ADD_TRIPLE,
  inventedRow("'reachable', 'NoSuchRepository.java:89', 'a plant naming a file no index here holds'")]);
const NO_SITE = plantMany('no_cite.sql', [ADD_TRIPLE,
  inventedRow("'reachable', 'no source location is named in this plant', 'a site holding nothing to resolve'")]);
const AMBIGUOUS = plantMany('ambiguous_site.sql', [ADD_TRIPLE,
  inventedRow("'reachable', '__init__.py:1', 'a name this index holds more than once'")]);
// Line 31 of that file is `// ---- merchants ----`, which names the row's table: the cite is honest under the
// site rules, so the run's rc then isolates the claim that this class is a report and not a verdict. An earlier
// version aimed at :232, whose line names none of the three words, and rc 1 measured — a cite FALSE SITES
// reddens, which is a different claim than the one this arm's name makes.
const NOT_IN_FILE = plantMany('not_in_file.sql', [ADD_TRIPLE,
  inventedRow("'reachable', 'MerchantRepository.java:31', 'a file the census walks, over a key it does not read'")]);
// Five cells, not six: the site census refuses the row and parses no site for it, so the read census has a
// declared triple with a kind and nowhere it looked — the one silence the reader must not excuse.
const UNATTRIBUTED = plantMany('unattributed.sql', [ADD_TRIPLE,
  inventedRow("'reachable', 'NoSuchRepository.java:89'")]);

/**
 * D193 — A PREFIX NAMING A PLANE THE HARNESS NEVER READS. Step 13's harness legs stay at `$ROOT` on purpose
 * (their fixtures cite real repository files, which is the behaviour the plane knobs exist to allow), and two
 * of the three carried a plane-shaped environment prefix anyway: `GATE_QUALITY_SQL="$WT/data/seed/quality.sql"`
 * on 13a and `GATE_COMMENT_PLANE="$WT"` on 13c. No `scripts/falsify_*.mjs` reads any environment variable, so
 * those prefixes were labels and not planes — 13b's was removed two units ago for exactly this reason, with the
 * measurement written into the gate, and the other two were left standing. The predicate below reads the
 * shipped gate: every `NAME=... node scripts/falsify_X.mjs` invocation must name a variable the harness it
 * starts actually reads. The invocation count is its control, so a regex that stopped matching cannot report a
 * clean zero, and the pair arm plants one prefix back and predicts the red.
 */
const PREFIXED = /(?:^|&& )([A-Z][A-Z0-9_]{3,})=[^\s]*\s+node scripts\/(falsify_[\w.]+\.mjs)/gm;
const INVOKED = /node scripts\/(falsify_[\w.]+\.mjs)/g;
function falsifierInvocation(lines) {
  const gate = lines.join('\n');
  const all = [...gate.matchAll(INVOKED)].map((m) => m[1]);
  const prefixed = [...gate.matchAll(PREFIXED)].map((m) => ({ name: m[1], file: m[2], reads: false }));
  for (const p of prefixed) {
    try { p.reads = readFileSync(join(ROOT, 'scripts', p.file), 'utf8').includes(`process.env.${p.name}`); }
    catch { p.reads = false; }
  }
  return { all, prefixed };
}

/* ------------------------------------------------------- what each run reports */

const CENSUS = /ANSWER SITES — (\d+) answer row\(s\) cite (\d+) source location\(s\) in (\d+) file\(s\); (\d+) distinct source line\(s\) read back/;
const SPANS = /line spans checked\s+(\d+) across (\d+) citation token/;
const SCANNED = /source files scanned\s+(\d+)/;
const COVERAGE = /CENSUS COVERAGE — (\d+) answer\(s\)/;
// D194: the reader's own last line states how many reasons it found and which code it is about to exit with. An
// arm is only a measurement when the run it scored reached that line: a reader that died halfway used to look
// finished to a guard keying on the header, because the header is printed before the verdict blocks. The pattern
// is not written here — see TERMINAL below, which builds it out of the reader's own template, because retyping
// another file's wording is the same defect the two lists below used to have.

/** The count the shipped checker prints for one miss class, or null when the run refused before printing. */
function reason(out, name) {
  const m = new RegExp(`^ {2}${name} \\((\\d+)`, 'm').exec(out);
  return m ? +m[1] : null;
}

/**
 * Run one reader script with these arguments. `reader` defaults to the shipped checker; a mutant copy is the
 * only way to ask whether the checker's own in-process belt reddens anything, because on the shipped plane the
 * three plane-fact classes each already have a site-census offender, so the belt has no reachable member there.
 */
function runReader(reader, ...argv) {
  const r = spawnSync(process.execPath, [reader, ...argv], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const c = CENSUS.exec(out);
  const s = SPANS.exec(out);
  const scanned = SCANNED.exec(out);
  const coverage = COVERAGE.exec(out);
  const terminal = TERMINAL.exec(out);
  const refused = out.includes('RESULT: NOT CHECKED');
  // A reader that died on the way to its verdict has not judged anything: an arm over it must be reported as a
  // crash, not as the red or the green its rc would otherwise look like (D165's mutant taught this). D194 moved
  // the test from the header line to the terminal one, because a mutant that printed the header and then threw
  // was read as a finished run by the old predicate (measured: rc 1, header present, no census line, and
  // `crashed` false), and a terminal line whose declared code the process did not take is a run that cannot say
  // what it decided either.
  const base = { rc: r.status, scanned: scanned ? +scanned[1] : null,
    coverage: coverage ? +coverage[1] : null, out,
    reasons: terminal ? +terminal[1] : null,
    crashed: terminal ? (terminal[3] !== `${r.status}` || refused) : !refused };
  if (!c || !s) return { ...base, census: null, spans: null };
  return { ...base, census: { rows: +c[1], cited: +c[2], files: +c[3], lines: +c[4] },
    spans: { checked: +s[1], tokens: +s[2] } };
}
const run = (...argv) => runReader(CHECKER, ...argv);

/**
 * A mutant READER, not a mutant answer. The checker imports two sibling modules by relative specifier, so the
 * copy is written into the temp directory with those two specifiers re-pathed to the same shipped files — the
 * mutation is the one named below and nothing else about its runtime.
 */
const READER_SRC = readFileSync(CHECKER, 'utf8');

// D196 — the terminal line's wording used to be retyped here as a regex. That is the same act as copying a
// class list by hand: reword the checker's last line and the copy stops matching, so every run — healthy ones
// included — begins reading as a death, and the message an arm reports is about a crash that never happened.
// The pattern is now the reader's own template with each interpolation turned into a capture group, so a reword
// moves the pattern with it and only a reader that no longer states its exit code can break the arm.
const escLit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const terminalTemplate = (() => {
  const prints = [...READER_SRC.matchAll(/console\.log\(\s*`([^`]*)`\s*\)/g)];
  const last = prints[prints.length - 1];
  if (!last) die('this reader prints no single-template line to read its terminal report off');
  const groups = (last[1].match(/\$\{[^}]*\}/g) || []).length;
  if (groups < 3) {
    die(`the reader's last template line carries ${groups} interpolation(s); the crash predicate needs at`
      + ' least three — a reason count, the report mode, and the exit code the run takes');
  }
  return last[1];
})();
const TERMINAL = new RegExp(terminalTemplate.split(/\$\{[^}]*\}/g)
  .map((p, i, a) => escLit(p) + (i < a.length - 1 ? (i === a.length - 2 ? '(.*)' : '(.*?)') : '')).join(''), 'm');
const SCRIPTS = (p) => pathToFileURL(join(ROOT, 'scripts', p)).href;
function mutantReader(name, ...edits) {
  let text = READER_SRC;
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) die(`reader mutant ${name}: its anchor occurs ${hits} time(s) in ${CHECKER}, not 1`);
    text = text.replace(from, to);
  }
  for (const mod of ['source_index.mjs', 'cli_args.mjs']) {
    const from = `from './${mod}'`;
    const hits = text.split(from).length - 1;
    if (hits !== 1) die(`reader mutant ${name}: the ${mod} import anchor occurs ${hits} time(s), not 1`);
    // A bare absolute path is not a valid ESM specifier on Windows (`Received protocol 'd:'`, measured), so the
    // re-pathed import is a file: URL — the same module the shipped reader loads, by the same route.
    text = text.replace(from, `from '${SCRIPTS(mod)}'`);
  }
  const p = join(FIX, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

// The rule that carries the belt's promise: an absent site file reddens the row by name. With it silenced, the
// class still says "the FALSE SITES block below reddens the same row", and only the belt can show that is now
// false — so this mutant is the belt's only reachable member.
const NO_FILE_RULE = [
  "            offenders.push(`${rowId} cites ${cite.name} in ${field} — no file in the ${files.length}-file source `\n              + 'index has that path or that name');",
  '            void offenders; // mutant: the absent-file rule no longer reddens',
];
const READER_NO_FILE_RULE = mutantReader('reader_no_file_rule.mjs', NO_FILE_RULE);

// D194 — the crash guard's own witnesses. `crashed` was read by every arm below and produced by none of them: the
// guard refused a run that died, and no run had ever died on purpose, so a guard that never fired and a guard
// that could not fire looked identical in the report. Three deaths, each the only route to one clause: die at
// import (no output at all), die after the verdict header (the case the old predicate called finished), and
// reach the terminal line but not the exit code it declares.
const HEADER_LINE = `console.log("NEXUS — jsonb key reads found in source, against the gate's declared list");`;
const READER_BROKEN = mutantReader('reader_broken.mjs',
  ['function declaredReads() {', 'function declaredReads() { ] }']);
const READER_AFTER_HEADER = mutantReader('reader_after_header.mjs',
  [HEADER_LINE, `${HEADER_LINE}\n  throw new Error('mutant: died after the verdict header');`]);
const READER_WRONG_EXIT = mutantReader('reader_wrong_exit.mjs',
  ['process.exit(exitCode);', 'process.exit(exitCode === 0 ? 1 : 0);']);

// D196 — a classifier branch whose class the sentence table has no entry for. Renaming the key is the whole
// mutation: the same fixture, the same row, the same site, and the reader now files the miss somewhere it has
// not described. On the shipped reader this plant's row is the one class judged by hand and the run exits 0 over
// it; charging the unnamed class is what makes that row's classification cost something.
const READER_UNNAMED_CLASS = mutantReader('reader_unnamed_class.mjs',
  ["  'not-read-in-the-file-where-it-should-be': 'its site resolves inside the walked roots",
    "  'not-read-in-the-file-where-it-should-be-x': 'its site resolves inside the walked roots"]);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* --------------------------------------------------------------------- arms */

// The control runs first and its numbers are what the plant arms predict against, so no arm's expectation is a
// transcription of a run someone remembered.
const SHIPPED = run();
const CTRL = run(`--quality=${CONTROL}`);
if (SHIPPED.rc !== 0 || CTRL.rc !== 0) die(`the shipped plane is not green (rc ${SHIPPED.rc}, control rc ${CTRL.rc})`);
if (!same(SHIPPED.census, CTRL.census) || !same(SHIPPED.spans, CTRL.spans)) {
  die(`an unmutated copy through the seam moved the census: ${JSON.stringify(SHIPPED.census)} vs ${JSON.stringify(CTRL.census)}`);
}
const N = CTRL.census;
const S = CTRL.spans;
const SCANNED_CTRL = CTRL.scanned;

// D196 — this list used to be typed by hand, which made it a copy of another file's output vocabulary: rename a
// class in the checker and the copy keeps its old membership, `classCounts` stops counting the name that fires,
// and every miss arm below still prints green. It is now read out of the reader this harness instance points at,
// twice and by different means — the keys of its sentence table and the reasons its classifier pushes — and the
// two readings must agree before any arm runs. They are the same two populations the checker compares at run
// time when it charges an unnamed class; agreeing here is what lets the arms score against the reader's own
// taxonomy rather than a remembered one.
const classesFromSentences = () => {
  const at = READER_SRC.indexOf('const MISS_WHY = {');
  if (at < 0) die('this reader has no MISS_WHY table, so its class list cannot be read where this harness expects');
  const end = READER_SRC.indexOf('\n};', at);
  return [...READER_SRC.slice(at, end).matchAll(/^ {2}'([a-z][a-z0-9-]*)':/gm)].map((m) => m[1]);
};
const classesFromPushes = () => [...new Set([...READER_SRC.matchAll(/\breason: '([a-z][a-z0-9-]*)'/g)]
  .map((m) => m[1]))];
const MISS_CLASSES = classesFromSentences();
const PUSHED_CLASSES = classesFromPushes();
if (MISS_CLASSES.length === 0 || PUSHED_CLASSES.length === 0) {
  die(`the class derivation read nothing (sentences ${MISS_CLASSES.length}, pushes ${PUSHED_CLASSES.length})`
    + ' — a scan that found no class cannot contradict an arm that expects one');
}
const unnamed = PUSHED_CLASSES.filter((c) => !MISS_CLASSES.includes(c));
const unfired = MISS_CLASSES.filter((c) => !PUSHED_CLASSES.includes(c));
if (unnamed.length + unfired.length > 0) {
  die(`this reader's classifier and its sentence table disagree — files ${unnamed.join(', ') || '(nothing)'}`
    + ` with no sentence, states ${unfired.join(', ') || '(nothing)'} that no branch files`);
}
// The five classes the shipped reader says it can tell apart. Every miss arm below claims exactly ONE of them
// holds the planted row: a run that printed all five sentences would otherwise let an arm pass on a classifier
// that had decided nothing.
const classCounts = (r) => MISS_CLASSES.map((c) => reason(r.out, c));
const onlyClass = (name) => {
  // An arm aimed at a class this reader cannot file is not an arm: its expectation would be checked against a
  // name no run can ever print, and the count it demands would stay absent forever.
  if (!MISS_CLASSES.includes(name)) {
    die(`an arm aims at class '${name}', which this reader's classifier never files — the derived list is`
      + ` ${MISS_CLASSES.join(', ')}`);
  }
  return (r) => {
    const counts = classCounts(r);
    const wrong = MISS_CLASSES.filter((c, i) => counts[i] !== (c === name ? 1 : 0));
    return wrong.length
      ? `${MISS_CLASSES.map((c, i) => `${c}=${counts[i]}`).join(' ')} — only ${name} should hold a member` : null;
  };
};

// A parse refusal is total: the reader stops before its header, so nothing it reports can be read as an answer.
// An arm that only checked exit 2 would also pass a run that refused AND answered. D194 added the two blocks a
// refusal must not reach: the terminal report (a run cannot both refuse and answer) and the unused-kinds verdict.
// D196 — and the list of blocks used to be six strings typed under a checker that printed twelve, so a refusal
// that answered anyway through one of the other six (`UNDECLARED —`, `WRONG TABLE —`, `NO KIND —`,
// `CALLED NEVER-READ`, `EVERY READ THE SCAN FOUND`, `ANSWERS THE READ CENSUS DID NOT FIND`) still read as total.
// The heads are now the reader's own `console.log` literals, and the one print a refusal is allowed to make is
// excluded by a property of the source line rather than by a name typed here: the line whose own statement calls
// process.exit(2) is what the refusal SAYS, so it cannot also be what the refusal must not say.
// Measured on the first version of this derivation: it read thirteen "heads", and the thirteenth was the
// reader's footer — `LIMITS, stated rather than implied: this is a textual scan.` — which begins in capitals and
// continues in words. A prose line in a marks list is a false witness waiting for the run that prints its
// disclaimer, so a head is the capitals run only: it ends at the first lower-case letter, and what is left must
// not end on sentence punctuation. The verdicts this reader really prints survive that (`UNDECLARED`,
// `FALSE SITES (`, `REPORT COMPLETE`); its disclaimer does not.
const verdictHeads = (src) => src.split('\n').flatMap((l) => {
  const m = /console\.log\(\s*([`'])((?:\\.|(?!\1)[^\\])*)\1/.exec(l);
  if (!m) return [];
  const prose = m[2].split('${')[0];
  const word = prose.split(/[^\w-]/)[0] ?? '';
  if (!/^[A-Z][A-Z0-9_-]{1,}$/.test(word)) return [];
  const at = prose.search(/[a-z]/);
  const head = (at < 0 ? prose : prose.slice(0, at)).replace(/\s*[-—:]\s*$/, '').trim();
  return /process\.exit\(2\)/.test(l) || head.length < 5 || /[,;.]$/.test(head) ? [] : [head];
}).filter((h, i, a) => a.indexOf(h) === i);
const VERDICT_MARKS = verdictHeads(READER_SRC);
if (VERDICT_MARKS.length < 6) {
  die(`the verdict-head derivation read ${VERDICT_MARKS.length} header(s) out of this reader — a marks list that`
    + ` short cannot tell a refusal from an answer: ${VERDICT_MARKS.join(' | ') || '(none)'}`);
}
// The counterfactual the rule above exists for: this reader's own prose line, found by a property of the print
// that FOLLOWS it rather than by its own text — a `console.log` of one quoted literal beginning in a lower-case
// letter can only be the second half of a sentence, so the line it continues is prose too. Measured: exactly one
// such pair in this reader, the `LIMITS, stated rather than implied:` footer and its `named by a constant,`
// tail. If the marks derivation accepted that first line, a run that printed nothing but its own disclaimer
// would be scored as an answered census, which is the false witness the arms below are for.
const proseFooter = (src) => {
  const lines = src.split('\n');
  const literal = (l) => {
    const m = /^console\.log\(\s*'([^']*)'\s*\);?\s*$/.exec((l ?? '').trim());
    return m ? m[1] : null;
  };
  const hits = lines.flatMap((l, i) => {
    const here = literal(l), prev = i ? literal(lines[i - 1]) : null;
    return here && prev && /^[a-z]/.test(here) && /^[A-Z][A-Z0-9_-]{1,}[ ,]/.test(prev) && !/process\.exit/.test(lines[i - 1])
      ? [prev] : [];
  });
  return hits.length === 1 ? hits[0] : null;
};
const PROSE_FOOTER = proseFooter(READER_SRC);
if (!PROSE_FOOTER) {
  die(`this reader's prose-footer finder matched nothing or several lines, so the marks derivation has no`
    + ` counterfactual to be scored against — retire or re-aim the finder in the same change that moves it`);
}
// The derivation-vs-footer test lives in an arm, not here: a `die` on the wide rule would preempt the arm that
// names the case, and an arm no run can redden is a caption (D193).
// D196 — the two plants the marks list is load-bearing for, in both directions: a refusal that answers through a
// head no hand-typed copy carried, and a refusal that prints prose. The first is what the old six strings could
// not see; the second is what an over-wide derivation cannot see, and the pair is what keeps the first from
// meaning "any line the reader prints counts as an answer".
const NOT_CHECKABLE = "const notCheckable = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };";
const READER_REFUSAL_ANSWERS = mutantReader('reader_refusal_answers.mjs',
  [NOT_CHECKABLE, 'const notCheckable = (m) => { console.log(`RESULT: NOT CHECKED — ${m}`);\n'
    + "  console.log('ANSWERS THE READ CENSUS DID NOT FIND (0) — mutant: an answer block on the refusal path');\n"
    + '  process.exit(2); };']);
const READER_REFUSAL_PROSE = mutantReader('reader_refusal_prose.mjs',
  [NOT_CHECKABLE, `const notCheckable = (m) => { console.log(\`RESULT: NOT CHECKED — \${m}\`);\n`
    + `  console.log('${PROSE_FOOTER}');\n  process.exit(2); };`]);
const noVerdictPrinted = (r) => (VERDICT_MARKS.filter((h) => r.out.includes(h)).length
  ? `the run printed ${VERDICT_MARKS.filter((h) => r.out.includes(h)).join(', ')} alongside the refusal — a census`
    + ' that cannot parse its input has no verdict to report' : null);

/**
 * Every reason one arm did not hold. D194 pulled it out of the reporting loop because the loop now has an arm
 * that aims at this function's own crash clause: to prove `expectCrash` cannot wave a dead run past an arm, the
 * inversion has to run the same decision, not a copy of it.
 */
function armReasons(arm, r) {
  const why = [];
  if (r.rc !== arm.expectRc) why.push(`rc ${r.rc}, expected ${arm.expectRc}`);
  if (arm.expectCrash) {
    if (!r.crashed) why.push('this arm declares expectCrash but the run reached a verdict or a refusal, so the'
      + ' crash guard had nothing to refuse and the arm would have passed on a healthy run');
  } else if (r.crashed) {
    why.push(`the reader reached no terminal report it stands behind (rc ${r.rc}), so this arm measured a crash`
      + ` rather than a verdict: ${r.out.split(/\r?\n/).filter((l) => l.trim() !== '')[0]?.slice(0, 160)
        ?? '(no output at all)'}`);
  }
  for (const e of arm.evidence ?? []) if (!r.out.includes(e)) why.push(`does not print ${JSON.stringify(e)}`);
  for (const e of arm.absent ?? []) if (r.out.includes(e)) why.push(`prints ${JSON.stringify(e)} — this arm is the`
    + ' case where that sentence must stay quiet');
  // A crashed run has no census to compare: scoring one would report a moved number where the truth is a death.
  if (!(arm.expectCrash && r.crashed)) {
    if (arm.check) { const claim = arm.check(r); if (claim) why.push(claim); }
    if (arm.census && !arm.census(r.census ?? {})) why.push(`census ${JSON.stringify(r.census)}`);
    if (arm.spans && !arm.spans(r.spans ?? {})) why.push(`spans ${JSON.stringify(r.spans)}`);
  }
  return why;
}

const ARMS = [
  {
    name: 'control — the seam over an unmutated copy leaves every census number where the tracked file put it',
    args: [`--quality=${CONTROL}`], expectRc: 0,
    census: (c) => same(c, N), spans: (s) => same(s, S),
    // D194: the control is also the guard's positive case — a finished, green run reaches the terminal line, and
    // states the reason count the run above reports. `crashed` false here is what keeps the guard from being a
    // predicate that fires on everything.
    evidence: ['REPORT COMPLETE — 0 reason(s) to redden, --report false, this run exits 0'],
    absent: ['ANSWER KINDS UNUSED'],
    check: (r) => (r.reasons !== 0 ? `the terminal report counts ${r.reasons} reason(s) on a plane that exits 0`
      : null),
  },
  {
    name: 'cited line past the end of the file — the site census refutes it and the run reddens',
    args: [`--quality=${PAST_END}`], expectRc: 1,
    evidence: ['read_answer collections.seo.generated_by', 'the file has'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1 && s.tokens === S.tokens,
  },
  {
    name: 'cited line number removed — a file with no line is reported twice: once for the cite, once for the row',
    args: [`--quality=${NO_LINE}`], expectRc: 1,
    evidence: ['with no line number', 'not one of them carries a line number'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1 && s.tokens === S.tokens,
  },
  {
    name: 'answered row dropped — the parse-vs-census reconciliation catches it, and the counts move',
    args: [`--quality=${ROW_DROPPED}`], expectRc: 1,
    evidence: ['while its read census parsed'],
    census: (c) => c.rows === N.rows - 1 && c.cited === N.cited - 1,
  },
  {
    name: 'the space spelling reaches the same census as the `=` one (D156: before the fix it read the tracked file)',
    args: ['--quality', PAST_END], expectRc: 1,
    evidence: ['the file has'],
    census: (c) => c.rows === N.rows && c.cited === N.cited && c.lines === N.lines - 1,
    spans: (s) => s.checked === S.checked - 1,
  },
  {
    name: 'an unknown flag is a refusal with exit 2, not a silence about the wrong plane',
    args: [`--qualit=${PAST_END}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'unknown option', 'flags this reader parses'],
  },
  {
    name: 'an empty --quality value is a refusal, not a fallback to the tracked file',
    args: ['--quality='], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'without a path'],
  },
  {
    name: 'the file the seam names is the file the census opens (its anchor gone, the checker says which path)',
    args: [`--quality=${MARKER_GONE}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'could not find the read_answer table in', MARKER_GONE],
    // D193: this arm asserted rc 1 with a stack trace in the output. A reader that cannot parse its own input is
    // not reporting a verdict about reads, so it must use the refusal code; the crash guard would otherwise
    // (correctly) refuse to call this a witness.
    check: noVerdictPrinted,
  },
  ...[
    ['the read_cat loop header is gone — there is no declared list to contradict, and that is a refusal',
     CAT_HEADER_GONE, 'could not find the read_cat VALUES list in'],
    ['the read_cat list has no column alias — a parse that runs to end-of-file would call anything a declaration',
     CAT_ALIAS_GONE, 'has no column alias to close on'],
    ['the shape_answer marker is gone — the rows this census checks were never read, so no green is owed',
     SHAPE_MARKER_GONE, 'the shape_answer rows this census'],
    ['a row that stops closing reddens the parse instead of shrinking the census — the smaller green is refused',
     ROW_TAIL_GARBAGE, 'ended somewhere a row was not closing'],
  ].map(([name, fixture, phrase]) => ({
    name,
    args: [`--quality=${fixture}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', phrase, fixture],
    check: noVerdictPrinted,
  })),
  // D193 — the census's own population. `--roots` exists because a coverage claim is only testable if the
  // population behind it can be narrowed from outside the shipped bytes: before this seam the two floors below
  // printed nothing, the `unseen` bucket excused every miss as "outside what a textual scan can see", and a
  // scan aimed at one subtree would have reported a green over zero files read. Every arm names the reason its
  // refusal prints, because a refusal for the wrong reason is the defect (D159) these floors must not re-invent.
  {
    name: 'a default root still reaches every declared read — the narrowed control the floors are read against',
    args: ['--roots=services/platform/src/main/java'], expectRc: 0,
    evidence: ['read scan walks     1 root(s): services/platform/src/main/java'],
    // The number is derived from the control's own print, not transcribed: the population must really have
    // narrowed, and the narrowing must not have manufactured a miss.
    check: (r) => r.scanned === null || !(r.scanned < SCANNED_CTRL)
      ? `population did not narrow (${r.scanned} files vs the control's ${SCANNED_CTRL})`
      : (classCounts(r).some((c) => c !== 0)
        ? `narrowing to one root invented misses: ${MISS_CLASSES.map((c, i) => `${c}=${classCounts(r)[i]}`).join(' ')}`
        : null),
  },
  {
    name: 'a root that holds no source file at all is refused — a census that opened nothing has no sight',
    args: ['--roots=docs'], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'opened 0 source file(s)', 'docs'],
  },
  {
    name: 'a root that opens files and finds no read is refused — a census with no second reader only agrees',
    args: ['--roots=apps/ai/nexus_ai'], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'found 0 jsonb read(s)', 'apps/ai/nexus_ai'],
    // It must be the READS floor that fired, not the files floor one step earlier: the refusal's own number says.
    check: (r) => { const m = /opened (\d+) file\(s\)/.exec(r.out); return !m || +m[1] === 0
      ? `refused for opening nothing (${r.out.split('\n')[0].slice(0, 120)}) rather than for finding no read` : null; },
  },
  {
    name: '--roots with no value is refused by the flag parser, not read as the repository',
    args: ['--roots='], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', '--roots was given without a'],
  },
  {
    name: '--roots whose every entry is empty is refused by the census itself, which is where the value lands',
    args: ['--roots=,'], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'names no directory'],
  },
  {
    name: 'a root too narrow to hold the cited reads reddens as a coverage fact: the blind spot stops the gate',
    args: ['--roots=scripts'], expectRc: 1,
    evidence: ['CENSUS COVERAGE', 'cite a file outside the root(s) this scan walks', 'outside-the-census-roots ('],
    // The fatal block's own count has to be the class's count: a coverage report that numbered a different
    // population than the one it reddens would be a caption over a verdict, not the verdict.
    check: (r) => { const cls = reason(r.out, 'outside-the-census-roots');
      return !(cls > 0) || r.coverage !== cls
        ? `class holds ${cls}, the fatal block names ${r.coverage}, control scanned ${SCANNED_CTRL}` : null; },
  },
  {
    name: 'an answer kind this census has no expectation for is refused, not answered by the nearest branch',
    args: [`--quality=${UNKNOWN_KIND}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'no expectation for', 'maybe-read'],
  },
  {
    name: 'a kind this census expects that no row on this plane carries reddens — a branch classifying nothing decides nothing',
    args: [`--quality=${KIND_UNUSED}`], expectRc: 1,
    evidence: ['ANSWER KINDS UNUSED (1)', 'classify no row on this plane', 'REPORT COMPLETE — 1 reason(s)'],
    census: (c) => same(c, N), spans: (s) => same(s, S),
    // It has to redden for THIS reason: the census numbers stay the control's and no miss class holds a member,
    // so the single thing that moved is the vocabulary. A row that also invented a miss would let the arm pass
    // on a different defect than its name claims.
    check: (r) => {
      const counts = classCounts(r);
      return counts.some((x) => x !== 0)
        ? `the plant invented a miss: ${MISS_CLASSES.map((c, i) => `${c}=${counts[i]}`).join(' ')}`
        : (r.reasons !== 1
          ? `the terminal report counts ${r.reasons} reason(s) while the verdict block names 1` : null);
    },
  },
  {
    name: 'a --quality path that is not there refuses at exit 2 instead of dying in readFileSync at the verdict code',
    args: [`--quality=${NO_SUCH_FILE}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'is not there', NO_SUCH_FILE],
    check: (r) => (r.out.includes('ENOENT')
      ? 'the run printed a filesystem stack where it should have refused' : noVerdictPrinted(r)),
  },
  {
    name: 'a --quality path that is a directory is named as the thing it is, and refuses',
    args: [`--quality=${FIX}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'is a directory'],
    check: (r) => (r.out.includes('EISDIR')
      ? 'the run printed a filesystem stack where it should have refused' : noVerdictPrinted(r)),
  },
  // D194 — the crash guard, aimed at. Every arm above needs the reader to have finished; none of them could say
  // what happens when it does not, because nothing had ever died on purpose. These three deaths are the three
  // clauses of `crashed`: no report at all, a report that began and never ended, and a report that declares a
  // code the process then refuses to take.
  ...[
    ['a reader that dies at import reaches no line the harness can score, so the arm is a crash and not a red',
     READER_BROKEN, null],
    ['a reader that prints the verdict header and then dies is still a crash — the guard keys on the terminal line',
     READER_AFTER_HEADER, 'NEXUS — jsonb key reads'],
    ['a terminal report whose declared exit code the process does not take is a crash, not a verdict',
     READER_WRONG_EXIT, 'REPORT COMPLETE'],
  ].map(([name, reader, printed]) => ({
    name, expectRc: 1, expectCrash: true, evidence: printed ? [printed] : [],
    run: () => runReader(reader, `--quality=${CONTROL}`),
  })),
  {
    name: 'a refusal is not a crash: the NOT CHECKED marker is what excuses the missing terminal line',
    args: [`--quality=${MARKER_GONE}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED'],
    absent: ['REPORT COMPLETE'],
    check: (r) => (r.crashed
      ? 'a run that refused was scored as a crash, so the guard fires on the case it is meant to excuse' : null),
  },
  // D196 — the marks list used to be six strings typed under a checker that printed twelve. These two arms are
  // what that copy could not see, one in each direction, and both run a reader mutant rather than an answer
  // plant because the vocabulary is the reader's own: no fixture on this plane can make a refusal also answer.
  {
    name: 'a refusal that answers through a head the old six-string list never carried is still seen',
    run: () => runReader(READER_REFUSAL_ANSWERS, `--quality=${MARKER_GONE}`),
    expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'mutant: an answer block on the refusal path'],
    check: (r) => (noVerdictPrinted(r) ? null
      : 'the derived marks read no answer block on a run that printed one — a vocabulary shorter than the'
        + ' reader is blind in exactly this direction'),
  },
  {
    name: 'a refusal that prints only this reader\'s own disclaimer stays a refusal — prose in the marks list would call it an answer',
    run: () => runReader(READER_REFUSAL_PROSE, `--quality=${MARKER_GONE}`),
    expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', PROSE_FOOTER],
    check: (r) => {
      const claim = noVerdictPrinted(r);
      return claim ? `the marks list counted a sentence as a verdict, so the refusal reads as answered: ${claim}` : null;
    },
  },
  {
    name: 'an arm that declares expectCrash over a run that finished is itself a miss — the flag cannot wave a death past',
    run: () => {
      // The same decision function the loop uses, aimed at the control's real result rather than a stub, so the
      // inversion measures the guard and not a copy of it.
      const reasons = armReasons({ name: 'meta', expectRc: 0, expectCrash: true }, CTRL);
      return { rc: reasons.length === 1 && reasons[0].includes('expectCrash') ? 0 : 1,
        census: null, spans: null,
        out: `the guard decided a healthy run cannot witness a declared crash: ${reasons.join('; ') || '(no reason)'}` };
    },
    expectRc: 0,
    evidence: ['the guard decided a healthy run cannot witness a declared crash'],
  },
  {
    name: 'a miss whose cited file is not in this index is named a plane fact, and the site census reddens the same row',
    args: [`--quality=${ABSENT_SITE}`], expectRc: 1,
    evidence: ['file-not-on-this-plane (1', 'NoSuchRepository.java',
      'read_answer merchants.settings.brand_color cites NoSuchRepository.java in site'],
    // The class's own sentence promises the site census reddens it; this says the belt that checks that promise
    // stayed quiet because the promise was kept.
    absent: ['the exemption is covering a claim nothing judges'],
    check: onlyClass('file-not-on-this-plane'),
  },
  {
    name: 'a miss whose site cites no file at all is named for that, and the site census reddens the same row',
    args: [`--quality=${NO_SITE}`], expectRc: 1,
    evidence: ['site-names-no-file (1', 'holds no source citation at all',
      'read_answer merchants.settings.brand_color gives the site'],
    absent: ['the exemption is covering a claim nothing judges'],
    check: onlyClass('site-names-no-file'),
  },
  {
    name: 'silence the absent-file rule and the belt reddens the row the class promised was already reddened',
    // The one arm where the MUTANT is a reader rather than an answer: on the shipped plane all three plane-fact
    // classes carry their own site offender, so the belt's own message has no reachable member — which is a rule
    // the gate does not have until something shows it firing. Turning off the rule the class leans on is that
    // something, and the arm above is its control: same fixture, same source, belt quiet there and loud here.
    run: () => runReader(READER_NO_FILE_RULE, `--quality=${ABSENT_SITE}`),
    expectRc: 1,
    evidence: ['file-not-on-this-plane (1', 'the exemption is covering a claim nothing judges',
      'read_answer merchants.settings.brand_color is reported as file-not-on-this-plane'],
    absent: ['no file in the'],
    check: onlyClass('file-not-on-this-plane'),
  },
  {
    name: 'a miss whose cited name is held by two files is named ambiguous, and the run reddens on the same row',
    args: [`--quality=${AMBIGUOUS}`], expectRc: 1,
    evidence: ['site-file-ambiguous (1', 'the name is ambiguous'],
    check: onlyClass('site-file-ambiguous'),
  },
  {
    name: 'a miss whose site resolves inside the walked roots is the one hand-judged class, and it is named as that',
    args: [`--quality=${NOT_IN_FILE}`], expectRc: 0,
    evidence: ['not-read-in-the-file-where-it-should-be (1', 'genuinely judged by hand'],
    // It stays a report, not a verdict: the row is on this plane, the census walked it, and only a human can say
    // whether the read went through a helper. The other four classes are decidable, so the run reddens. The
    // unnamed verdict below must stay absent here: this row IS described, and a charge that fires on a named
    // class would be the reader disagreeing with its own table.
    check: onlyClass('not-read-in-the-file-where-it-should-be'),
    absent: ['NO STATED REASON'],
  },
  {
    name: 'the same row filed under a class the sentence table lost reddens — a classification with no sentence is still a miss',
    // D196, and the two arms above and below are one measurement: the same fixture, the same source, the only
    // difference being whether this reader has a sentence for the class its classifier chose. Renaming a key is
    // a change no answer plant can make, so this is the mutant-reader arm for a charge that no data on this
    // plane can reach — which is also why it had gone unnoticed: the unnamed branch prints a full sentence and
    // exits 0 over it, the defect `branchlessKinds` had, mirrored one line further down.
    run: () => runReader(READER_UNNAMED_CLASS, `--quality=${NOT_IN_FILE}`), expectRc: 1,
    evidence: ['NO STATED REASON (1 row(s) across 1 class(es))',
      'not-read-in-the-file-where-it-should-be (1): no stated reason',
      'REPORT COMPLETE — 1 reason(s) to redden, --report false, this run exits 1'],
    check: onlyClass('not-read-in-the-file-where-it-should-be'),
  },
  {
    name: 'a declared triple whose answer row this run parsed no site for is refused — an unnamed excuse is silence',
    args: [`--quality=${UNATTRIBUTED}`], expectRc: 2,
    evidence: ['RESULT: NOT CHECKED', 'cannot say where it looked', 'merchants.settings.brand_color'],
  },
  {
    name: 'no falsifier invocation in the gate carries an environment prefix its harness does not read',
    expectRc: 0,
    run: () => {
      const gate = readFileSync(join(ROOT, 'scripts', 'db_gate_fresh.sh'), 'utf8').split('\n');
      const { all, prefixed } = falsifierInvocation(gate);
      const live = all.length >= 3;
      const inert = prefixed.filter((p) => !p.reads);
      const out = `falsifier invocations found ${all.length}: ${all.join(', ')} | environment prefixes ${prefixed.length}`
        + `${prefixed.length ? ` (${prefixed.map((p) => `${p.name} -> ${p.file}`).join(', ')})` : ''}`
        + `${inert.length ? ` | INERT: ${inert.map((p) => `${p.name} -> ${p.file}`).join(', ')}` : ''}`;
      return { rc: live && inert.length === 0 && prefixed.length === 0 ? 0 : 1, out, census: null, spans: null };
    },
  },
  {
    name: 'the same predicate reddens when a plane prefix is put back in front of a harness that reads none',
    expectRc: 0,
    run: () => {
      const gate = readFileSync(join(ROOT, 'scripts', 'db_gate_fresh.sh'), 'utf8');
      const from = '( cd "$ROOT" && node scripts/falsify_quality_seam.mjs )';
      const to = '( cd "$ROOT" && GATE_QUALITY_SQL="$WT/data/seed/quality.sql" node scripts/falsify_quality_seam.mjs )';
      // Step 7 runs this harness inside the gate AND step 13 runs it again on the committed plane, so the anchor
      // is every place the gate invokes it, not one line someone remembered. A plant that hit only the first
      // would leave the second bare and report a red the gate does not have.
      const hits = gate.split(from).length - 1;
      if (hits < 1) return { rc: 1, out: `the plant's anchor occurs ${hits} time(s) in the shipped gate — the`
        + ' predicate has nothing to plant on', census: null, spans: null };
      const { prefixed } = falsifierInvocation(gate.split(from).join(to).split('\n'));
      const inert = prefixed.filter((p) => !p.reads);
      const out = `planted on ${hits} invocation(s): ${prefixed.length} prefix(es) read back, ${inert.length}`
        + ` of them inert${inert.length ? ` (${inert.map((p) => p.name).join(', ')})` : ''}`;
      return { rc: inert.length === hits ? 0 : 1, out, census: null, spans: null };
    },
  },
];

let held = 0;
const misses = [];
for (const arm of ARMS) {
  const r = arm.run ? arm.run() : run(...arm.args);
  const why = armReasons(arm, r);
  if (why.length === 0) {
    held += 1;
    console.log(`ok    ${arm.name}  [rc ${r.rc}]`);
  } else {
    misses.push(arm.name);
    console.log(`FAIL  ${arm.name}  — ${why.join('; ')}`);
    const interesting = (l) => l.includes('ANSWER SITES') || l.startsWith('  - ') || l.includes('RESULT: NOT CHECKED')
      || l.includes('CENSUS COVERAGE') || l.includes('ANSWER KINDS UNUSED') || l.includes('REPORT COMPLETE')
      || MISS_CLASSES.some((c) => l.startsWith(`  ${c} (`));
    console.log(`      ${r.out.split(/\r?\n/).filter(interesting).join('\n      ')}`);
  }
}

console.log(`\nCONTROL CENSUS — ${JSON.stringify(N)} line spans ${JSON.stringify(S)} (the tracked plane's own numbers)`);
// The population the arms score against, printed rather than remembered: a verdict over a set nobody can see is
// a number, not a measurement (D173's lesson, applied to this harness's own lists).
console.log(`DERIVED VOCABULARY — ${MISS_CLASSES.length} miss class(es) · ${VERDICT_MARKS.length} verdict head(s) over`
  + ` ${READER_SRC.split('\n').length} reader line(s) · terminal pattern from its last template line`);
for (const c of MISS_CLASSES) console.log(`  class   ${c}`);
for (const h of VERDICT_MARKS) console.log(`  verdict ${h}`);
console.log(`  excluded ${PROSE_FOOTER.slice(0, 72)}… — the reader's own prose, matched by shape and kept out of the list`);
console.log(ARMS.length - misses.length === ARMS.length
  ? `RESULT: PASS — ${held} of ${ARMS.length} arms held; the seam reaches the site census and the gate step that runs it`
  : `RESULT: FAIL — ${held} of ${ARMS.length} arms held; did not hold: ${misses.join(' | ')}`);
process.exit(misses.length === 0 ? 0 : 1);
