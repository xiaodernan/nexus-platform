#!/usr/bin/env node
/**
 * NEXUS D159 — arm gate step 9's `--plane` seam from the inside, and pin the crash that used to live in it.
 *
 * WHY THIS EXISTS. `scripts/check_comment_citations.mjs` walks a source tree, lifts every citation-shaped token
 * out of the comments, and hands the list to step 8's checker as one generated file. `--plane` is the knob that
 * points that walk at a fixture instead of the repository, and D152 gave the gate a way to pass it
 * (`GATE_COMMENT_PLANE`). For four days the seam had no witness: steps 7, 8, 10 and 12 each run a harness of
 * their own on every drive, and step 9 ran none, so nobody had ever shown that a false comment-plane citation
 * can stop the gate — or that the knob reaches the walk rather than the argument list.
 *
 * WHAT IT SHOWS, in order.
 *   · the seam reaches the census: an unmutated fixture plane answers PASS with `tokens found 1 in 1 file`, and
 *     moving one number in the same file reddens it. A control that prints the same verdict as its plant proves
 *     nothing, so the two are run separately and their counts are compared below.
 *   · a citation to a line past the end of a real file reddens it (PAST EOF), and a citation to a file the index
 *     does not hold reddens it (FILE NOT FOUND) — the second only once something else in the plane resolves,
 *     because a census in which no file at all resolved is a refusal (exit 2), not an offender list. Both cases
 *     are arms here, because which of the two an unresolvable citation produces is the whole question about it.
 *   · a plane with comments but no citation-shaped token is a refusal, not a green (D79's rule, reachable here
 *     only through `--plane`).
 *   · both spellings — `--plane <dir>` and `--plane=<dir>` — print the identical verdict. This is the D154-D157
 *     dialect question asked of step 9 for the first time.
 *   · the request that used to crash is now a refusal. Measured on HEAD b67bf69 before this file existed:
 *     `--plane --verbose` bound the string `--verbose` as the directory, scandir threw ENOENT, and the run
 *     exited 1 — this file's own exit code for "a citation is wrong", so a mistyped request reported a finding
 *     it never computed. Every refusal arm below therefore asserts the ABSENCE of a stack trace as well as the
 *     presence of the sentence; red from a crash is not evidence about the checker.
 *   · the knob is reachable from inside the runner: the shipped `scripts/db_gate_fresh.sh` is read for step 9's
 *     block, which must both run this harness and forward `GATE_COMMENT_PLANE` to the reader, and its `--help`
 *     must document the knob by name.
 *
 * NO DATABASE, NO SERVICE, NO WRITE INTO THE REPOSITORY. Fixtures live under the OS temp directory; the only
 * tracked file this harness opens is the gate script it greps. Runtime is a few seconds.
 *
 * The cited target is chosen, not hardcoded: `cli_args.mjs` must resolve to exactly one file in the tree, and
 * the past-EOF line is derived from that file's own length at run time, so the plant cannot rot past the end of
 * a file some other lane edits.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './source_index.mjs';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READER = join(ROOT, 'scripts', 'check_comment_citations.mjs');
const GATE = join(ROOT, 'scripts', 'db_gate_fresh.sh');
const CHECKER = join(ROOT, 'scripts', 'check_ledger_citations.mjs');
const refuse = (m) => { console.error(`RESULT: NOT CHECKED — ${m}`); process.exit(2); };

// D192 — this harness takes a checker now, mirroring the `--reader` seam D165 had to add before its mutant arm
// could exist at all: without a way to aim every arm at a planted step 8, the floor that step 9 answers to
// would have shipped as a sentence with no run behind it.
const SELF = parseFlags(process.argv.slice(2), { '--checker': { kind: 'value', unit: 'reader file' } });
if (!SELF.ok) refuse(SELF.reason);
const PLANTED = SELF.value['--checker'] ?? null;

const BASENAME = 'cli_args.mjs';
const matches = walkFiles(ROOT, (n) => n === BASENAME);
if (matches.length !== 1) {
  refuse(`a citation to ${BASENAME} must resolve to exactly one file to be a control, and the index holds `
    + `${matches.length} (${matches.join(', ') || 'none'})`);
}
const TARGET_LINES = readFileSync(join(ROOT, matches[0]), 'utf8').replace(/\r\n/g, '\n').split('\n').length;
const PAST_END = TARGET_LINES + 1;

// --------------------------------------------------------------------------- fixture planes
const ROOT_FIX = mkdtempSync(join(tmpdir(), 'nexus-d159-plane-'));
/** A one-file source plane whose comment carries exactly one citation, aimed at `line`. */
function plane(name, line, cite = BASENAME) {
  const dir = join(ROOT_FIX, name, 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.sql'), [
    '-- NEXUS fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `-- one citation-shaped token, aimed at ${cite} line ${line}:`,
    `--   ${cite}:${line}`,
    'SELECT 1;',
    '',
  ].join('\n'), 'utf8');
  return join(ROOT_FIX, name);
}
function emptyPlane(name) {
  const dir = join(ROOT_FIX, name, 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.sql'), '-- a comment that cites nothing at all\nSELECT 1;\n', 'utf8');
  return join(ROOT_FIX, name);
}
/** One citation the index resolves and one it does not, so the run has a plane to certify an offender against. */
function mixedPlane(name, goodLine, badCite) {
  const dir = join(ROOT_FIX, name, 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.sql'), [
    '-- NEXUS fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `--   ${BASENAME}:${goodLine}`,
    `--   ${badCite}:3`,
    'SELECT 1;',
    '',
  ].join('\n'), 'utf8');
  return join(ROOT_FIX, name);
}
const CONTROL = plane('control', 12);
const PAST_EOF = plane('past-eof', PAST_END);
// `FILE NOT FOUND` was this harness's first missed prediction, and the miss was the finding: a plane whose only
// citation points outside the index never reaches an offender verdict, because step 8 refuses to certify a census
// where 0 of its files resolved (its own non-vacuity guard, pinned by falsify_ledger_text.mjs). Exit 2, not 1.
// The mixed plane below is the arm that can show the FILE NOT FOUND vocabulary, and the one above now shows
// something better — that step 9 passes the child's reason through instead of swallowing it (see its filter).
const MISSING = 'd159_no_such_file_held_by_no_index.sql';
const NO_FILE = plane('no-file', 3, MISSING);
const MIXED = mixedPlane('mixed', 12, MISSING);
const SILENT = emptyPlane('silent');

const run = (...args) => spawnSync(process.execPath,
  [READER, ...(PLANTED ? [`--checker=${PLANTED}`] : []), ...args], { cwd: ROOT, encoding: 'utf8' });

// D206 — a plane carrying TWO offenders, which is the smallest census that can show one offender row the map
// places and one it cannot. Both offending names are held by nothing, so both are `FILE NOT FOUND`. The third
// citation is one the index DOES resolve, and it is not decoration: measured on the first run of this arm, a
// plane of nothing but phantoms never reaches an offender verdict at all — step 8 refuses with `NOT CHECKED — 2
// citation(s) found and 0 file(s) resolved`, its own non-vacuity guard, and step 9 answers `step 8 produced no
// report`. That is the D159 lesson repeated one layer down: an arm must be built on a plane that can offend.
function twoBadPlane(name, goodLine, badA, badB) {
  const dir = join(ROOT_FIX, name, 'src');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.sql'), [
    '-- scratch fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `--   ${BASENAME}:${goodLine}`,
    `--   ${badA}:3`,
    `--   ${badB}:4`,
    'SELECT 1;',
    '',
  ].join('\n'), 'utf8');
  return join(ROOT_FIX, name);
}
const TWO_BAD = twoBadPlane('two-bad', 12, 'd206_no_such_file_a.sql', 'd206_no_such_file_b.sql');

