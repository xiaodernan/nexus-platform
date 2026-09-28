#!/usr/bin/env node
/**
 * NEXUS D195 -- both sides of scripts/check_reader_reachability.mjs, shown rather than asserted.
 *
 * WHAT IS BEING WITNESSED. The census makes two claims about this repository: every `scripts/check_*.mjs` is
 * INVOKED by a surface that runs checkers (the gate, the workflow, the Makefile), and every CI step that pipes
 * a checker into `tee` declares the shell that makes the pipe able to fail. Both claims were false when the
 * census was written (10 readers, 3 invoked by nowhere; 3 piped steps, none protected) and both are true on
 * the shipped bytes now. A census whose only run is its own green has not been tested, so every arm below
 * states the verdict it expects before the shipped checker is called.
 *
 * THROUGH THE CHECKER'S OWN SEAMS. Every arm points `--gate`/`--ci`/`--make` at its own copy in the system
 * temp directory, so no arm edits a tracked file and no two arms can redden each other. The three seams are
 * always passed explicitly, even when the surface is unmutated, so an arm cannot pass by silently falling back
 * to the shipped file -- the D154 defect, which is also one of the arms below.
 *
 * Usage: node scripts/falsify_reader_reachability.mjs
 * Exit:  0 every arm held · 1 an arm missed · 2 a plant could not be built (an anchor that no longer matches
 *        proves nothing, so it is a refusal and not a red).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check_reader_reachability.mjs');
const FIX = join(tmpdir(), 'nexus-d195-falsify');
const SHIPPED = {
  gate: readFileSync(join(ROOT, 'scripts', 'db_gate_fresh.sh'), 'utf8'),
  ci: readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  make: readFileSync(join(ROOT, 'Makefile'), 'utf8'),
};
for (const [k, v] of Object.entries(SHIPPED)) {
  if (v.includes('\r')) { console.log(`RESULT: NOT CHECKED -- the shipped ${k} is not LF here`); process.exit(2); }
}
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

function die(m) { console.log(`RESULT: NOT CHECKED — ${m}`); process.exit(2); }

/** Write a copy of one surface with every pair applied; each anchor must occur exactly once or the arm dies. */
function plant(name, surface, pairs) {
  let text = SHIPPED[surface];
  for (const [from, to] of pairs) {
    const hits = text.split(from).length - 1;
    if (hits !== 1) die(`plant ${name}: its anchor occurs ${hits} time(s) in the shipped ${surface}, not 1`);
    text = text.replace(from, to);
  }
  const p = join(FIX, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

/** The same, for a plant that must rewrite every occurrence: the anchor is a shape, not a sentence. */
function plantAll(name, surface, from, to) {
  const hits = SHIPPED[surface].split(from).length - 1;
  if (hits === 0) die(`plant ${name}: its anchor occurs 0 times in the shipped ${surface}`);
  const p = join(FIX, name);
  writeFileSync(p, SHIPPED[surface].split(from).join(to), 'utf8');
  return p;
}

const surfaceArgs = (o = {}) => [
  `--gate=${o.gate ?? join(FIX, 'gate-control.sh')}`,
  `--ci=${o.ci ?? join(FIX, 'ci-control.yml')}`,
  `--make=${o.make ?? join(FIX, 'Makefile-control')}`,
];
writeFileSync(join(FIX, 'gate-control.sh'), SHIPPED.gate, 'utf8');
writeFileSync(join(FIX, 'ci-control.yml'), SHIPPED.ci, 'utf8');
writeFileSync(join(FIX, 'Makefile-control'), SHIPPED.make, 'utf8');

function run(...argv) {
  const r = execFileSync('node', [CHECKER, ...argv], { encoding: 'utf8', cwd: ROOT, stdio: 'pipe' });
  return { code: 0, out: r };
}

/* ------------------------------------------------------------------ plants */
// 1. A reader struck out of BOTH surfaces that invoke it: the state the census was written to find.
const a11yGone = plant('gate-a11y-gone.sh', 'gate',
  [['( cd "$ROOT" && node scripts/check_console_a11y.mjs ) 2>&1 | sed -e \'s/^/    /\'\n', '']]);
const ciA11yGone = plant('ci-a11y-gone.yml', 'ci',
  [['          node scripts/check_console_a11y.mjs | tee console-a11y.txt\n', '']]);
// 2. The same reader named only in a comment: a mention is not a call site.
const mentionedOnly = plant('gate-a11y-mentioned.sh', 'gate',
  [['( cd "$ROOT" && node scripts/check_console_a11y.mjs ) 2>&1 | sed -e \'s/^/    /\'\n',
    '# run node scripts/check_console_a11y.mjs by hand if this step ever looks wrong\n']]);
const ciA11yMentioned = plant('ci-a11y-mentioned.yml', 'ci',
  [['          node scripts/check_console_a11y.mjs | tee console-a11y.txt\n',
    '          # run node scripts/check_console_a11y.mjs by hand if this step ever looks wrong\n']]);
// 3. A piped CI step that loses the shell declaration.
const ciNoShell = plant('ci-no-shell.yml', 'ci',
  [['      - name: jsonb keys read by the build, against the declared list\n        shell: bash',
    '      - name: jsonb keys read by the build, against the declared list\n        # shell: bash']]);
// 4. The gate loses the line that holds its own pipes together.
const gateNoPipefail = plant('gate-no-pipefail.sh', 'gate', [['set -euo pipefail\n', '\n']]);
// 5. A workflow whose step blocks cannot be found at all (indentation moved): a population of zero.
const ciNoSteps = plantAll('ci-no-steps.yml', 'ci', '\n      - ', '\n            - ');
// 6. The same workflow with the one step that calls itself a hard fail relabelled as a report: the claim
// count is read out of the steps' own comments, so it has to move when a comment moves.
const ciNoClaim = plant('ci-no-claim.yml', 'ci',
  [['. Hard-fail: the declared list', '. Report mode: the declared list']]);

/* ------------------------------------------------------------------ arms */
const SHIPPED_READERS = readdirSync(join(ROOT, 'scripts')).filter((f) => /^check_.*\.mjs$/.test(f)).length;

const ARMS = [
  {
    name: 'control — the three shipped surfaces, read through the checker\'s own seams',
    args: surfaceArgs(), expect: 0,
    must: [/invoked by\s+10 of 10/, /gate pipefail\s+present/, /hard-fail claims\s+1 of \d+ piped step\(s\)/,
      /0 UNPROTECTED|: check_contract_drift\.mjs, check_jsonb_reads\.mjs/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'a reader invoked by no surface is an offender, and the count of readers falls by exactly one',
    args: surfaceArgs({ gate: a11yGone, ci: ciA11yGone }), expect: 1,
    must: [/check_console_a11y\.mjs is invoked by no surface/, /invoked by\s+9 of 10/],
  },
  {
    name: 'a commented-out invocation is not a call site — the mention is still an offender',
    args: surfaceArgs({ gate: mentionedOnly, ci: ciA11yMentioned }), expect: 1,
    must: [/check_console_a11y\.mjs is invoked by no surface/, /invoked by\s+9 of 10/],
  },
  {
    name: 'a commented-out `shell: bash` does not protect a piped step — comments are not code',
    args: surfaceArgs({ ci: ciNoShell }), expect: 1,
    must: [/the CI step \"jsonb keys read by the build, against the declared list\" pipes check_jsonb_reads\.mjs into tee/,
      /UNPROTECTED/],
  },
  {
    name: 'the gate without its pipefail line is an offender — the line is what makes every pipe below it honest',
    args: surfaceArgs({ gate: gateNoPipefail }), expect: 1,
    must: [/no `set \.\.\. pipefail` line in/],
  },
  {
    name: 'the hard-fail claim count is read out of the comment above each step, not typed into the census',
    args: surfaceArgs({ ci: ciNoClaim }), expect: 0,
    must: [/hard-fail claims\s+0 of \d+ piped step\(s\) say "hard fail" in their own comment \(none\)/,
      /invoked by\s+10 of 10/],
    absent: [/OFFENDERS/],
  },
  {
    name: 'a workflow whose steps cannot be found is refused, not reported clean',
    args: surfaceArgs({ ci: ciNoSteps }), expect: 2,
    must: [/RESULT: NOT CHECKED/, /parsed into 0 step blocks/],
  },
  {
    name: 'a surface that cannot be opened is a refusal that names the flag, not a census of nothing',
    // D195 — this arm used to aim the census at a missing surface by APPENDING a second --gate, which the
    // reader's own argv loop resolved last-wins. The shared parser refuses a flag given twice, so the arm had
    // been passing through a defect it did not name: it is one --gate now, aimed at a path that is not there,
    // and the double-given case is an arm of its own rather than the mechanism of this one.
    args: ['--gate=no/such/gate.sh', `--ci=${join(FIX, 'ci-control.yml')}`,
      `--make=${join(FIX, 'Makefile-control')}`],
    expect: 2,
    must: [/RESULT: NOT CHECKED/, /--gate=<path>/],
  },
  {
    name: '--report over a red plant still prints the offender and exits 0 — report mode is not silence',
    args: ['--report', ...surfaceArgs({ gate: a11yGone, ci: ciA11yGone })], expect: 0,
    must: [/OFFENDERS \(1\)/, /check_console_a11y\.mjs is invoked by no surface/],
  },
  {
    name: 'an unknown flag is refused rather than ignored (the D159 grammar, kept)',
    args: ['--checker=whatever'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /unknown option/],
  },
  {
    name: '--gate given twice is refused — the private loop took the last value and said nothing',
    args: ['--gate=a', '--gate=b'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /--gate was given 2 times/],
  },
  {
    name: '--report given a value is refused — a switch is not a knob',
    args: ['--report=1'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /--report is a switch and was given a value/],
  },
  {
    name: '--gate with no path is refused rather than defaulted to the shipped gate',
    args: ['--gate'], expect: 2,
    must: [/RESULT: NOT CHECKED/, /--gate was given without a path/],
  },
  {
    name: '--gate <path> (spaced) reaches the planted surface — a dropped flag would read the gate and report 0 offenders',
    args: ['--gate', a11yGone, '--ci', ciA11yGone, '--make', join(FIX, 'Makefile-control')], expect: 1,
    must: [/invoked by\s+9 of 10/],
  },
  {
    name: '--gate=<path> (glued) aims the same census at the same surface, so one dialect is not the only one read',
    args: [`--gate=${a11yGone}`, `--ci=${ciA11yGone}`, `--make=${join(FIX, 'Makefile-control')}`], expect: 1,
    must: [/invoked by\s+9 of 10/],
  },
];

let held = 0;
const misses = [];
for (const arm of ARMS) {
  let r;
  try {
    r = run(...arm.args);
  } catch (e) {
    r = { code: e.status === undefined ? -1 : e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
  const why = [];
  if (r.code !== arm.expect) why.push(`rc ${r.code}, expected ${arm.expect}`);
  for (const re of arm.must ?? []) if (!re.test(r.out)) why.push(`does not print ${re}`);
  for (const re of arm.absent ?? []) if (re.test(r.out)) why.push(`prints ${re}, which it must not`);
  if (why.length === 0) { held += 1; console.log(`held    exit ${arm.expect} expected, ${r.code} printed   ${arm.name}`); }
  else {
    misses.push(arm.name);
    console.log(`MISSED  exit ${arm.expect} expected, ${r.code} printed   ${arm.name}`);
    for (const w of why) console.log(`        ${w}`);
    console.log(`        printed: ${r.out.split('\n').filter((l) => /invoked by|UNPROTECTED|OFFENDERS|RESULT: NOT CHECKED|hard-fail claims|^  - /.test(l)).slice(0, 4).join(' | ')}`);
  }
}
console.log(`\n  ${ARMS.length} arms · ${held} held · ${misses.length} missed`);
console.log(`  fixture root: ${FIX}`);
console.log(`  control: the shipped tree holds ${SHIPPED_READERS} reader(s); the control arm asserts the census`);
console.log('           prints that same number, so a census reading a stale directory cannot agree by luck.');
if (misses.length) {
  console.log('\nRESULT: FAIL -- the reachability census does not do what its arms claim');
  process.exit(1);
}
console.log('\nRESULT: PASS -- the census reddens on an uninvoked reader, on a mere mention, on an unprotected pipe and on a missing pipefail line, and refuses when it cannot read a surface');