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
    /it opens 0 here/],
  [...CRASH, /- notes\.txt/, /strict offenders\s+[1-9]/], ['--plane', PROSE_TXT]);
await arm('D208/P2 — the same bytes named `.sql` are scored, so the row keys on the vocabulary table, not the content',
  0, [/RESULT: PASS/, /tokens found\s+2 in 2 file\(s\)/,
    /prose, no reader\s+0 ext\(s\), 0 file\(s\), 0 token\(s\): \(none\)/],
  CRASH, ['--plane', PROSE_SQL]);
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
  const check = (name, expect, must, absent, r) => results.push({
    name, expect, code: r.code,
    missed: must.filter((re) => !re.test(r.out)),
    unwanted: absent.filter((re) => re.test(r.out)),
    out: r.out,
  });
  /** `hits !== 1` is reported as the arm's own red — a mutant that lost its anchor tests nothing at all.
   *  D207 widened it from "the map anchor" to "any single anchor in step 9's bytes", because the vocabulary row
   *  needs arming the same way and the mechanism is identical: copy the reader, replace one string, run it. */
  const drive = (tag, anchor, replacement, planeDir) => {
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
        const r = spawnSync(process.execPath, [path, `--checker=${CHECKER}`, '--plane', planeDir],
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
