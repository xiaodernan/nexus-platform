#!/usr/bin/env node
/**
 * NEXUS — the readers in `scripts/`, and whether the places that run them can fail at all.
 *
 * TWO CLASSES, ONE QUESTION. The repository's own rule, earned three times over (D98, D150-D152, D191, D192),
 * is that a rule which cannot fire on the plane it is read on is not a rule. This census applies it to the
 * readers themselves rather than to their brackets:
 *
 *   A. REACHABILITY. A `scripts/check_*.mjs` that no surface INVOKES is a deed with no gate: it may measure
 *      something real, and nothing runs it. Measured before this reader existed: 9 first-party checkers, 2 of
 *      them (the console copy/noindex census and the console accessibility census) invoked nowhere — while
 *      `docs/PLAN.md` recorded the accessibility half of that item as "unmeasured".
 *
 *   B. PIPES. A reader whose exit code travels through a pipe is read through the pipe's exit code, and a pipe
 *      reports its LAST command unless the shell holds it. The gate knows this: `scripts/db_gate_fresh.sh`
 *      carries `set -euo pipefail` on one line, and D150/D151 spent a unit showing that the line is what makes
 *      step 11's guard able to stop the run. GitHub Actions does NOT: its documented default for a `run:` step
 *      on Linux is `bash -e {0}`, and `bash -e` alone reports `tee` (measured locally: `false | tee /dev/null`
 *      exits 0 under `bash -e`, and 1 under `bash -eo pipefail`). A step that pipes a checker into `tee` and
 *      declares no `shell:` therefore cannot fail, whatever its comment says. Measured on this workflow
 *      before this reader existed: three such steps, and no `shell:` on any of them. How many of those
 *      steps describe themselves as a hard fail is PRINTED by this reader and not typed here — the first
 *      draft of this paragraph said "two of them" and was wrong by one, which is the drift a count in prose
 *      always has, and the reason the arm that counts them is the one that prints them.
 *
 * WHAT THIS READER DOES NOT DECIDE. It does not judge whether a reachable reader is any good, and it does not
 * parse YAML: a step is a block of the workflow's text, found by indentation, and the question asked of it is
 * whether the two tokens (a `node scripts/<checker>` invocation and a `| tee`) occur in the same block as a
 * `shell:` declaration. That is a textual reading of a text file, stated here rather than implied.
 *
 * Usage:
 *   node scripts/check_reader_reachability.mjs
 *   node scripts/check_reader_reachability.mjs --report          # print, always exit 0
 *   node scripts/check_reader_reachability.mjs --verbose         # name every reader found, reached or not
 *   node scripts/check_reader_reachability.mjs --gate=<path>     # census this copy of the gate instead
 *   node scripts/check_reader_reachability.mjs --ci=<path>       # ... and this copy of the workflow
 *   node scripts/check_reader_reachability.mjs --make=<path>     # ... and this copy of the Makefile
 *         both spellings parse from one table (`scripts/cli_args.mjs`), and anything that table does not
 *         name is refused rather than dropped.
 *
 * Exit: 0 no offender · 1 an offender · 2 not checkable (a surface that cannot be read, or a population of
 *       zero — a census that found no reader to ask about has not cleared anything).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './cli_args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const FLAGS = {
  '--gate': { kind: 'value', unit: 'path' },
  '--ci': { kind: 'value', unit: 'path' },
  '--make': { kind: 'value', unit: 'path' },
  '--report': { kind: 'switch' },
  '--verbose': { kind: 'switch' },
};
// D195 — this reader grew its own argv loop when it was written, which made it a second copy of
// the one thing `scripts/cli_args.mjs` exists to be the only copy of. Measured on that first version:
// `--gate a --gate b` took b and said nothing (the last value silently wins), a repeated `--report` was
// accepted twice, and every refusal was this file's own wording rather than the shared sentence. The two
// spellings, the refusals and their sentences now come from the shared table, and
// `scripts/falsify_flag_dialect.mjs` counts this file among the readers on that parser, so a revert to a
// private loop is a red in the census rather than a reader that quietly reads another plane.
const parsed = parseFlags(process.argv.slice(2), FLAGS);
if (!parsed.ok) { console.log(`RESULT: NOT CHECKED — ${parsed.reason}`); process.exit(2); }
const value = parsed.value;
const REPORT_ONLY = Boolean(parsed.flag['--report']);
const VERBOSE = Boolean(parsed.flag['--verbose']);

const surfaces = [
  { key: 'gate', label: 'scripts/db_gate_fresh.sh', path: value['--gate'] ?? 'scripts/db_gate_fresh.sh',
    flag: '--gate' },
  { key: 'ci', label: '.github/workflows/ci.yml', path: value['--ci'] ?? '.github/workflows/ci.yml',
    flag: '--ci' },
  { key: 'make', label: 'Makefile', path: value['--make'] ?? 'Makefile', flag: '--make' },
];
for (const s of surfaces) {
  try {
    s.text = readFileSync(resolve(ROOT, s.path), 'utf8');
  } catch (e) {
    console.log(`RESULT: NOT CHECKED — cannot read ${s.path} for the ${s.key} surface `
      + `(${e.code ?? e.message}). A surface nobody can open is not a surface that names no reader; `
      + `re-aim it with ${s.flag}=<path>`);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------ A. reachability */
