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
