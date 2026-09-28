#!/usr/bin/env node
/**
 * NEXUS D157 — both sides of `scripts/check_ledger_citations.mjs`'s `--text` seam, shown rather than asserted.
 *
 * WHY THIS EXISTS. Gate step 8 runs the ledger census with `GATE_LEDGER_TEXT:+--text="$GATE_LEDGER_TEXT"`
 * (D152), and the claim recorded there was "the reader opens the file the environment names". It had never been
 * tested. D157 measured the reader first and found the same defect D156 found in step 7's reader, on the other
 * half of the same sentence: the old parser was
 *
 *   const TEXT_ARG = process.argv.find((a) => a.startsWith('--text='));
 *
 * so `--text=<plant>` worked, and `--text <plant>` — the spelling gate step 9's own driver comments about, and
 * the one a person types from the USAGE line — was not an error at all. Measured on the HEAD bytes:
 * `--text=<plant>` printed `headings seen 1 section(s)` and `FALSE LEDGER CITATIONS (1)` and exited 1, while
 * `--text <plant>` printed `headings seen 297 section(s)`, `citation-shaped 377`, `LEDGER CITATIONS — every
 * citation-shaped token resolves…` and exited 0. The second run censused the two real ledgers, said nothing
 * false, and was aimed at nothing. `--tex=<plant>` did the same. And the four non-vacuity guards were
 * `throw new Error`, which printed a stack trace with exit 1 — the code this reader uses for "a ledger names a
 * file that is not there" — so a census that had certified nothing was reporting a finding about the ledgers.
 *
 * THE ARMS. Each states its verdict before the shipped checker runs, and the harness exits 1 if a prediction
 * misses:
 *   · the control is this tree, `--worktree`, which must stay green and must not print `FALSE`;
 *   · the same plant reached by each of the two spellings has to give the SAME verdict (that pair is D156's
 *     census in miniature, and it is the regression half — before the fix the second one was the green lie);
 *   · a plant naming a file that does not exist reddens a different arm of the census, so the seam is not
 *     proven only against past-EOF citations;
 *   · an unknown flag, a missing value, an empty value, a value that reads as another flag, a switch given a
 *     value, and `--text` twice each exit 2 with `RESULT: NOT CHECKED` — refused, not ignored;
 *   · a file with no `## ` heading exits 2 rather than throwing;
 *   · `--report` over a true plant still prints the offence (report mode is a caller's choice about the exit
 *     code, not a way to be blind);
 *   · the shipped gate's `--help` has to name every knob its own Environment-overrides block documents, and
 *     step 8 has to both run this harness and pass the knob to the reader — a knob nobody can discover, or a
 *     harness nobody runs, is an arm that does not exist.
 *
 * WHAT IT DOES NOT COVER, because a census that hides its blind spots is the thing this project keeps catching:
 * the plants live in the OS temp directory but the checker's *source index* is built from `process.cwd()`, so
 * the file-resolution half of every arm is judged against the real repository. That is intended (it is what
 * makes a cite one line past the checker's own last line a true past-EOF, and why that number is read out of
 * the file instead of written here) and it means this harness must be run from the
 * repo root — which is how `db_gate_fresh.sh` invokes it. It does not re-test the citation grammar itself;
 * that plane is `check_comment_citations.mjs`'s slice, and step 8's green arm here is the guard against the
 * grammar silently stopping matching anything.
 *
 * USAGE   node scripts/falsify_ledger_text.mjs          (from the repo root)
 * EXIT    0 every prediction held · 1 an arm missed · 2 the harness could not start
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(tmpdir(), 'nexus-d157-falsify');
const CHECKER = join(ROOT, 'scripts', 'check_ledger_citations.mjs');
const GATE = readFileSync(join(ROOT, 'scripts', 'db_gate_fresh.sh'), 'utf8').split(/\r?\n/);

rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const CRLF = (lines) => lines.join('\r\n') + '\r\n';
const fixture = (name, lines) => {
  const p = join(FIX, name);
  writeFileSync(p, CRLF(lines), 'utf8');
  return p;
};

// A citation to a real file, past its last line. The number is read out of the file rather than written down,
// for two reasons: the plant cannot drift back inside the file it cites, and D157's first version of this
// comment carried a literal past-EOF example that gate step 9 — which scans source comments with step 8's own
// grammar — correctly reddened for. A plant is allowed to hold a false citation; a comment about a plant is not.
const PAST_END = readFileSync(CHECKER, 'utf8').split(/\r?\n/).length + 1;
const PLANT_EOF = fixture('plant_past_eof.md', [
  '# D157 plant',
  '',
  '## D999 A line that is past the end',
  '',
  `The guard is at scripts/check_ledger_citations.mjs:${PAST_END}.`,
]);
// A citation to a file the index does not hold, and one that DOES resolve beside it. The resolvable line is
// not decoration: this arm's first version predicted `FILE NOT FOUND` from a plant holding only the missing
// cite, and the checker exited 2 with "1 citation(s) found and 0 file(s) resolved" instead. Its vacuity guard
// cannot tell "every citation points at a file nobody has" from "the index is broken", and it refuses rather
// than guessing — so the FILE NOT FOUND arm is only observable when at least one cite resolves, which the
// PLANT_ALONE arm below pins as its own prediction instead of leaving for the next person to rediscover.
const PLANT_MISS = fixture('plant_missing_file.md', [
  '# D157 plant',
  '',
  '## D998 A file nobody has',
  '',
  'The real one is at scripts/source_index.mjs:1 and the guard is at scripts/no_such_reader_at_all.mjs:12.',
]);
const PLANT_ALONE = fixture('plant_missing_only.md', [
  '# D157 plant',
  '',
  '## D997 Nothing in this census resolves',
  '',
  'The guard is at scripts/no_such_reader_at_all.mjs:12.',
]);
// A bare basename the index holds more than once. Measured while writing this file: `package.json` is held by
// six of them, so a cite that looks precise is naming none of the six, and that is a distinct refusal.
const PLANT_AMBIG = fixture('plant_ambiguous.md', [
  '# D157 plant',
  '',
  '## D996 A name the index holds twice',
  '',
  'The real one is at scripts/source_index.mjs:1 and the vague one is at package.json:1.',
]);
// Not a ledger: no `## ` heading anywhere, which the census reads as "I did not read what I claim to have".
const HEADLESS = fixture('plant_headless.md', ['# D157 plant', '', 'a citation-shaped token: package.json:1']);

// D161 — the blank-line class, aimed at the plane that judges it. Both numbers are derived from the cited file
// at run time for the same reason PAST_END is: a written-down line goes stale at the next edit. Here staleness
// would not merely rot the arm, it would empty it — the claim being pinned is that an EMPTY line offends while
// a line carrying text beside it does not, which needs one of each from the same file in the same run.
const TARGET = readFileSync(join(ROOT, 'scripts', 'cli_args.mjs'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const BLANK_AT = TARGET.findIndex((l, i) => i > 0 && !l.trim() && TARGET[i - 1].trim()) + 1;
const TEXT_AT = TARGET.findIndex((l) => l.includes('export function parseFlags')) + 1;
if (BLANK_AT < 1 || TEXT_AT < 1) {
  throw new Error(`cannot derive the blank-line fixture from scripts/cli_args.mjs (blank ${BLANK_AT}, parseFlags ${TEXT_AT})`);
}
const PLANT_BLANK = fixture('plant_blank_line.md', [
  '# D161 plant',
  '',
  '## D995 A citation that lands on an empty line',
  '',
  `The empty one is at scripts/cli_args.mjs:${BLANK_AT} and the real one is at scripts/cli_args.mjs:${TEXT_AT}.`,
]);

const run = (args) => {
  const r = spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// Every line the census prints for a plant must be identical across the two spellings, or the pair proves
// nothing about equivalence. Derived from the runs below rather than written down.
const ARMS = [
  { name: 'control: the two ledgers of this tree, --worktree', args: ['--worktree'], expect: 0,
    must: [/every citation-shaped token resolves/], absent: [/FALSE LEDGER CITATIONS/, /NOT CHECKED/, /UNCHECKED/],
    // Non-vacuity for the green arm: a heading count and a citation count are printed and nonzero, so "green"
    // is not the census having read nothing. The numbers themselves are not pinned — three lanes append here.
    floors: [/headings seen\s+(\d+) section/, /citation-shaped\s+(\d+)/] },
  { name: '--text=<plant> reaches the past-EOF arm of the census', args: [`--text=${PLANT_EOF}`], expect: 1,
    must: [/headings seen\s+1 section/, /FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/] },
  { name: '--text <plant> — the same request, space-separated — reaches the same arm', args: ['--text', PLANT_EOF],
    expect: 1, must: [/headings seen\s+1 section/, /FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/],
    sameVerdictAs: 1 },
  { name: '--text=<plant> reaches the file-not-found arm', args: [`--text=${PLANT_MISS}`], expect: 1,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /FILE NOT FOUND/] },
  { name: 'a plant with nothing resolvable in it refuses instead of reporting one offender',
    args: [`--text=${PLANT_ALONE}`], expect: 2,
    must: [/RESULT: NOT CHECKED —/, /1 citation\(s\) found and 0 file\(s\) resolved/] },
  { name: '--text=<plant> reaches the ambiguous arm', args: [`--text=${PLANT_AMBIG}`], expect: 1,
    // The count and the candidate list are not pinned: which three of the six `package.json` files the walk
    // reports first is the index's business, and a floor of "some number, and the word hold it" is the claim.
    must: [/FALSE LEDGER CITATIONS \(1\)/, /AMBIGUOUS/, /[1-9]\d* files hold it: /] },
  { name: 'a citation onto an empty line offends on the --text plane, and it is the only offender there',
    args: [`--text=${PLANT_BLANK}`], expect: 1,
    must: [/name:number tokens\s+2/, /FALSE LEDGER CITATIONS \(1\)/, /BLANK LINE \(1\)/,
      new RegExp(`scripts/cli_args.mjs:${BLANK_AT} is empty`), /a blank line cannot hold the claim this cite makes/] },
  { name: 'the reading plane counts the blank class and refuses to offend on it (D161 backlog)',
    args: ['--worktree'], expect: 0,
    must: [/blank-line cites\s+\d+ span start\(s\) on an empty line/, /counted, not judged, on the reading plane/],
    absent: [/BLANK LINE \(\d+\):/, /FALSE LEDGER CITATIONS/] },
  { name: 'an unparseable flag is refused, not dropped', args: [`--tex=${PLANT_EOF}`], expect: 2,
    must: [/RESULT: NOT CHECKED — unknown option --tex/] },
  { name: '--text= with nothing after the sign', args: ['--text='], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given without a path/] },
  { name: '--text with nothing after the sign', args: ['--text'], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given without a path/] },
  { name: '--text followed by another flag', args: ['--text', '--report'], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was followed by --report/] },
  { name: '--text twice, which copy is the census', args: [`--text=${PLANT_EOF}`, `--text=${PLANT_MISS}`], expect: 2,
    must: [/RESULT: NOT CHECKED — --text was given 2 times/] },
  { name: 'a switch given a value', args: ['--worktree=1'], expect: 2,
    must: [/RESULT: NOT CHECKED — --worktree is a switch and was given a value/] },
  { name: 'a bare positional argument', args: [PLANT_EOF], expect: 2,
    must: [/RESULT: NOT CHECKED — unexpected argument/] },
  { name: 'a file with no "## " heading refuses instead of throwing', args: [`--text=${HEADLESS}`], expect: 2,
    must: [/RESULT: NOT CHECKED —/, /saw no "## " heading/], absent: [/at .*check_ledger_citations\.mjs:\d+/, /Error:/] },
  { name: '--report over a true plant still prints the offence', args: ['--report', `--text=${PLANT_EOF}`], expect: 0,
    must: [/FALSE LEDGER CITATIONS \(1\)/, /PAST EOF/] },
];

// The wiring and discoverability arms read the shipped gate rather than the checker: what is being certified is
// that the seam is reachable *from inside the gate*, which is the whole standing rule (D98, D150-D152).
function gateKnobs() {
  const from = GATE.findIndex((l) => l.startsWith('# Environment overrides:'));
  if (from < 0) throw new Error('db_gate_fresh.sh has no Environment overrides block to read knobs out of');
  const names = [];
  for (let i = from + 1; i < GATE.length; i += 1) {
    if (!GATE[i].startsWith('#')) break;
    if (/^#$/.test(GATE[i])) break;
    const m = GATE[i].match(/^#\s{3}([A-Z][A-Z0-9_]{3,})/);
    if (m) names.push(m[1]);
  }
  return names;
}

const results = [];
for (const arm of ARMS) {
  const r = run(arm.args);
  results.push({ arm, ...r, printed: r.out });
}

{
  const knobs = gateKnobs();
  let out, code;
  try { out = execFileSync('bash', ['scripts/db_gate_fresh.sh', '--help'], { cwd: ROOT, encoding: 'utf8' }); code = 0; }
  catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status ?? -1; }
  const missing = knobs.filter((k) => !out.includes(k));
  results.push({
    arm: { name: `the shipped --help documents every knob in its own Environment block (${knobs.length} names)`,
      expect: 0, must: knobs.map((k) => new RegExp(k)), absent: [] },
    code, out, missing,
  });
}
{
  const from = GATE.findIndex((l) => l.includes('step "8/12'));
  const to = GATE.findIndex((l, i) => i > from && /^step /.test(l));
  const region = from < 0 ? '' : GATE.slice(from, to < 0 ? GATE.length : to).join('\n');
  const want = [/node scripts\/falsify_ledger_text\.mjs/, /GATE_LEDGER_TEXT:\+--text=/];
  results.push({
    arm: { name: 'gate step 8 runs this harness AND passes the knob to the reader', expect: 0, must: want, absent: [] },
    code: want.every((re) => re.test(region)) ? 0 : 1, out: region,
  });
}

// The equivalence claim, checked as text rather than as two independent predictions: the two spellings of the
// same plant have to produce the same verdict lines, or arm 3 is only a second red, not a second reader.
{
  const a = results[1];
  const b = results[2];
  const digest = (t) => t.split(/\r?\n/).filter((l) => /headings seen|citation-shaped|FALSE LEDGER CITATIONS|PAST EOF/.test(l)).join('|');
  const equal = a.code === b.code && digest(a.out) === digest(b.out);
  results.push({
    arm: { name: 'the two spellings of --text print the same verdict about the same plant', expect: 0,
      must: [], absent: [] },
    code: equal ? 0 : 1, out: `equals: exit ${a.code} [${digest(a.out)}]\nspace:    exit ${b.code} [${digest(b.out)}]`,
  });
}

let fails = 0;
for (const r of results) {
  const missed = (r.arm.must ?? []).filter((re) => !re.test(r.out));
  const unwanted = (r.arm.absent ?? []).filter((re) => re.test(r.out));
  const floors = (r.arm.floors ?? []).map((re) => (re.exec(r.out) ?? [])[1]).filter((v) => !(Number(v) > 0));
  const bad = r.code !== r.arm.expect || missed.length > 0 || unwanted.length > 0 || floors.length > 0;
  if (bad) fails += 1;
  console.log(`${bad ? 'MISSED' : 'held  '}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  for (const m of missed) console.log(`         expected text missing: ${m}`);
  for (const u of unwanted) console.log(`         text that must not be there: ${u}`);
  for (const f of floors) console.log(`         count printed zero or unread: ${f}`);
  if (bad) console.log(`         verdict lines: ${r.out.split(/\r?\n/).filter((l) => /RESULT|FALSE|headings seen|citation/.test(l)).slice(0, 4).join(' | ')}`);
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped checker as a subprocess with cwd = the repo root, so the');
console.log('           source index is the real tree and the plants are temp files — see the header.');
if (fails) { console.log('\nRESULT: FAIL — the --text seam does not do what step 8 claims'); process.exit(1); }
console.log('\nRESULT: PASS — both spellings aim the census, an unparseable request refuses, and step 8 is reachable from the gate');
