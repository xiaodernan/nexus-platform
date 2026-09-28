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
 * USAGE   node scripts/falsify_ledger_text.mjs                       (from the repo root)
 *         node scripts/falsify_ledger_text.mjs --reader=<planted reader>   (expect exit 1: the seam is live)
 *         node scripts/falsify_ledger_text.mjs --help
 * EXIT    0 every prediction held · 1 an arm missed · 2 the harness could not start, or was asked for a
 *         flag it does not parse — which is the case D163 caught this file in, printing a green tally about
 *         a mutant it had never opened because an unknown word used to be nothing at all
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(tmpdir(), 'nexus-d157-falsify');
const HARNESS = join(ROOT, 'scripts', 'falsify_ledger_text.mjs');
// D165 — this harness takes a reader now, because D163 caught it not taking one: `--reader=<mutant>` was an
// unrecognised word, so the run that believed it was testing a mutant had run the SHIPPED checker and printed
// "25 of 25 held" about a file it never opened. A harness that ignores a flag is the defect its own subjects
// are watched for, and the parse goes through the same shared parser so this file cannot grow a private dialect.
const SELF_SPEC = { '--reader': { kind: 'value', unit: 'reader file' }, '--help': { kind: 'switch' } };
const selfParsed = parseFlags(process.argv.slice(2), SELF_SPEC);
if (!selfParsed.ok) {
  console.log(`RESULT: NOT CHECKED — ${selfParsed.reason}`);
  process.exit(2);
}
if (selfParsed.switches.includes('--help')) {
  console.log('usage: node scripts/falsify_ledger_text.mjs [--reader=<planted reader>] [--help]');
  console.log('  every arm runs one reader; --reader aims them all at a planted copy, and the mutant arm');
  console.log('  says that it skipped, because there is nothing to plant inside a plant');
  process.exit(0);
}
const PLANTED = selfParsed.value['--reader'] ?? null;
const MUTATES = PLANTED === null;
const CHECKER = PLANTED ?? join(ROOT, 'scripts', 'check_ledger_citations.mjs');
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

