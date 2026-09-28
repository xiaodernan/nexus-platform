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
  const base = { rc: r.status, scanned: scanned ? +scanned[1] : null,
    coverage: coverage ? +coverage[1] : null, out,
    // A reader that died on the way to its verdict has not judged anything: an arm over it must be reported as
    // a crash, not as the red or the green its rc would otherwise look like (D165's mutant taught this).
    crashed: !out.includes('NEXUS — jsonb key reads') && !out.includes('RESULT: NOT CHECKED') };
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

// The five classes the shipped reader says it can tell apart. Every miss arm below claims exactly ONE of them
// holds the planted row: a run that printed all five sentences would otherwise let an arm pass on a classifier
// that had decided nothing.
const MISS_CLASSES = ['file-not-on-this-plane', 'site-file-ambiguous', 'site-names-no-file',
  'outside-the-census-roots', 'not-read-in-the-file-where-it-should-be'];
const classCounts = (r) => MISS_CLASSES.map((c) => reason(r.out, c));
const onlyClass = (name) => (r) => {
  const counts = classCounts(r);
  const wrong = MISS_CLASSES.filter((c, i) => counts[i] !== (c === name ? 1 : 0));
  return wrong.length
    ? `${MISS_CLASSES.map((c, i) => `${c}=${counts[i]}`).join(' ')} — only ${name} should hold a member` : null;
};

// A parse refusal is total: the reader stops before its header, so nothing it reports can be read as an answer.
// An arm that only checked exit 2 would also pass a run that refused AND answered.
const noVerdictPrinted = (r) => (['NEXUS — jsonb key reads', 'ANSWER SITES', 'FALSE SITES', 'CENSUS COVERAGE']
  .filter((h) => r.out.includes(h)).length
  ? `the run printed ${['NEXUS — jsonb key reads', 'ANSWER SITES', 'FALSE SITES', 'CENSUS COVERAGE']
    .filter((h) => r.out.includes(h)).join(', ')} alongside the refusal — a census that cannot parse its input `
    + 'has no verdict to report' : null);

const ARMS = [
  {
    name: 'control — the seam over an unmutated copy leaves every census number where the tracked file put it',
    args: [`--quality=${CONTROL}`], expectRc: 0,
    census: (c) => same(c, N), spans: (s) => same(s, S),
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
    // whether the read went through a helper. The other four classes are decidable, so the run reddens.
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
  const why = [];
  if (r.rc !== arm.expectRc) why.push(`rc ${r.rc}, expected ${arm.expectRc}`);
  if (r.crashed) why.push('the reader died before printing a verdict or a refusal, so this arm measured a crash:'
    + ` ${r.out.split(/\r?\n/).filter((l) => l.trim() !== '')[0]?.slice(0, 160) ?? '(no output at all)'}`);
  for (const e of arm.evidence ?? []) if (!r.out.includes(e)) why.push(`does not print ${JSON.stringify(e)}`);
  for (const e of arm.absent ?? []) if (r.out.includes(e)) why.push(`prints ${JSON.stringify(e)} — this arm is the`
    + ' case where that sentence must stay quiet');
  if (arm.check) { const claim = arm.check(r); if (claim) why.push(claim); }
  if (arm.census && !arm.census(r.census ?? {})) why.push(`census ${JSON.stringify(r.census)}`);
  if (arm.spans && !arm.spans(r.spans ?? {})) why.push(`spans ${JSON.stringify(r.spans)}`);
  if (why.length === 0) {
    held += 1;
    console.log(`ok    ${arm.name}  [rc ${r.rc}]`);
  } else {
    misses.push(arm.name);
    console.log(`FAIL  ${arm.name}  — ${why.join('; ')}`);
    const interesting = (l) => l.includes('ANSWER SITES') || l.startsWith('  - ') || l.includes('RESULT: NOT CHECKED')
      || l.includes('CENSUS COVERAGE') || MISS_CLASSES.some((c) => l.startsWith(`  ${c} (`));
    console.log(`      ${r.out.split(/\r?\n/).filter(interesting).join('\n      ')}`);
  }
}

console.log(`\nCONTROL CENSUS — ${JSON.stringify(N)} line spans ${JSON.stringify(S)} (the tracked plane's own numbers)`);
console.log(ARMS.length - misses.length === ARMS.length
  ? `RESULT: PASS — ${held} of ${ARMS.length} arms held; the seam reaches the site census and the gate step that runs it`
  : `RESULT: FAIL — ${held} of ${ARMS.length} arms held; did not hold: ${misses.join(' | ')}`);
process.exit(misses.length === 0 ? 0 : 1);