// D207 — the vocabulary's own plane. `probe.toml` carries one cite the index resolves and one it does not, because
// a phantom-only census trips step 8's `0 file(s) resolved` refusal before any offender exists (D206/M3 learned
// that the hard way). `probe.d207unknown` holds a citation-shaped comment in an extension no vocabulary lists.
function tomlPlane(name, goodLine, badCite) {
  const dir = join(ROOT_FIX, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.toml'), [
    '# scratch fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `# a cite the index resolves: ${BASENAME}:${goodLine}`,
    `# a cite it does not: ${badCite}:3`,
    'x = 1',
    '',
  ].join('\n'), 'utf8');
  return join(ROOT_FIX, name);
}
const TOML = tomlPlane('toml', 12, MISSING);
const STRAY_DIR = join(ROOT_FIX, 'stray');
mkdirSync(STRAY_DIR, { recursive: true });
writeFileSync(join(STRAY_DIR, 'probe.sql'),
  ['-- scratch fixture — not shipped.', `--   ${BASENAME}:12`, 'SELECT 1;', ''].join('\n'), 'utf8');
writeFileSync(join(STRAY_DIR, 'probe.d207unknown'),
  ['# scratch fixture — not shipped.', `# see ${MISSING}:3`, ''].join('\n'), 'utf8');
const STRAY = STRAY_DIR;

// D208 — two planes whose only difference is a filename. `notes.txt` is prose `LEDGER_EXT` accepts as a cite
// TARGET but this census has no row for, so its citation must be counted as unjudged; the same bytes in
// `notes.sql` are inside the vocabulary and must be scored. The pair is the control that shows the split keys on
// the table, not on what the file says.
function prosePlane(name, fileName) {
  const dir = join(ROOT_FIX, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'probe.sql'), [
    '-- scratch fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `--   ${BASENAME}:12`, 'SELECT 1;', '',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, fileName),
    [`-- a citation in prose: ${BASENAME}:12`, ''].join('\n'), 'utf8');
  return dir;
}
const PROSE_TXT = prosePlane('prose-txt', 'notes.txt');
const PROSE_SQL = prosePlane('prose-sql', 'notes.sql');