let scripts;
try {
  scripts = readdirSync(join(ROOT, 'scripts')).filter((f) => /^check_.*\.mjs$/.test(f)).sort();
} catch (e) {
  console.log(`RESULT: NOT CHECKED — cannot list scripts/ (${e.code ?? e.message})`);
  process.exit(2);
}
if (scripts.length === 0) {
  console.log('RESULT: NOT CHECKED — scripts/ holds no check_*.mjs at all: a census that found no reader to '
    + 'ask about has cleared nothing, and this directory is where they live');
  process.exit(2);
}

// A LINE THAT ONLY MENTIONS SOMETHING IS NOT A LINE THAT DOES IT. Every predicate below runs over the
// comment-stripped text of a surface: the first version tested the raw text, so `# shell: bash` protected a
// step, and a comment saying `run node scripts/x.mjs by hand` made a reader "invoked". The arm that plants a
// commented-out `shell: bash` is what found the first of those; the mention arm is what keeps the second.
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
for (const s of surfaces) s.code = stripComments(s.text);
const invokedBy = (s, reader) => new RegExp(`node\\s+scripts/${reader.replace('.', '\\.')}\\b`).test(s.code);
const unreached = [];
for (const reader of scripts) {
  const owners = surfaces.filter((s) => invokedBy(s, reader)).map((s) => s.key);
  if (owners.length === 0) unreached.push(reader);
  if (VERBOSE) console.log(`  ${owners.length > 0 ? 'reached   ' : 'UNREACHED '} ${reader.padEnd(34)}`
    + ` ${owners.join(', ') || '(no surface invokes it)'}`);
}