// D163 — the red D162 could only observe once, now reachable from here. Two supplied planes: a head plane with
// one committed section, and a disk plane that adds a second section citing a blank line. Without `--head-dir`
// and `--dir` this path is unwitnessable — no harness may write a new section into the real `docs/` — and a
// rule that has never been seen reddening twice is a rule nobody can re-check.
const planeFixture = (dir, extra) => {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), CRLF([
    '# D163 fixture', '', '## D900 A committed section', '', `The parser is at scripts/cli_args.mjs:${TEXT_AT}.`, extra,
  ]), 'utf8');
  writeFileSync(join(dir, 'docs', 'STATUS.md'), CRLF([
    '# D163 status fixture', '', '## 900. A committed status section', '', `The parser is at scripts/cli_args.mjs:${TEXT_AT}.`,
  ]), 'utf8');
  return dir;
};
const SEAM = join(FIX, 'seam');
const HEAD_PLANE = planeFixture(join(SEAM, 'head'), '');
const DISK_PLANE = planeFixture(join(SEAM, 'disk'),
  `\n## D901 A section being written\n\nIt cites scripts/cli_args.mjs:${BLANK_AT}, which is a blank line.\n`);

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
  { name: '--worktree counts the blank class and judges none of it (the committed backlog)',
    args: ['--worktree'], expect: 0,
    must: [/blank-line cites\s+\d+ at HEAD \(counted, not judged/],
    absent: [/BLANK LINE \(\d+\):/, /FALSE LEDGER CITATIONS/] },
  // D162 — the reading plane's split, pinned as two printed halves: the committed count with its non-verdict,
  // and the new-section count with the sentence that says a blank THERE offends. D163 made the red side of this
  // rule reachable from a fixture (`--dir` / `--head-dir`, armed below), where before it could only be observed
  // once in a real ledger draft; this arm stays because it pins what an operator sees on the clean tree.
  { name: 'the default plane reports both blank halves and stays green while no new section cites one',
    args: [], expect: 0,
    must: [/blank-line cites\s+\d+ at HEAD \(counted, not judged/, /section\(s\) this run is writing, and a blank there offends/,
      /0 blank\(s\) among \d+ section/],
    absent: [/BLANK LINE \(\d+\):/, /FALSE LEDGER CITATIONS/] },
  // D163 — four faces of the new seam: red, control, and the two refusals that keep a mistyped request from
  // quietly reading the repository instead of the plane the caller asked for.
  { name: 'a new section citing a blank line reddens when both planes are supplied',
    args: ['--head-dir', HEAD_PLANE, '--dir', DISK_PLANE], expect: 1,
    must: [/FALSE LEDGER CITATIONS — BLANK LINE IN A NEW SECTION \(1\)/, new RegExp(`scripts/cli_args\\.mjs:${BLANK_AT}`),
      /1 blank\(s\) among 1 section\(s\) this run is writing/] },
  { name: 'the same head plane with no new section is green — the rule judges newness, not the fixture',
    args: ['--head-dir', HEAD_PLANE, '--dir', HEAD_PLANE], expect: 0,
    must: [/0 blank\(s\) among 0 section\(s\)/], absent: [/FALSE LEDGER CITATIONS/, /BLANK LINE \(\d+\):/] },
  { name: '--dir= is refused with its unit named, not silently read as the repository', args: ['--dir='], expect: 2,
    must: [/RESULT: NOT CHECKED — --dir was given without a directory/] },
  { name: '--head-dir followed by another flag is refused, because a seam may not guess which plane',
    args: ['--head-dir', '--dir', DISK_PLANE], expect: 2,
    must: [/RESULT: NOT CHECKED — --head-dir was followed by --dir/, /there is no directory to read/] },
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
  const want = [/node scripts\/falsify_ledger_text\.mjs/, /GATE_LEDGER_TEXT:\+--text=/,
    /GATE_LEDGER_DIR:\+--dir=/, /GATE_LEDGER_HEAD_DIR:\+--head-dir=/,
    // The two modes are mutually exclusive BY TEXT: `--worktree` alongside a supplied plane would compare
    // nothing and still print a verdict, so the branch itself is what is pinned here, not just the flags.
    /if \[ -n "\$\{GATE_LEDGER_DIR:-\}" \]/, /node scripts\/check_ledger_citations\.mjs --worktree/];
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
// D165 — the arm that says the seam arms are predictions and not decoration: rebuild the reader with D162's
// predicate (blanks judged only under `--text`) and run THIS harness against it, predicting exit 1. The planted
// copy goes into a temp directory together with the two modules it imports relatively, because the first
// attempt at this in D163 wrote the copy alone and the child died of MODULE_NOT_FOUND at exit 1 — a red that
// belongs to the harness's own import, not to the predicate, and a mutant measured that way is worth nothing.
// Skipped when `--reader` already aims this run at a plant: there is nothing to plant inside a plant.
if (MUTATES) {
  // Its own root, NOT under FIX: the planted reader is a harness run, and every harness run clears FIX at its
  // start — the first version of this arm wrote the mutant into FIX and the child deleted it before opening it.
  const MDIR = join(tmpdir(), `nexus-d165-mutant-${process.pid}`);
  mkdirSync(MDIR, { recursive: true });
  const src = readFileSync(CHECKER, 'utf8');
  const anchor = 'census(false, (section) => BLANK_JUDGED || !head.titles.has(section))';
  const hits = src.split(anchor).length - 1;
  let code = -1;
  let out = '';
  if (hits !== 1) {
    out = `the new-section predicate appears ${hits} times in the reader — the mutant has no anchor`;
  } else {
    try {
      writeFileSync(join(MDIR, 'check_ledger_citations.mjs'), src.replace(anchor, 'census(false, () => BLANK_JUDGED)'), 'utf8');
      for (const sib of ['cli_args.mjs', 'source_index.mjs']) {
        writeFileSync(join(MDIR, sib), readFileSync(join(ROOT, 'scripts', sib), 'utf8'), 'utf8');
      }
      const child = spawnSync(process.execPath, [HARNESS, `--reader=${join(MDIR, 'check_ledger_citations.mjs')}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
      code = child.status ?? -1;
      out = `${child.stdout || ''}${child.stderr || ''}`;
    } catch (e) {
      out = `the mutant could not be run: ${e.message}`;
    }
  }
  rmSync(MDIR, { recursive: true, force: true });
  results.push({
    arm: { name: 'a reader rebuilt with D162\'s predicate reddens this harness', expect: 1,
      // The child's own verdict is the evidence, not its exit code alone: the mutant reader must FAIL to
      // redden the seam's red arm, which the child reports as that arm missing with the heading named as the
      // text it never printed. (First version of this regex predicted `0 printed` for the arm's reader exit —
      // the child exits 1 because IT has a missed arm, which is a different 1.)
      must: [/MISSED\s+exit 1 expected, \d+ printed\s+a new section citing a blank line reddens/,
        /expected text missing: .*BLANK LINE IN A NEW SECTION/, /RESULT: FAIL/,
        /\(skipped\) the mutant arm/] },
    code, out,
  });
} else {
  console.log(`  (skipped) the mutant arm: this run is already aimed at a planted reader (${CHECKER})`);
}
// And the harness's own door, since D163 caught it standing open: a flag this file does not parse must refuse.
{
  const child = spawnSync(process.execPath, [HARNESS, '--readers=x'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  results.push({
    arm: { name: 'a flag this harness does not parse is refused rather than ignored', expect: 2,
      must: [/RESULT: NOT CHECKED — unknown option --readers/, /flags this reader parses/] },
    code: child.status ?? -1, out: `${child.stdout || ''}${child.stderr || ''}`,
  });
}

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