// D210 — the path exclusion measured as a plane. Two files with identical bytes, one under `docs/` (the prefix this
// census skips) and one under `doks/` (a directory nobody's rule covers), plus a scored file in `src/` so neither
// plane can reach the read-nothing refusal. The `docs` half must PASS with the phantom named in the new row; the
// `doks` half must FAIL on the same phantom. That pair is the only witness that the row keys on the path and not
// on the prose: the two files differ in nothing but the directory they sit in.
function prefixPlane(name, dirName) {
  const dir = join(ROOT_FIX, name);
  mkdirSync(join(dir, dirName), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  const body = [
    '-- NEXUS fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
    `--   ${MISSING}:3`,
    'SELECT 1;',
    '',
  ].join('\n');
  writeFileSync(join(dir, dirName, 'probe.sql'), body, 'utf8');
  writeFileSync(join(dir, 'src', 'probe.sql'),
    [`--   ${BASENAME}:12`, 'SELECT 1;', ''].join('\n'), 'utf8');
  return dir;
}
const PREFIX = prefixPlane('prefix-docs', 'docs');
const PREFIX_OTHER = prefixPlane('prefix-doks', 'doks');

// --------------------------------------------------------------------------- the arms
const results = [];
/** The verdict is stated before the shipped reader runs, so an arm cannot be written from what it printed. */
async function arm(name, expect, must, absent, args) {
  const r = args === null ? { status: 0, stdout: '', stderr: '' } : run(...args);
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const missed = must.filter((re) => !re.test(out));
  const unwanted = absent.filter((re) => re.test(out));
  results.push({ name, expect, code: r.status ?? 1, missed, unwanted, out });
}
const CRASH = [/ENOENT/, /\bError:/, /at .*check_comment_citations\.mjs:\d+/, /Node\.js v\d+/];

await arm('control — an unmutated plane answers PASS with the one token the fixture holds', 0,
  [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/], [], ['--plane', CONTROL]);
await arm('the same request in the `=` spelling prints the identical verdict', 0,
  [/RESULT: PASS/], [], [`--plane=${CONTROL}`]);
await arm('a cited line past the end of a file the index does hold — PAST EOF, and no stack trace', 1,
  [/RESULT: FAIL/, /PAST EOF/], CRASH, ['--plane', PAST_EOF]);
await arm('a plane whose only citation points outside the index: step 8 refuses and step 9 passes the reason', 2,
  [/RESULT: NOT RUN/, /0 file\(s\) resolved/], CRASH, ['--plane', NO_FILE]);
await arm('one resolvable cite plus one phantom — the phantom is an offender, and the run reddens', 1,
  [/RESULT: FAIL/, /FILE NOT FOUND/, /tokens found\s+2 in 1 file\(s\)/], CRASH, ['--plane', MIXED]);
// D205 — the same plane, asked the next question: does the red say who wrote it? Before the author map, the only
// place an offender appeared named the generated census and its one shared heading, so the row pointed at a line
// of a file nobody edits. The fixture's phantom is on line 3 of `src/probe.sql`, and that is what must be printed.
await arm('the offender names the comment that wrote it, not the census line that carries it', 1,
  [/OFFENDER AUTHORS — the comment behind each offending row above \(1 of 1 offender\(s\), 0 row\(s\) the plant does not account for\)/,
    /- src\/probe\.sql:3  wrote the cite/, /FILE NOT FOUND/],
  [...CRASH, /RESULT: PASS/], ['--plane', MIXED]);
// D207 — the shipped reader over the two new planes. Predicted before running: TOML reddens with exactly one
// offender (the phantom, on the third line of a file step 9 never opened before this unit) and its author line
// names probe.toml at that line; STRAY passes, because the file it cannot read is reported by name in the coverage
// row rather than scored — disclosure, not judgement.
await arm('D207/T1 — a `.toml` comment is in the census now: its resolvable cite clears and its phantom offends',
  1, [/RESULT: FAIL/, /tokens found\s+2 in 1 file\(s\)/, /FILE NOT FOUND/, /- probe\.toml:3  wrote the cite/],
  CRASH, ['--plane', TOML]);
await arm('D207/C1 — an extension the vocabulary does not hold is named in the coverage row, not silently skipped',
  0, [/RESULT: PASS/, /\.d207unknown\(1\)/], CRASH, ['--plane', STRAY]);
// D208 — predicted before either plane ran: PROSE_TXT judges one token (probe.sql) and puts the other in the new
// row, because `.txt` is inside step 8's cite-target predicate and outside this census's table; PROSE_SQL judges
// both and prints the row as an empty set. The bytes are identical in the two planes, so the only difference the
// arm can be responding to is the filename. The forbidden texts are the offender ROW shape and the offender COUNT,
// not the words: step 8's explanatory paragraph contains the phrase "FILE NOT FOUND" on a plane with no offenders
// and this reader relays that line, so a witness aimed at the word would be a permanent red (measured first run).
await arm('D208/P1 — a `.txt` cite is counted as prose no reader opens, and is not scored as a census bullet', 0,
  [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/,
    /prose, no reader\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.txt\(1 file\(s\), 1 token\(s\)\)/,
    /as prose: 0 of those hold a mapped extension/,
    /while 0 file\(s\) have no `COMMENT` row here and are pulled out of the count above/],
  [...CRASH, /- notes\.txt/, /strict offenders\s+[1-9]/], ['--plane', PROSE_TXT]);
await arm('D208/P2 — the same bytes named `.sql` are scored, so the row keys on the vocabulary table, not the content',
  0, [/RESULT: PASS/, /tokens found\s+2 in 2 file\(s\)/,
    /prose, no reader\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
  CRASH, ['--plane', PROSE_SQL]);
// D210 — the path skip gets its own row, and the row has to answer for a file. Predicted before running: PREFIX
// reads 1 mapped file (src), skips 1 (docs/probe.sql), so `ext coverage` says 1 read and the new row names
// `.sql(1 file(s), 1 token(s))` and the phantom is nowhere in the offender list — the plane PASSes with a citation
// it never scored, which is exactly what the row is for. PREFIX_OTHER is the same bytes in `doks/`: 2 read, 2
// tokens, the phantom an offender, exit 1. If those two arms ever print the same thing, the rule has stopped
// keying on the path.
await arm('D210/S1 — a mapped file under the excluded prefix is named by the new row and not counted as read', 0,
  [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/, /ext coverage\s+1 file\(s\) read/,
    /table, prefix-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.sql\(1 file\(s\), 1 token\(s\)\)/],
  [...CRASH, /FILE NOT FOUND/, /strict offenders\s+[1-9]/], ['--plane', PREFIX]);
await arm('D210/S2 — the identical bytes in a directory no rule covers are read, and the phantom offends', 1,
  [/RESULT: FAIL/, /tokens found\s+2 in 2 file\(s\)/, /ext coverage\s+2 file\(s\) read/,
    /table, prefix-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/, /FILE NOT FOUND/],
  [...CRASH, /RESULT: PASS/], ['--plane', PREFIX_OTHER]);
// D209 — the relay's filter. Step 8 prints its LIMITS paragraph as column-0 prose, and the old keyword filter
// pulled single sentences out of it, so a clean plane's report carried the line "does not hold that path and FILE
// NOT FOUND speaks first." — an offender class name in a run that filed no offenders. That fragment is where this
// unit came from: D208/P1 predicted a red from it and got one that meant nothing. Predicted before running: on
// CONTROL nothing indented and no verdict word survives (so no class name at all); on MIXED the class header and
// its bullet survive while the paragraph does not; on NO_FILE the child refused (exit 2), and a refusal relays
// whole — the child's own title line, column 0 and keyword-free, is the witness that the refusal branch is
// load-bearing rather than the filter being a filter.
await arm('D209/Q1 — a clean plane reports no offender class name, not even inside the child\'s prose', 0,
  [/RESULT: PASS/, /strict offenders\s+0/],
  [...CRASH, /FILE NOT FOUND/, /AMBIGUOUS/, /PAST EOF/, /does not hold that path/, /LIMITS, stated rather than implied/],
  ['--plane', CONTROL]);
await arm('D209/Q2 — the offender class header and its bullet are relayed; the child\'s explanatory paragraph is not',
  1, [/RESULT: FAIL/, /FILE NOT FOUND \(1\)/, /headings seen/, /- src\/probe\.sql:3  wrote the cite/],
  [...CRASH, /LIMITS, stated rather than implied/, /which is what keeps it a backlog/,
    /NEXUS — ledger citation census/], ['--plane', MIXED]);
await arm('D209/Q3 — when the child refuses, its whole report comes through, title line included', 2,
  [/RESULT: NOT RUN/, /NOT CHECKED — 1 citation\(s\) found and 0 file\(s\) resolved/, /NEXUS — ledger citation census/],
  CRASH, ['--plane', NO_FILE]);
// D208/P7 — the walk's own failure mode, measured while writing the two arms above: an unreadable `--plane` threw

// ENOENT at exit 1. Predicted after the guard: exit 2, the refusal names the path, and no stack line survives.
await arm('D208/P7 — `--plane` at a directory that is not there refuses, it does not crash at the FAIL code', 2,
  [/cannot open .*no-such-plane-dir/],
  [/RESULT: PASS/, /RESULT: FAIL/, /ENOENT: no such file or directory, scandir/, /at .*check_comment_citations\.mjs:\d+/],
  ['--plane', join(ROOT_FIX, 'no-such-plane-dir')]);
await arm('a plane of comments that cites nothing is a refusal, not a green (D79)', 2,
  [/0 tokens found in the comment plane/], CRASH, ['--plane', SILENT]);
await arm('`--plane --verbose` refuses: the request whose swallowed value used to throw ENOENT at exit 1', 2,
  [/there is no directory to read/], CRASH, ['--plane', '--verbose']);
await arm('an empty `--plane=` refuses rather than falling back to the repository', 2,
  [/--plane was given without a directory/], CRASH, ['--plane=']);
await arm('a switch given a value refuses instead of being read as absent', 2,
  [/--verbose is a switch and was given a value/], CRASH, ['--plane', CONTROL, '--verbose=1']);
await arm('an unknown option refuses and names the flags this reader takes', 2,
  [/unknown option --planex/, /flags this reader parses/], CRASH, ['--planex', CONTROL]);
await arm('a bare positional refuses rather than becoming the plane', 2,
  [/unexpected argument/], CRASH, [CONTROL]);

// --------------------------------------------------------------------------- D192: the offender belt
await arm('the belt answers to a count the child prints, once, on the plane step 9 runs', 0,
  [/RESULT: PASS/, /strict offenders\s+0 offender\(s\)/], [/printed 0 strict-offender count/],
  ['--plane', CONTROL]);
await arm('`--checker` with no file refuses instead of scoring nothing', 2,
  [/--checker was given without a reader file/], CRASH, ['--checker']);
await arm('`--checker` aimed at a file that does not exist refuses with 2, not a stack at 1', 2,
  [/could not be opened \(ENOENT\)/, /check_comment_citations\.mjs: the step-8 reader/],
  [/\bError:/, /at .*check_comment_citations\.mjs:\d+/, /Node\.js v\d+/],
  ['--checker=/no/such/reader.mjs', '--plane', CONTROL]);

// The floor's own witness: rename the carrier out of a copy of step 8 and every verdict arm must turn into the
// refusal it used to skip. Skipped when `--checker` already aims this run at a plant — there is nothing to
// plant inside a plant.
if (PLANTED === null) {
  const MDIR = join(tmpdir(), `nexus-d192-mutant-${process.pid}`);
  mkdirSync(MDIR, { recursive: true });
  const src = readFileSync(CHECKER, 'utf8');
  const anchor = '  strict offenders         ${strict.offenders.length} offender(s) on the plane this run judges';
  const hits = src.split(anchor).length - 1;
  let code = -1;
  let out = '';
  if (hits !== 1) {
    out = `the carrier line appears ${hits} times in step 8 — the mutant has no anchor`;
  } else {
    try {
      writeFileSync(join(MDIR, 'check_ledger_citations.mjs'),
        src.replace(anchor, '  strict offenders renamed ${strict.offenders.length} count(s) on the plane this run judges'),
        'utf8');
      for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
        writeFileSync(join(MDIR, sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
      }
      const child = spawnSync(process.execPath,
        [join(ROOT, 'scripts', 'falsify_comment_plane.mjs'), `--checker=${join(MDIR, 'check_ledger_citations.mjs')}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
      code = child.status ?? -1;
      out = `${child.stdout ?? ''}${child.stderr ?? ''}`;
    } catch (e) {
      out = `the mutant could not be run: ${e.message}`;
    }
  }
  rmSync(MDIR, { recursive: true, force: true });
  results.push({
    name: 'a step 8 whose carrier line is renamed reddens every verdict arm — the floor, not the wording',
    expect: 1, code,
    missed: [/MISSED\s+exit 0 expected, \d+ printed\s+control —/,
      /MISSED\s+exit 1 expected, \d+ printed\s+one resolvable cite plus one phantom/,
      /MISSED\s+exit 0 expected, \d+ printed\s+the belt answers to/,
      /printed 2 strict-offender count|printed 0 strict-offender count/,
      /RESULT: FAIL/, /\(skipped\) the floor's own witness/].filter((re) => !re.test(out)),
    unwanted: [], out,
  });
} else {
  console.log(`  (skipped) the floor's own witness: this run is already aimed at a planted checker (${PLANTED})`);
}

// --------------------------------------------------------------------------- D206: the attribution map's own floor
// D205 added two `RESULT: NOT RUN` guards between the offender report and a verdict, and recorded in its own commit
// message that neither had ever fired. A guard nobody has seen red is a sentence about a floor, not a floor. Step 9
// imports only its flag parser and its walker from the directory next to itself, and takes the resolver as a flag,
// so a copy of it in a temp `scripts/` is a complete reader: aim it at the SHIPPED step 8 and a fixture plane and
// nothing outside the mutant has to be touched. The four predictions below were written before any mutant ran; the
// verbatim copy is one of them, because without it a red could belong to the relocation rather than the mutation.
if (PLANTED === null) {
  const ANCHOR = 'const bulletAt = new Map(rows.map((r, i) => [PLANT_HEAD.length + i + 1, r]));';
  // `String.raw`, because the row's own text contains `\s`: a string literal that lost the backslash would match
  // zero bytes and the arm would report "the anchor appears 0 times" — a red that is about my escaping, not the code.
  const TOML_ROW = String.raw`  '.toml': [/(^|\s)#/],`;
  // D209 — the relay clause, one line, three terms. `String.raw` for the same reason as TOML_ROW: it carries `\s`.
  const RELAY_ROW = String.raw`  .filter((l) => code === 2 || /^\s/.test(l) || VERDICT_LINE.test(l))`;
  const check = (name, expect, must, absent, r) => results.push({
    name, expect, code: r.code,
    missed: must.filter((re) => !re.test(r.out)),
    unwanted: absent.filter((re) => re.test(r.out)),
    out: r.out,
  });
  /** `hits !== 1` is reported as the arm's own red — a mutant that lost its anchor tests nothing at all.
   *  D207 widened it from "the map anchor" to "any single anchor in step 9's bytes", because the vocabulary row
   *  needs arming the same way and the mechanism is identical: copy the reader, replace one string, run it. */
  /** D211 widens it with a checker of its own: an arm that needs step 8 to name one of the plane's files as its
   *  prose cannot be shown against a verbatim step 8 — the identity test is the thing under test. */
  const drive = (tag, anchor, replacement, planeDir, checker = CHECKER) => {
    const dir = join(tmpdir(), `nexus-d206-${tag}-${process.pid}`);
    const src = readFileSync(READER, 'utf8').replace(/\r\n/g, '\n');
    const hits = src.split(anchor).length - 1;
    let code = -1;
    let out = '';
    if (hits !== 1) {
      out = `the mutant anchor appears ${hits} times in step 9 — no mutant was written`;
    } else {
      try {
        mkdirSync(join(dir, 'scripts'), { recursive: true });
        for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
          writeFileSync(join(dir, 'scripts', sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
        }
        const path = join(dir, 'scripts', 'check_comment_citations.mjs');
        writeFileSync(path, src.replace(anchor, replacement), 'utf8');
        const r = spawnSync(process.execPath, [path, `--checker=${checker}`, '--plane', planeDir],
          { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
        code = r.status ?? -1;
        out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      } catch (e) {
        out = `the mutant could not be run: ${e.message}`;
      }
    }
    rmSync(dir, { recursive: true, force: true });
    return { code, out };
  };
  const NOT_RUN = [/RESULT: NOT RUN/];
  check('D206/C0 — a verbatim copy of step 9 in another directory reads the plane the shipped reader reads',
    1, [/RESULT: FAIL/, /tokens found\s+2 in 1 file\(s\)/, /- src\/probe\.sql:3  wrote the cite/], NOT_RUN,
    drive('copy', ANCHOR, ANCHOR, MIXED));
  check('D206/M1 — a map that places nothing reddens the run as a refusal that counts the bullets it had',
    2, [/RESULT: NOT RUN — step 8 filed 1 offender row\(s\) naming this reader's own plant and none of them matched a bullet this census wrote \(2 bullet\(s\)\)/], [/RESULT: PASS/, /RESULT: FAIL/],
    drive('m1', ANCHOR, 'const bulletAt = new Map();', MIXED));
  check('D206/M2 — the map\'s line arithmetic is load-bearing: off by one and the reader names the wrong comment',
    1, [/RESULT: FAIL/, /OFFENDER AUTHORS/, /- src\/probe\.sql:2  wrote the cite/],
    [/RESULT: NOT RUN/, /- src\/probe\.sql:3  wrote the cite/],
    drive('m2', ANCHOR, 'const bulletAt = new Map(rows.map((r, i) => [PLANT_HEAD.length + i + 2, r]));', MIXED));
  // Predicted before the run: the spacing mutation keys row 0 at plant line 9 and row 2 at 11, so of the two
  // offender bullets (10 and 11) exactly one is placed. authors.size is 1, which keeps the FIRST guard silent, and
  // unplaced is 1 — the case only a two-offender plane can reach, because the shipped text says "outside the N
  // bullet(s) this census wrote" and a lone offender that misses is the other guard's red.
  check('D206/M3 — a plant line the census cannot account for is a disagreement, not a partial answer',
    2, [/RESULT: NOT RUN — 1 offender row\(s\) cited a plant line outside the 3 bullet\(s\) this census wrote/],
    [/RESULT: PASS/, /RESULT: FAIL/, /none of them matched a bullet this census wrote/],
    drive('m3', ANCHOR, 'const bulletAt = new Map(rows.map((r, i) => [PLANT_HEAD.length + i * 2 + 1, r]));', TWO_BAD));
  // D207/T2 — the vocabulary row is armed the same way the map is: delete it from a copy and the plane that just
  // passed must turn into the refusal, which is the only proof that the row does the reading. Predicted: exit 2,
  // `0 tokens found in the comment plane`, and the coverage row naming `.toml(1)` as the extension it skipped.
  check('D207/T2 — delete the .toml vocabulary row and the same TOML plane reads nothing at all',
    2, [/0 tokens found in the comment plane/, /\.toml\(1\)/], [/RESULT: PASS/, /RESULT: FAIL/],
    drive('toml-off', TOML_ROW, '', TOML));
  // D209 — the relay clause has three terms and each one has to answer for a line on its own. Predictions written
  // before any mutant ran, and R0 is the control that makes the other two mean something: a verbatim copy of the
  // reader placed in a temp `scripts/` printed the same refusal whole (HELD), so a line that vanishes below is
  // gone because of the mutation, not because the reader moved.
  // R0 — verbatim copy on NO_FILE: exit 2, the child's title line, its refusal, step 9's own NOT RUN. Green.
  check('D209/R0 — a verbatim copy of the relay reader still relays the refusal whole', 2,
    [/RESULT: NOT RUN/, /NOT CHECKED — 1 citation\(s\) found and 0 file\(s\) resolved/, /NEXUS — ledger citation census/],
    [/RESULT: PASS/, /RESULT: FAIL/],
    drive('r0', RELAY_ROW, RELAY_ROW, NO_FILE));
  // R1 — drop `code === 2` and the refusal branch stops existing. Measured on the first run, exactly as predicted in
  // substance and mis-filed in shape: the ONLY line that disappears is the child's column-0, keyword-free title,
  // because the two indented rows survive on their own terms. An absence witness goes in `absent`, not `must` — a
  // `must` on a line the mutant was written to delete is an arm that can only report its own bookkeeping.
  check('D209/R1 — the refusal term is the only thing that carries the child\'s column-0 title', 2,
    [/RESULT: NOT RUN/, /NOT CHECKED — 1 citation\(s\) found and 0 file\(s\) resolved/],
    [/NEXUS — ledger citation census/, /RESULT: PASS/, /RESULT: FAIL/],
    drive('r1', RELAY_ROW, '  .filter((l) => false || /^\\s/.test(l) || VERDICT_LINE.test(l))', NO_FILE));
  // R2 — drop the indented term on MIXED, the plane that ships exit 1. Three relayed rows went: the class header
  // `FILE NOT FOUND (1)`, the `headings seen` row and the `strict offenders 1 offender(s)` count row — while the
  // verdict line stayed, because step 9 composes its verdict from the child's WHOLE output, not from the relay. That
  // is the failure mode D209 closes, and the arm states it as a contradiction the reader must not be able to print.
  // One row stayed that the first prediction said would go: the offender AUTHOR bullet. It is not relayed — step 9
  // builds the OFFENDER AUTHORS block from the rows it parsed itself, so attribution does not depend on the relay.
  // Asserted as a MUST, which makes this arm two-sided: the same mutation must delete three lines and keep one.
  check('D209/R2 — without the indented term the verdict and the author block stand on a gutted report', 1,
    [/RESULT: FAIL/, /- src\/probe\.sql:3  wrote the cite/],
    [/FILE NOT FOUND \(1\)/, /headings seen/, /strict offenders\s+1 offender\(s\)/, /RESULT: PASS/],
    drive('r2', RELAY_ROW, '  .filter((l) => code === 2 || false || VERDICT_LINE.test(l))', MIXED));
  // D210 — the walk-time skip, armed the same two ways: destroy the rule and the plane reddens, destroy only the
  // counting and the plane stays green while the file it skipped is named nowhere. The second is the defect this
  // unit closes, and it is only visible as an absence, so its witness is the row the mutant can no longer print.
  // D211 re-aimed these two anchors rather than loosening them: `walk` now holds one branch that asks identity
  // first (`LEDGER_FILES`) and path second, so S3 deletes the path TERM of the merged condition and S4 keeps the
  // skip while routing only the path half out of the count. Both keep the predictions they shipped with.
  const PROSE_OR_PATH = '    if (isProse || EXCLUDE_PREFIX.some((p) => rel.startsWith(p))) {\n';
  const MERGED_TALLY = '      tally(isProse ? ledges.proseSkip : ledges.skipped, ext, citeCount(abs, rx));\n';
  check('D210/S3 — delete the prefix rule and the docs phantom is scored: the skip is what hides it', 1,
    [/RESULT: FAIL/, /FILE NOT FOUND/, /tokens found\s+2 in 2 file\(s\)/,
      /table, prefix-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
    [/RESULT: PASS/, /ext coverage\s+1 file\(s\) read/],
    drive('s3', PROSE_OR_PATH, '    if (isProse) {\n', PREFIX));
  // S4 is the disappearance witness, filed the way D209/R1 had to be filed after its own red: the mutant's own
  // sentence is what the arm asserts. It claims one mapped file was read and zero were skipped, on a plane that
  // holds two — which is precisely the state this repository was in before this unit, and the reason the row exists.
  check('D210/S4 — keep the skip, drop its count, and the reader says one file read, none skipped, two walked', 0,
    [/RESULT: PASS/, /ext coverage\s+1 file\(s\) read/,
      /table, prefix-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
    [/table, prefix-skip\s+1 ext\(s\)/, /FILE NOT FOUND/, /ext coverage\s+2 file\(s\) read/],
    drive('s4', MERGED_TALLY, '      if (isProse) tally(ledges.proseSkip, ext, citeCount(abs, rx));\n', PREFIX));

  // ----------------------------------------------------------------------- D211: the skip that asks WHO owns the file
  // The row `table, prefix-skip` claims its group holds no file step 8 reads as prose, and until this unit nothing
  // tested that: `walk` consulted `LEDGER_FILES` only for extensions the COMMENT table LACKS. Measured on a plane
  // written for the purpose (docs/probe.py plus src/probe.sql, a copy of step 8 whose declaration adds
  // docs/probe.py): the reader printed `.py(1 file(s), 1 token(s))` in that group AND "and not one of the 3 file(s)
  // step 8 names as prose ... a citation here is read by neither reader", with the same PASS, the same token count
  // and no signal of any kind. So the predictions below were written against that measurement, not against hope.
  // Three separate things are load-bearing and each gets its own arm: the IDENTITY test (without it step 9 opens
  // step 8's prose and reads the same citation twice), the GROUP the skip is counted into (without the distinction
  // the file is disclosed as path-skipped, which is the false sentence again), and the ROW that prints the group
  // (without it the count is computed and seen by nobody).
  const DECL8 = "const LEDGERS = ARGS.text === null ? ['docs/DECISIONS.md', 'docs/STATUS.md'] : [ARGS.text];";
  /** A copy of step 8 that names one more file as its own prose. Planted under ROOT_FIX, so the harness's own
   *  cleanup removes it; the two modules step 8 imports go beside it because it is spawned as a reader — a copy
   *  that dies on its own import prints 0 of everything and proves 0 (D206's lesson, repeated here). */
  const plant8 = (tag, extraLedger) => {
    const dir = join(ROOT_FIX, `d211-chk-${tag}`, 'scripts');
    mkdirSync(dir, { recursive: true });
    for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
      writeFileSync(join(dir, sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
    }
    const src8 = readFileSync(CHECKER, 'utf8').replace(/\r\n/g, '\n');
    const hits = src8.split(DECL8).length - 1;
    if (hits !== 1) refuse(`step 8's ledger declaration appears ${hits} times in ${CHECKER} — the D211 plant has no anchor`);
    const path = join(dir, 'check_ledger_citations.mjs');
    writeFileSync(path, src8.replace(DECL8,
      DECL8.replace("'docs/STATUS.md']", `'docs/STATUS.md', '${extraLedger}']`)), 'utf8');
    return path;
  };
  function ledgerPlane(name, relPath) {
    const dir = join(ROOT_FIX, name);
    const parts = relPath.split('/');
    mkdirSync(join(dir, ...parts.slice(0, -1)), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, ...parts), [
      '# scratch fixture for scripts/falsify_comment_plane.mjs — not shipped, not scored by any gate.',
      `#   ${BASENAME}:12`, 'x = 1', '',
    ].join('\n'), 'utf8');
    writeFileSync(join(dir, 'src', 'probe.sql'), [`--   ${BASENAME}:12`, 'SELECT 1;', ''].join('\n'), 'utf8');
    return dir;
  }
  const LEDGER_DOCS = ledgerPlane('d211-docs', 'docs/probe.py');
  const LEDGER_OUTSIDE = ledgerPlane('d211-outside', 'notes/ledger.py');
  const CHK_DOCS = plant8('docs', 'docs/probe.py');
  const CHK_OUT = plant8('notes', 'notes/ledger.py');
  const direct = (checker, planeDir) => {
    const r = run('--checker', checker, '--plane', planeDir);
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const NO_OFFENDER = [...CRASH, /FILE NOT FOUND/, /strict offenders\s+[1-9]/];
  // Q1 and Q2 are the pair: identical bytes, identical paths, one reader unchanged except for a NAME in its own
  // declaration list. Predicted: Q1 puts .py in prefix-skip and (none) in prose-skip, Q2 the exact reverse.
  check('D211/Q1 — a mapped file under docs/ that step 8 does not name is path-skipped, and prose-skip says none', 0,
    [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/,
      /table, prefix-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.py\(1 file\(s\), 1 token\(s\)\)/,
      /table, prose-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
    NO_OFFENDER, direct(CHECKER, LEDGER_DOCS));
  check('D211/Q2 — the same bytes with the same path, named by step 8, move to the prose group: the row keys on the list', 0,
    [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/,
      /table, prose-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.py\(1 file\(s\), 1 token\(s\)\)/,
      /the 3 file\(s\) it reads as its own prose/,
      /table, prefix-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
    [...NO_OFFENDER, /\.py\(1 file\(s\), 1 token\(s\)\) — inside this census's vocabulary but under its own path rule/],
    direct(CHK_DOCS, LEDGER_DOCS));
  // Q3 is the mirror case the directory rule never covered: step 8's prose OUTSIDE `docs/`, in a mapped extension.
  // Predicted: prose-skip carries it, prefix-skip stays empty, and the census still reads exactly one file — the
  // citation is scored once, which is what D207's exclusion of `docs/` was written to buy.
  check('D211/Q3 — step 8 prose that lives outside the prefix is skipped by identity, not by the directory rule', 0,
    [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/, /ext coverage\s+1 file\(s\) read/,
      /table, prose-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.py\(1 file\(s\), 1 token\(s\)\)/],
    [...NO_OFFENDER, /ext coverage\s+2 file\(s\) read/], direct(CHK_OUT, LEDGER_OUTSIDE));
  const IDENTITY = '    const isProse = LEDGER_FILES.has(rel);';
  // Q4 destroys the identity test. Predicted on the outside plane: the file is now READING material for this
  // census (2 files, 2 tokens), still green on the verdict — the double read is invisible to the offender count
  // and visible only in the coverage row. Q5 destroys the same term on the docs plane, where the path rule still
  // hides the file, and the arm must catch the reader printing its own false sentence: prefix-skip naming .py
  // while claiming none of the 3 files step 8 names as prose is there.
  check('D211/Q4 — delete the identity test and step 9 opens step 8\'s prose: the same citation read twice', 0,
    [/RESULT: PASS/, /ext coverage\s+2 file\(s\) read/, /tokens found\s+2 in 2 file\(s\)/,
      /table, prose-skip\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
    NO_OFFENDER, drive('q4', IDENTITY, '    const isProse = false;', LEDGER_OUTSIDE, CHK_OUT));
  check('D211/Q5 — the same mutation under docs/, where the mutant prints the false sentence this unit closes', 0,
    [/RESULT: PASS/,
      /table, prefix-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.py\(1 file\(s\), 1 token\(s\)\)/,
      /and not one of the 3 file\(s\) step 8 names as prose/],
    [/table, prose-skip\s+1 ext\(s\)/, /RESULT: FAIL/],
    drive('q5', IDENTITY, '    const isProse = false;', LEDGER_DOCS, CHK_DOCS));
  // Q6 keeps the skip and loses only the attribution: the file is still never opened (so 1 file read, 1 token —
  // the state Q4 shows is the real damage), but it is disclosed as path-skipped, which is the claim this unit is
  // about. The pair Q4/Q6 is what separates "the test is load-bearing" from "the count is load-bearing".
  check('D211/Q6 — keep the skip, route it to the wrong group, and the reader calls step 8\'s prose a path rule', 0,
    [/RESULT: PASS/, /ext coverage\s+1 file\(s\) read/, /tokens found\s+1 in 1 file\(s\)/,
      /table, prefix-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.py\(1 file\(s\), 1 token\(s\)\)/],
    [/table, prose-skip\s+1 ext\(s\)/, /ext coverage\s+2 file\(s\) read/],
    drive('q6', MERGED_TALLY, '      tally(ledges.skipped, ext, citeCount(abs, rx));\n', LEDGER_OUTSIDE, CHK_OUT));
  // Q7 arms the disclosure itself: the group is filled correctly, but the row prints a constant empty shape. The
  // tail of the sentence stays printed, which is the witness that the row ran and lied rather than vanished.
  // Predicted wrong on the first run and corrected here, not relaxed: I asserted the group's own empty text
  // (`0 ext(s), 0 file(s), 0 token(s): (none)`) while the stub replaces that whole shape with a bare `(none)` —
  // the informative half of the arm is that the row prints a CONSTANT, so that is what it pins.
  check('D211/Q7 — a prose-skip row that reads a stub prints a constant "(none)" while the file it describes was skipped', 0,
    [/RESULT: PASS/,
      /table, prose-skip\s+\(none\) — inside this census's vocabulary and named by step 8/],
    [/\.py\(1 file\(s\), 1 token\(s\)\) — inside this census's vocabulary and named by step 8/,
      /table, prefix-skip\s+1 ext\(s\)/, /RESULT: FAIL/],
    drive('q7', '  const prose = nameList(ledges.proseSkip, 4);',
      "    const prose = { text: '(none)' };", LEDGER_DOCS, CHK_DOCS));

  // ----------------------------------------------------------------------------- D212: which clause a ledger belongs to
  // The row Q1–Q7 armed prints its ledger disclosure as TWO computed clauses now, because the single count it used
  // to print could not say whether it described the group above its own number: measured on this repository, both
  // ledgers are `.md`, `COMMENT` has no row for them, so `walk` pulled them out of the census's own group AND the
  // sentence beside it claimed that group holds none of step 8's prose — `2 file(s)` and `not one of the 2` on one
  // line. A first draft of this unit asserted the repo number was 0; running the reader printed 2, which is why the
  // wording, not a number, is what got changed. Three things are load-bearing and each takes its own arm: the NAME
  // (a ledger pulled out of the count must be visible somewhere), the CLAUSE it lands in (decided by the extension
  // table, not by prose), and the COUNT's survival when only the counting is destroyed.
  // Predicted before any of these ran, on one fixture plane and one planted checker (step 8's declaration adds
  // `docs/LEDGER.md`, so its list is 3 files): W1 names the file in the "no `COMMENT` row" clause and leaves the
  // prose-skip row empty; W2 adds a `.md` row to this census's own table and the SAME file moves to the other
  // clause, which is the pair that proves the split is read from the table; W3 keeps the file out of the census
  // group while deleting its disclosure, and the arm asserts the reader's own false sentence — a disappearance
  // witness filed the way D210/S4 had to be, since a `must` on the vanished name could only report bookkeeping.
  const LEDGER_MD = ledgerPlane('d212-md', 'docs/LEDGER.md');
  const CHK_MD = plant8('md', 'docs/LEDGER.md');
  const OPENED_ADD = '      if (LEDGER_FILES.has(rel)) ledges.opened.add(rel);';
  const MD_ROW = String.raw`  '.md': [/(^|\s)#/],`;
  check('D212/W1 — a `.md` ledger step 8 declares is named by the clause that says the table lacks its extension', 0,
    [/RESULT: PASS/, /tokens found\s+1 in 1 file\(s\)/,
      /as prose: 0 of those hold a mapped extension/,
      /while 1 file\(s\) \(docs\/LEDGER\.md\) have no `COMMENT` row here and are pulled out of the count above/],
    NO_OFFENDER, direct(CHK_MD, LEDGER_MD));
  check('D212/W2 — one `COMMENT` row for `.md` moves the same file to the other clause: the split is computed', 0,
    [/RESULT: PASS/,
      /table, prose-skip\s+1 ext\(s\), 1 file\(s\), 1 token\(s\): \.md\(1 file\(s\), 1 token\(s\)\)/,
      /as prose: 1 of those hold a mapped extension and are named by the `table, prose-skip` row above/,
      /while 0 file\(s\) have no `COMMENT` row here/],
    [...NO_OFFENDER, /\(docs\/LEDGER\.md\) have no/],
    drive('w2', TOML_ROW, `${TOML_ROW}\n${MD_ROW}`, LEDGER_MD, CHK_MD));
  check('D212/W3 — keep the file out of the census, drop its disclosure, and the row says none were pulled out', 0,
    [/RESULT: PASS/, /prose, no reader\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/,
      /while 0 file\(s\) have no `COMMENT` row here and are pulled out of the count above/],
    [...NO_OFFENDER, /docs\/LEDGER\.md/, /table, prose-skip\s+1 ext\(s\)/],
    drive('w3', OPENED_ADD, '      if (LEDGER_FILES.has(rel)) { /* read by step 8, named by neither clause */ }',
      LEDGER_MD, CHK_MD));

  // --------------------------------------------------------------------------- D213: the clause that names the OTHER reader
  // Step 9's row ends "a citation in either group is scored by step 8 alone". That is a claim about step 8's
  // DEFAULT mode, and until this arm no witness in this file had ever run that mode: every arm reaches step 8 as
  // step 9's child through `--text=<plant>`, which reads one file and never the declared ledger list. Measured
  // before the arm was written (a Temp probe, nothing shipped): declaring one more tracked file as prose moves
  // `headings seen` and `name:number tokens` and puts that file's own citations under judgement — control exit 0
  // with 768 tokens, mutant exit 1 with 775 and offenders attributed to the newly declared file.
  // The pin is that MOVEMENT, on purpose. An arm asserting "the declared file has at least one offender" would
  // ride on another lane's content: the day someone fixes the blank line it cites, the arm reddens while the
  // mechanism is untouched. Reading-more is the mechanism, and it is monotone in the file it adds.
  const defaultMode = (checker) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [checker], { cwd: ROOT, encoding: 'utf8' }) };
    } catch (err) {
      return { code: err.status ?? 'null', out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  };
  {
    const rowNum = (out, label) => {
      const hit = out.match(new RegExp(`^ +${label.source} +(\\d+)`, 'm'));
      return hit ? Number(hit[1]) : NaN;
    };
    const ctl = defaultMode(CHECKER);
    const mut = defaultMode(plant8('d213', 'docs/PLAN.md'));
    const before = { sections: rowNum(ctl.out, /headings seen/), tokens: rowNum(ctl.out, /name:number tokens/) };
    const after = { sections: rowNum(mut.out, /headings seen/), tokens: rowNum(mut.out, /name:number tokens/) };
    const read = [before.sections, before.tokens, after.sections, after.tokens].every(Number.isFinite);
    const grew = read && after.sections > before.sections && after.tokens > before.tokens;
    const reason = grew ? [] : [/declaring one more ledger made step 8 read MORE of the repository/];
    results.push({
      name: `D213/X1 — step 8's default mode censises every file it declares, so step 9's "scored by step 8 alone"`
        + ` clause has a reader behind it (sections ${before.sections}->${after.sections},`
        + ` tokens ${before.tokens}->${after.tokens}; exits ${ctl.code}/${mut.code})`,
      expect: 0, code: grew ? 0 : 1, missed: reason, unwanted: [],
      out: grew ? '' : `control exit ${ctl.code}, mutant exit ${mut.code}: the census did not grow on both rows,`
        + ` so the run read nothing new and the clause is unscored prose`,
    });
  }
  // X2 is the same arithmetic aimed the other way, because a passing growth arm on its own proves only that two
  // runs printed numbers. My prediction was "the declared-but-unopenable ledger adds no section and no token";
  // the FIRST run of this arm falsified it and the miss is the finding — the mutant printed no `headings seen`
  // row and no `name:number tokens` row at all, because step 8's unread-ledger check refuses the run (exit code
  // of its own, verdict `RESULT: UNCHECKED`) before any census is reported. That is the stronger property, and it
  // is what the arm pins now: an unreadable ledger stops the census rather than being silently left out of it.
  // Both halves are separate missed-patterns, so a future red says which one went: the announcement or the
  // emptiness of the census (D186's lesson — a case's name only tells you half of what it asserts).
  {
    const ctl = defaultMode(CHECKER);
    const mut = defaultMode(plant8('d213-absent', 'docs/d213_no_such_ledger_held_by_no_commit.md'));
    const rowNum = (out, label) => {
      const hit = out.match(new RegExp(`^ +${label.source} +(\\d+)`, 'm'));
      return hit ? Number(hit[1]) : NaN;
    };
    const censusPrinted = (out) => Number.isFinite(rowNum(out, /headings seen/))
      && Number.isFinite(rowNum(out, /name:number tokens/));
    const must = [/RESULT: UNCHECKED/, /docs\/d213_no_such_ledger_held_by_no_commit\.md/];
    const announced = must.filter((re) => !re.test(mut.out));
    const held = censusPrinted(ctl.out) && !censusPrinted(mut.out) && announced.length === 0;
    results.push({
      name: 'D213/X2 — a ledger that cannot be opened stops the census instead of being skipped by it'
        + ` (control rows: sections ${rowNum(ctl.out, /headings seen/)}/tokens ${rowNum(ctl.out, /name:number tokens/)}`
        + `, mutant rows: sections ${rowNum(mut.out, /headings seen/)}/tokens ${rowNum(mut.out, /name:number tokens/)})`,
      expect: 0, code: held ? 0 : 1,
      missed: held ? [] : [...(censusPrinted(ctl.out) ? [] : [/the CONTROL run must print a census to compare against/]),
        ...(censusPrinted(mut.out) ? [] : [/the mutant must print NO census row/]), ...announced],
      unwanted: [],
      out: `mutant exit ${mut.code}`,
    });
  }
} else {
  console.log('  (skipped) D206\'s mutant-reader arms: this run is already aimed at a planted checker ('
    + `${PLANTED}), and mutating the reader is what it does`);
}

// --------------------------------------------------------------------------- D208: the ledger-declaration slice's floor
// The new row is a claim about a file this script does not read, so it is armed from the other side: copy step 8,
// mutate the one line the row slices from, and aim the SHIPPED step 9 at the copy. Predicted before any mutant was
// written: all three mutations refuse with exit 2 and print the number of declaration lines they matched, and none
// of them reaches the point where step 9 would spawn the copy — a renamed or duplicated `const LEDGERS` makes the
// copy a ReferenceError or a SyntaxError, so an arm that printed a child's crash would be D159 arriving again, this
// time in the disclosure. The verbatim copy is the control: relocation alone must not refuse.
if (PLANTED === null) {
  const DECL = "const LEDGERS = ARGS.text === null ? ['docs/DECISIONS.md', 'docs/STATUS.md'] : [ARGS.text];";
  const push = (name, expect, must, absent, r) => results.push({ name, expect, code: r.code,
    missed: must.filter((re) => !re.test(r.out)), unwanted: absent.filter((re) => re.test(r.out)), out: r.out });
  const driveStep8 = (tag, replacement) => {
    const dir = join(tmpdir(), `nexus-d208-${tag}-${process.pid}`);
    const src = readFileSync(CHECKER, 'utf8').replace(/\r\n/g, '\n');
    const hits = src.split(DECL).length - 1;
    let code = -1;
    let out = '';
    if (hits !== 1) {
      out = `step 8's ledger declaration appears ${hits} times — no mutant was written`;
    } else {
      try {
        mkdirSync(join(dir, 'scripts'), { recursive: true });
        // The copy is spawned as a reader, so it needs the two modules it imports beside it — the same lesson the
        // D206 driver learned: a copied script that dies on its own import prints 0 of everything and proves 0.
        for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
          writeFileSync(join(dir, 'scripts', sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
        }
        const path = join(dir, 'scripts', 'check_ledger_citations.mjs');
        writeFileSync(path, src.replace(DECL, replacement), 'utf8');
        const r = spawnSync(process.execPath, [READER, `--checker=${path}`, '--plane', CONTROL],
          { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
        code = r.status ?? -1;
        out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      } catch (e) {
        out = `the mutant could not be run: ${e.message}`;
      }
    }
    rmSync(dir, { recursive: true, force: true });
    return { code, out };
  };
  const NO_REFUSE = [/cannot say which prose step 8 reads/, /sliced to 0 file\(s\)/];
  push('D208/P3 — a verbatim copy of step 8 elsewhere still answers the row from the same declaration',
    0, [/RESULT: PASS/, /prose, no reader\s+0 ext\(s\)/, /not one of the 2 file\(s\) step 8 names as prose/],
    NO_REFUSE, driveStep8('copy', DECL));
  push('D208/P4 — rename step 8\'s ledger declaration and the row refuses instead of reporting a gap it cannot name',
    2, [/its ledger declaration matched 0 line\(s\)/],
    [/sliced to 0 file\(s\)/, /matched 2 line\(s\)/, /RESULT: PASS/, /RESULT: FAIL/, /ReferenceError/,
      /prose, no reader/], driveStep8('renamed', DECL.replace('const LEDGERS =', 'const LEDGERS_D208_RENAMED =')));
  push('D208/P5 — duplicate it and the refusal counts the two lines, and never spawns a copy that cannot parse',
    2, [/its ledger declaration matched 2 line\(s\)/],
    [/SyntaxError/, /RESULT: PASS/, /RESULT: FAIL/, /prose, no reader/],
    driveStep8('dup', `${DECL}\n${DECL}`));
  push('D208/P6 — an empty default array refuses: a gap measured against no prose is not a measurement',
    2, [/ledger list sliced to 0 file\(s\)/],
    [/RESULT: PASS/, /RESULT: FAIL/, /prose, no reader/, /TypeError/],
    driveStep8('empty', "const LEDGERS = ARGS.text === null ? [] : [ARGS.text];"));
} else {
  console.log('  (skipped) D208\'s mutant-checker arms: this run is already aimed at a planted checker ('
    + `${PLANTED}), and the arms below plant one of their own`);
}

// --------------------------------------------------------------------------- the seam, inside the runner
{
  const gate = readFileSync(GATE, 'utf8').replace(/\r\n/g, '\n').split('\n');
  const start = gate.findIndex((l) => /^step "9\/12/.test(l));
  const end = gate.findIndex((l, i) => i > start && /^step "10\/12/.test(l));
  const block = start < 0 ? [] : gate.slice(start, end < 0 ? gate.length : end);
  const wants = [/falsify_comment_plane\.mjs/, /GATE_COMMENT_PLANE:\+--plane=/];
  const missing = wants.filter((re) => !block.some((l) => re.test(l)));
  await arm(`step 9's block runs this harness AND forwards the knob to the reader (${block.length} lines read)`,
    missing.length === 0 ? 0 : 1, [], [], null);
  for (const m of missing) results.at(-1).missed.push(m);
  if (start < 0) results.at(-1).missed.push(/^step "9\/12/);
  console.log(`  step 9 block: ${block.length} lines, ${missing.length} of ${wants.length} required forms missing`);
}
{
  let help = '';
  try {
    help = execFileSync('bash', [GATE, '--help'], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    help = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const want = ['GATE_COMMENT_PLANE'];
  const missing = want.filter((k) => !help.includes(k));
  await arm(`the shipped --help documents the knob step 9 forwards (${want.join(', ')})`,
    missing.length === 0 && /Usage|usage/.test(help) ? 0 : 1, [], [], null);
  for (const m of missing) results.at(-1).missed.push(new RegExp(m));
}

rmSync(ROOT_FIX, { recursive: true, force: true });

// --------------------------------------------------------------------------- the table
let fails = 0;
for (const r of results) {
  const bad = r.expect !== r.code || r.missed.length > 0 || r.unwanted.length > 0;
  if (bad) fails += 1;
  console.log(`${bad ? 'MISSED' : 'held  '}  exit ${r.expect} expected, ${r.code} printed   ${r.name}`);
  for (const m of r.missed) console.log(`         expected text missing: ${m}`);
  for (const u of r.unwanted) console.log(`         unexpected text present: ${u}`);
}
const held = results.length - fails;
const spaced = results[0].out.split('\n').filter((l) => /RESULT:/.test(l)).join('|');
const glued = results[1].out.split('\n').filter((l) => /RESULT:/.test(l)).join('|');
const samePlane = spaced === glued;
console.log(`\n  both spellings' verdict lines ${samePlane ? 'IDENTICAL' : 'DIFFER'}:`);
console.log(`    --plane  <dir>  ${spaced}`);
console.log(`    --plane=<dir>   ${glued}`);
if (!samePlane) fails += 1;
console.log(`\n${fails === 0 ? 'RESULT: PASS' : 'RESULT: FAIL'} — ${results.length} arms · ${held} held · `
  + `${results.length - held} missed${samePlane ? '' : ', and the two flag spellings disagreed about the plane'}`);
process.exit(fails === 0 && samePlane ? 0 : 1);