/* ------------------------------------------------------------------ B. pipes */
const gatePipefail = /^set\s+-[a-z]*o?\s*[a-z]*\s*pipefail|^set\s+-[a-z]*[a-z ]*pipefail/m.test(surfaces[0].text);
// A STEP'S OWN COMMENT IS THE UNBROKEN RUN OF `#` LINES ABOVE ITS `- ` LINE, AND THE SPLIT PUTS THAT RUN AT
// THE TAIL OF THE PREVIOUS BLOCK. Splitting on the step marker alone reads a comment run as the property of
// the step before it: measured on this workflow while the hard-fail claim below was being written, the one
// step whose own comment says "Hard-fail" (the jsonb census) was reported under the name of the step before
// it, so an offender a person would go and fix named a different step. Each block's trailing comment run is
// carried forward to the step it describes, and a blank line between a note and a step ends the run —
// which is how the note at the head of this job stays a note about the job and not about the next step.
const carried = [];
const ciSteps = surfaces[1].text.split(/\n(?=\s{6}- )/).slice(1).map((block) => {
  const lines = block.split('\n');
  let cut = lines.length;
  while (cut > 1 && /^\s*#/.test(lines[cut - 1])) cut -= 1;
  const head = carried.concat(lines.slice(0, cut));
  carried.length = 0;
  carried.push(...lines.slice(cut));
  return head.join('\n');
});
if (ciSteps.length === 0) {
  console.log(`RESULT: NOT CHECKED — ${surfaces[1].path} parsed into 0 step blocks; the indentation this reader `
    + 'finds steps by may have moved, and a census with no steps has not cleared any');
  process.exit(2);
}
const piped = [];
for (const block of ciSteps) {
  const name = (block.match(/-\s*name:\s*(.+)/) ?? [, '(unnamed step)'])[1].trim();
  const checks = [...block.matchAll(/node\s+scripts\/([\w.]+\.mjs)/g)].map((m) => m[1]);
  if (checks.length === 0 || !/\|\s*tee\b/.test(block)) continue;
  const code = stripComments(block);
  const protectedBy = /shell:\s*bash/.test(code) ? 'shell: bash'
    : (/set\s+-o\s+pipefail/.test(code) ? 'set -o pipefail' : null);
  // The step's own comment, which is the whole reason this class exists: a step that says it will fail the
  // build and cannot is the shape D150-D152 kept finding. Reported, never enforced — a comment that
  // overstates itself is a documentation defect, and this census does not decide documentation.
  const comments = block.split('\n').filter((l) => /^\s*#/.test(l)).join('\n');
  piped.push({ name, checks, protectedBy, saysHardFail: /hard[- ]?fail/i.test(comments) });
}
const unprotected = piped.filter((p) => p.protectedBy === null);
if (piped.length === 0) {
  console.log(`RESULT: NOT CHECKED — no CI step pipes a checker into tee; either the workflow stopped running `
    + 'checkers through pipes or this reader stopped recognising them, and the two are not the same thing');
  process.exit(2);
}

/* ------------------------------------------------------------------ verdict */
const offenders = [];
for (const reader of unreached) {
  offenders.push(`${reader} is invoked by no surface: not scripts/db_gate_fresh.sh, not `
    + `${surfaces[1].label}, not the Makefile — a reader nothing runs is a measurement, not a gate. A comment`
    + ' that names this file does not count: the census asks who CALLS it');
}
for (const step of unprotected) {
  offenders.push(`the CI step "${step.name}" pipes ${step.checks.join(', ')} into tee and declares no shell: `
    + '— on a runner that is `bash -e {0}`, whose pipeline reports tee, so this step cannot fail');
}
if (!gatePipefail) {
  offenders.push(`no \`set ... pipefail\` line in ${surfaces[0].path}: every step there that pipes a reader `
    + 'through `sed` reports the pipe\'s last command, so D150/D151\'s proof that step 11 can stop the run '
    + 'stops holding the moment that line goes');
}

console.log('NEXUS — the readers this repository ships, and whether the places that run them can fail');
console.log(`  surfaces read       ${surfaces.map((s) => s.label).join(', ')}`);
console.log(`  first-party readers ${scripts.length} scripts/check_*.mjs found`);
console.log(`  invoked by          ${scripts.length - unreached.length} of ${scripts.length} `
  + `(unreached: ${unreached.length})`);
console.log(`  gate pipefail       ${gatePipefail ? 'present' : 'ABSENT'} in ${surfaces[0].path}`);
console.log(`  CI piped steps      ${piped.length} step(s) pipe a checker into tee: `
  + `${piped.map((p) => `${p.checks.join('+')}${p.protectedBy ? '' : ' UNPROTECTED'}`).join(', ')}`);
const claimants = piped.filter((p) => p.saysHardFail);
console.log(`  hard-fail claims    ${claimants.length} of ${piped.length} piped step(s) say \"hard fail\" in their own `
    + `comment${claimants.length ? `: ${claimants.map((p) => p.name).join(', ')}` : ' (none)'}`);
console.log('');
if (offenders.length > 0) {
  console.log(`OFFENDERS (${offenders.length}):`);
  for (const o of offenders) console.log(`  - ${o}`);
} else {
  console.log('  every first-party reader is invoked by a surface, and every place that pipes one can fail');
}
console.log('');
console.log('WHAT THIS DOES NOT SAY: that an invoked reader is a good reader, that a step declaring `shell: bash`');
console.log('is otherwise well formed, or anything about `| sed` in CI (the same pipe rule applies, and only');
console.log('`| tee` steps are censused here because that is the shape this workflow uses). The hard-fail claim');
console.log('count is printed because it is why the class matters, and it decides nothing: a step whose own');
console.log('comment overstates itself is not an offender in this census. The claim is read from the unbroken run');
console.log('of comment lines directly above a step, so a blank line between a note and a step is what keeps');
console.log('the note from being read as that step\'s claim.');

process.exit(offenders.length > 0 && !REPORT_ONLY ? 1 : 0);