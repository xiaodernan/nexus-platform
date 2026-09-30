/**
 * NEXUS — the witness for gate step 8's UNTRACKED TARGET class (D203).
 *
 * WHAT IS BEING ARMED. `check_ledger_citations.mjs` resolves a citation against a filesystem walk of
 * `process.cwd()`, so on a machine that holds files no commit holds, a cite into one of those files resolves,
 * prints "resolves to one file, within its bounds", and exits 0. Measured at landing on this repository's
 * working copy: 513 citation-shaped tokens, 0 offenders, exit 0 — and the same reader on a frozen
 * `git worktree add --detach … HEAD` plane of the same commit files 47 offenders there, 46 of them FILE NOT
 * FOUND, because those 46 cites name 18 distinct paths that are on this disk and in no commit. The class added
 * by D203 asks HEAD's tree about the resolved path, and this harness is the proof that it fires in both
 * directions.
 *
 * WHY THE PLANES ARE SYNTHETIC. An earlier draft of this file planned to cite one of this repository's own
 * untracked Java test classes. That is another lane's work product, and a witness keyed to it goes red when
 * they commit — which is the debt being FIXED. So every arm below builds its own throwaway root under the OS
 * temp directory, with its own git repository, its own commit, and its own untracked file, and derives each
 * path from the state it just created. The two arms that do run against this repository (L1, L2) take their
 * target from `git ls-files --others --exclude-standard` and `git ls-tree -r --name-only HEAD` at run time,
 * and refuse to score anything when the set they need is empty.
 *
 * PREDICTIONS, written before the first run of the armed reader:
 *   C1 control — a plant citing a tracked target, judged plane: exit 0, `untracked targets 0 of N`, no offender.
 *   B1 untracked target in a plant (the synthetic repo): exit 1, `UNTRACKED TARGET (1)` naming the derived path.
 *   B2 a committed section citing an untracked file (synthetic repo, `--dir`/`--head-dir` both holding the
 *      section): exit 0, counted not judged — `2 at HEAD (counted, not judged` with `0 among 0 new section(s)`.
 *      The 2 is the cite grammar speaking: the first sentence cites the untracked file once, and the second
 *      cites it once more while carrying two spans, so a section holding both sentences cites it twice.
 *   B3 the same file cited from a section that exists only on disk: exit 1, and the class prints under its own
 *      header `UNTRACKED TARGET IN A NEW SECTION (2)` — the new section repeats the same two cites.
 *   B4 a root with ledgers, files and NO git repository: exit 0 with `untracked targets UNCHECKED —` printed,
 *      because a class that cannot ask git must say so rather than report a clean count.
 *   B5 a repository whose only commit is empty: exit 2, refusing with `git ls-tree HEAD returned 0 paths`,
 *      because an unreadable tree would otherwise charge every citation in the ledgers at once.
 *   L1/L2 the same two judgements against THIS repository, with the target taken out of `git ls-files --others`
 *      and `git ls-tree HEAD` at run time rather than from a fixture: the arm that says the class fires on the
 *      ledgers nobody wrote for this test, and the arm that says a tracked cite stays green.
 *   S1 `--untracked-backlog` over an untracked plant: exit 0, with the count still printed and the words
 *      `counted, not judged: --untracked-backlog declares this whole plane a backlog`.
 *   S2 control, the same plant text plus a cite onto a blank line of a tracked file, WITHOUT the switch: exit 1
 *      with `FALSE LEDGER CITATIONS (2)`, `UNTRACKED TARGET (1)` and `BLANK LINE (1)` both printed.
 *   S3 that plane WITH the switch: exit 1 still, but on `BLANK LINE (1)` alone, and `1 of 2 citation(s)` counted
 *      — the switch exempts one class on a plane, it does not mute the reader.
 *   S4 `--untracked-backlog=1`: exit 2 with `is a switch and was given a value`, and NOT `unknown option` — the
 *      first sentence proves the flag is declared, the second proves it is not being tolerated by an ignore.
 *   S5 the switch over the two-plane seam (no `--text`): exit 2 refusing, because a plane that can decide
 *      newness has a judged subset and the switch would silence it exactly where it carries a verdict.
 *   S6/S7 gate step 9 aimed at a comment plane that cites THIS repository's untracked file: exit 0 with the
 *      counted-not-judged sentence, and then the very census file step 9 names in its own `scored by` line
 *      re-scored through step 8 WITHOUT the switch: exit 1, `UNTRACKED TARGET (1)`. S7 is the reverse control
 *      that makes S6's green a verdict about the switch rather than about a plane that cited nothing.
 *
 * usage: node scripts/falsify_untracked_cites.mjs [--reader=<planted reader>] [--help]
 */

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LEDGER_EXT, VENDOR_DIRS } from './source_index.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const READER = process.argv.find((a) => a.startsWith('--reader='))?.slice('--reader='.length)
  ?? join(ROOT, 'scripts', 'check_ledger_citations.mjs');
if (process.argv.includes('--help')) {
  console.log('usage: node scripts/falsify_untracked_cites.mjs [--reader=<planted reader>]');
  process.exit(0);
}
const FIX = join(tmpdir(), 'nexus-d203-untracked');
const die = (m) => { throw new Error(m); };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=NEXUS Witness', '-c', 'user.email=witness@nexus.local', ...a],
  { cwd, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });

const LINES = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n');
/** A target's first line must be non-blank, or the blank class answers before the one being armed. */
const TARGET_BODY = LINES(40, 'export const filler = 0; // witness target');
/** The same 40 lines with line 20 emptied — the blank cite the switch's second arm needs beside the untracked one. */
const TARGET_BLANKS = TARGET_BODY.split('\n').map((l, i) => (i === 19 ? '' : l)).join('\n');

function plantLedger(p, lines) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join('\r\n') + '\r\n', 'utf8');
  return p;
}

/**
 * A repository this harness owns: 120 filler files (the reader refuses a source index under 100 files), a
 * tracked target, and an untracked one. The commit is real because the class asks `git ls-tree HEAD`, and the
 * untracked file is real because nothing here runs `git add` on it.
 */
function makeRepo(name) {
  const dir = join(FIX, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(dir, 'scripts', `filler${String(i).padStart(3, '0')}.mjs`), LINES(3, '// filler'), 'utf8');
  }
  writeFileSync(join(dir, 'scripts', 'tracked_target.mjs'), TARGET_BODY + '\n', 'utf8');
  writeFileSync(join(dir, 'scripts', 'untracked_target.mjs'), TARGET_BODY + '\n', 'utf8');
  // A tracked target whose line 20 holds nothing: the switch's arm needs a plane carrying BOTH an untracked
  // target and a blank cite, because the charge against `--untracked-backlog` is that it mutes the reader.
  writeFileSync(join(dir, 'scripts', 'blank_target.mjs'), TARGET_BLANKS + '\n', 'utf8');
  git(dir, 'init', '-q');
  git(dir, 'add', 'scripts/tracked_target.mjs', 'scripts/blank_target.mjs', 'scripts/filler000.mjs');
  git(dir, 'commit', '-q', '-m', 'witness: one tracked target and 100 filler files');
  const tree = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').filter(Boolean);
  if (!tree.includes('scripts/tracked_target.mjs')) die(`${name}: the commit does not hold the tracked target — the arm cannot be armed`);
  if (!tree.includes('scripts/blank_target.mjs')) die(`${name}: the commit does not hold the blank-line target — the switch's second arm cannot be armed`);
  if (tree.includes('scripts/untracked_target.mjs')) die(`${name}: the commit holds the untracked target — the arm has no untracked file to cite`);
  if (readFileSync(join(dir, 'scripts', 'blank_target.mjs'), 'utf8').split(/\r?\n/)[19].trim() !== '') die(`${name}: line 20 of the blank target is not blank`);
  return dir;
}

/** The same ledgers and files with no `.git` at all: the plane where the class must say UNCHECKED. */
function makePlain(name) {
  const dir = join(FIX, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(dir, 'scripts', `filler${String(i).padStart(3, '0')}.mjs`), LINES(3, '// filler'), 'utf8');
  }
  writeFileSync(join(dir, 'scripts', 'tracked_target.mjs'), TARGET_BODY + '\n', 'utf8');
  writeFileSync(join(dir, 'scripts', 'untracked_target.mjs'), TARGET_BODY + '\n', 'utf8');
  if (gitExists(dir)) die(`${name}: a repository was found above the no-git plane, so UNCHECKED cannot be armed`);
  return dir;
}
const gitExists = (dir) => {
  try { git(dir, 'rev-parse', '--git-dir'); return true; } catch { return false; }
};

/** A repository whose only commit is empty: HEAD's tree holds nothing, which is not the same as nothing citing it. */
function makeEmptyTree(name) {
  const dir = join(FIX, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(dir, 'scripts', `filler${String(i).padStart(3, '0')}.mjs`), LINES(3, '// filler'), 'utf8');
  }
  writeFileSync(join(dir, 'scripts', 'untracked_target.mjs'), TARGET_BODY + '\n', 'utf8');
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'witness: a tree with no files');
  if (git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').trim() !== '') die(`${name}: the empty commit is not empty — the refusal arm cannot be armed`);
  return dir;
}

const REPO = makeRepo('repo');
const PLAIN = makePlain('no-git');
const EMPTY = makeEmptyTree('empty-tree');

// A ledger whose committed section cites BOTH targets, untracked twice. `--head-dir` and `--dir` get the same
// text for the counted arm and an extra section for the judged one, so the only difference between B2 and B3 is
// whether the citing section exists at the head plane — which is the bargain being armed, not a wording.
const CITES = [
  'The tracked one is at scripts/tracked_target.mjs:3, and the untracked one is at scripts/untracked_target.mjs:3.',
  'Again untracked: scripts/untracked_target.mjs:7,:12.',
];
const OLD_SECTION = ['# D203 fixture', '', '## D900 A committed section', '', ...CITES];

const PLANT_TRACKED = plantLedger(join(FIX, 'plant_tracked.md'),
  ['# D203 plant', '', '## D990 A section citing a tracked target', '', 'The guard is at scripts/tracked_target.mjs:3.']);
const PLANT_UNTRACKED = plantLedger(join(FIX, 'plant_untracked.md'),
  ['# D203 plant', '', '## D991 A section citing an untracked target', '', 'The guard is at scripts/untracked_target.mjs:3.']);
// One plane, two offences: the untracked cite and a cite onto the blank line of a tracked file. The switch is
// charged with muting the reader, so its arm must show the other class still reddens the same text.
const PLANT_BOTH = plantLedger(join(FIX, 'plant_both.md'),
  ['# D203 plant', '', '## D992 A section citing an untracked target and a blank line', '',
   'The guard is at scripts/untracked_target.mjs:3, and the empty one is at scripts/blank_target.mjs:20.']);

// The two seam planes are roots, not `docs` directories: the reader appends its own `docs/DECISIONS.md` to
// whatever `--dir` names. Measured on the first run of this harness, where passing the `docs` directory made
// the reader look for `…/head-plane/docs/docs/DECISIONS.md`, and the arms reported UNCHECKED for a fixture that
// existed one level up — the ledger-read failure path, not the class under test.
const HEAD_PLANE = join(FIX, 'head-plane');
const DISK_SAME = join(FIX, 'disk-same');
const DISK_NEW = join(FIX, 'disk-new');
plantLedger(join(HEAD_PLANE, 'docs', 'DECISIONS.md'), OLD_SECTION);
plantLedger(join(HEAD_PLANE, 'docs', 'STATUS.md'), ['# D203 status fixture', '']);
plantLedger(join(DISK_SAME, 'docs', 'DECISIONS.md'), OLD_SECTION);
plantLedger(join(DISK_SAME, 'docs', 'STATUS.md'), ['# D203 status fixture', '']);
plantLedger(join(DISK_NEW, 'docs', 'DECISIONS.md'), [...OLD_SECTION, '', '## D901 A section being written', '', ...CITES]);
plantLedger(join(DISK_NEW, 'docs', 'STATUS.md'), ['# D203 status fixture', '']);

/**
 * The two targets this repository really has, read out of git at run time rather than written down, so no
 * other lane's file is named here and the arm survives their commit. Both picks must hold a non-blank line 3,
 * or the blank class answers first and the arm reports a different offence than the one it arms.
 */
function liveTargets() {
  const citable = (p) => {
    const base = p.split('/').pop();
    if (!LEDGER_EXT.test(p) || base.startsWith('.') || p.split('/').some((seg) => VENDOR_DIRS.has(seg))) return false;
    try {
      const lines = readFileSync(join(ROOT, p), 'utf8').split(/\r?\n/);
      return lines.length > 12 && lines[2].trim() !== '';
    } catch { return false; }
  };
  const others = git(ROOT, 'ls-files', '--others', '--exclude-standard').split(/\r?\n/).filter(Boolean);
  const tree = git(ROOT, 'ls-tree', '-r', '--name-only', 'HEAD').split(/\r?\n/).filter(Boolean);
  const usable = others.filter(citable);
  return {
    pickUntracked: usable[0] ?? null,
    pickTracked: tree.filter(citable)[0] ?? null,
    others: usable.length,
    tree: tree.length,
  };
}

const run = (args, cwd) => {
  const r = spawnSync(process.execPath, [READER, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

const live = liveTargets();

const ARMS = [];
function arm(a) { ARMS.push(a); }

arm({ name: 'C1 control — a plant citing a tracked target is clean on the judged plane', expect: 0,
  run: () => run(['--text', PLANT_TRACKED], REPO),
  must: [/untracked targets\s+0 of 1 citation\(s\)/, /every citation-shaped token resolves/],
  absent: [/UNTRACKED TARGET/, /UNCHECKED/, /NOT CHECKED/] });

arm({ name: 'B1 — a plant citing an untracked target offends, naming the path git does not hold', expect: 1,
  run: () => run(['--text', PLANT_UNTRACKED], REPO),
  must: [/FALSE LEDGER CITATIONS \(1\)/, /UNTRACKED TARGET \(1\)/, /scripts\/untracked_target\.mjs:3/,
    /not in HEAD's tree/, /untracked targets\s+1 of 1 citation\(s\)/],
  absent: [/every citation-shaped token resolves/] });

arm({ name: 'B2 — a committed section citing an untracked file is counted, not judged, and stays green', expect: 0,
  run: () => run(['--dir', DISK_SAME, '--head-dir', HEAD_PLANE], REPO),
  must: [/untracked targets\s+2 at HEAD \(counted, not judged/, /0 among 0 new section\(s\)/,
    /strict offenders\s+0 offender\(s\)/],
  absent: [/UNTRACKED TARGET IN A NEW SECTION/, /UNCHECKED/, /FALSE LEDGER CITATIONS/] });

arm({ name: 'B3 — the same cite inside a section this run is writing offends under its own header', expect: 1,
  run: () => run(['--dir', DISK_NEW, '--head-dir', HEAD_PLANE], REPO),
  must: [/UNTRACKED TARGET IN A NEW SECTION \(2\)/, /scripts\/untracked_target\.mjs/,
    /2 at HEAD \(counted, not judged/, /0 blank\(s\) among 1 new section\(s\)/] });

arm({ name: 'B4 — a plane with no git prints UNCHECKED instead of a clean count', expect: 0,
  run: () => run(['--text', PLANT_UNTRACKED], PLAIN),
  must: [/untracked targets\s+UNCHECKED — git ls-tree HEAD failed/, /nothing is claimed about whether HEAD/] });

arm({ name: 'B5 — a repository whose tree is empty refuses rather than charging every citation', expect: 2,
  run: () => run(['--text', PLANT_UNTRACKED], EMPTY),
  must: [/RESULT: NOT CHECKED — git ls-tree HEAD returned 0 paths/] });

// The repository's own plane, with the targets derived from git: this is the measurement that says the class
// fires on the real ledgers and not only on a fixture the author made.
if (live.pickUntracked === null) {
  arm({ name: 'L1 — this repository holds an untracked file a plant can cite', expect: 2,
    run: () => ({ code: 2, out: `NOT RUN — git ls-files --others returned ${live.others} candidate(s), none of them a citable file` }),
    must: [/NOT RUN/] });
} else {
  const p = plantLedger(join(FIX, 'plant_live_untracked.md'),
    ['# D203 plant', '', '## D995 A section citing this repository\'s own untracked file', '',
      `The live one is at ${live.pickUntracked}:3.`]);
  arm({ name: `L1 — a plant citing THIS repository's untracked ${live.pickUntracked} offends (derived, not named)`, expect: 1,
    run: () => run(['--text', p], ROOT),
    must: [/UNTRACKED TARGET \(1\)/, new RegExp(live.pickUntracked.replace(/[./]/g, '\\$&')), /FALSE LEDGER CITATIONS \(1\)/] });
}
if (live.pickTracked !== null) {
  const p = plantLedger(join(FIX, 'plant_live_tracked.md'),
    ['# D203 plant', '', '## D996 A section citing a tracked file of this repository', '',
      `The live one is at ${live.pickTracked}:3.`]);
  arm({ name: `L2 — the same sentence about THIS repository's tracked ${live.pickTracked} is green`, expect: 0,
    run: () => run(['--text', p], ROOT),
    must: [/untracked targets\s+0 of 1 citation\(s\)/], absent: [/UNTRACKED TARGET/] });
}

/**
 * The `--untracked-backlog` family. D203 shipped the class judged on every `--text` plane, and gate step 9's
 * generated comment-plane census went to 12 offenders on the first run — cites inside shipped text
 * (`data/seed/quality.sql` and friends) pointing at files this disk holds and no commit holds. The switch is
 * the answer to that plane, so these arms are the shape of the answer: it exempts one class on one plane, it
 * cannot be used on a plane that can decide newness for itself, and the gate's own backlog reader really does
 * carry it.
 */
arm({ name: 'S1 — the switch spares the untracked cite on the plane it is given', expect: 0,
  run: () => run(['--text', PLANT_UNTRACKED, '--untracked-backlog'], REPO),
  must: [/untracked targets\s+1 of 1 citation\(s\).*counted, not judged/, /--untracked-backlog declares this whole plane a backlog/,
    /strict offenders\s+0 offender\(s\)/],
  absent: [/FALSE LEDGER CITATIONS/, /UNTRACKED TARGET/] });

arm({ name: 'S2 control — the same plane without the switch reddens on both classes', expect: 1,
  run: () => run(['--text', PLANT_BOTH], REPO),
  must: [/FALSE LEDGER CITATIONS \(2\)/, /UNTRACKED TARGET \(1\)/, /BLANK LINE \(1\)/, /scripts\/blank_target\.mjs:20 is empty/],
  absent: [/counted, not judged/] });

arm({ name: 'S3 — with the switch the blank cite still offends: one class exempted, not the plane muted', expect: 1,
  run: () => run(['--text', PLANT_BOTH, '--untracked-backlog'], REPO),
  must: [/FALSE LEDGER CITATIONS \(1\)/, /BLANK LINE \(1\)/, /scripts\/blank_target\.mjs:20 is empty/,
    /untracked targets\s+1 of 2 citation\(s\).*counted, not judged/],
  absent: [/UNTRACKED TARGET/] });

arm({ name: 'S4 — the switch is declared in the flag table, not merely tolerated', expect: 2,
  run: () => run(['--untracked-backlog=1', `--text=${PLANT_UNTRACKED}`], REPO),
  must: [/RESULT: NOT CHECKED — --untracked-backlog is a switch and was given a value/],
  absent: [/unknown option/] });

arm({ name: 'S5 — the switch refuses to silence a plane that can decide newness for itself', expect: 2,
  run: () => run(['--dir', DISK_NEW, '--head-dir', HEAD_PLANE, '--untracked-backlog'], REPO),
  must: [/RESULT: NOT CHECKED — --untracked-backlog was given without --text/, /declaring the whole plane a backlog/],
  absent: [/UNTRACKED TARGET IN A NEW SECTION/, /strict offenders/] });

// The reach arm: gate step 9 is the caller the switch exists for, so its own command line must arm it. Both
// halves run against this repository, and the second half is the reverse control — the very census step 9
// calls green is scored again without the switch, so S6's green cannot come from a plane that cited nothing.
const STEP9 = join(ROOT, 'scripts', 'check_comment_citations.mjs');
const runStep9 = (args, cwd) => {
  const r = spawnSync(process.execPath, [STEP9, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const STEP9_PLANE = join(FIX, 'step9-plane');
mkdirSync(STEP9_PLANE, { recursive: true });
const CARRIER = join(STEP9_PLANE, 'carrier.mjs');
const scoredBy = (out) => {
  const line = out.split(/\r?\n/).find((l) => l.includes('scored by'));
  // The value ends at the next flag, not at the end of the line: step 9's own report prints
  // `--text=<census> --untracked-backlog`, and a `(.+)$` grab handed the reader a filename with a flag glued to
  // its end. Measured on this harness's first S7 run — step 8 answered UNCHECKED/ENOENT for
  // `…\census.md --untracked-backlog` and the arm reported a miss that belonged to the parser, not to the class.
  const m = line && line.match(/--text=(.+?)(?=\s+--|\s*$)/);
  return m ? m[1] : null;
};
if (live.pickUntracked === null) {
  arm({ name: 'S6 — gate step 9 carries the switch', expect: 2,
    run: () => ({ code: 2, out: 'NOT RUN — this repository holds no untracked file for the comment plane to cite' }),
    must: [/NOT RUN/] });
  arm({ name: 'S7 — the same census without the switch is red', expect: 2,
    run: () => ({ code: 2, out: 'NOT RUN — S6 did not produce a census to re-score' }), must: [/NOT RUN/] });
} else {
  writeFileSync(CARRIER, `// the lane's entry point is at ${live.pickUntracked}:3\nexport const carrier = 1;\n`, 'utf8');
  arm({ name: 'S6 — gate step 9 over a comment that cites this repository\'s untracked file counts it and stays green',
    expect: 0, run: () => runStep9([`--plane=${STEP9_PLANE}`, `--checker=${READER}`], ROOT),
    must: [/untracked targets\s+1 of 1 citation\(s\).*counted, not judged/, /strict offenders\s+0 offender\(s\)/, /RESULT: PASS/] });
  arm({ name: 'S7 — step 9\'s own census file, scored without the switch, is red: S6\'s green is the switch speaking',
    expect: 1, run: () => {
      const { out } = runStep9([`--plane=${STEP9_PLANE}`, `--checker=${READER}`], ROOT);
      const census = scoredBy(out);
      if (census === null) return { code: -1, out: 'NOT RUN — step 9 printed no "scored by --text=" line to take the census path from' };
      if (!existsSync(census)) return { code: -1, out: `NOT RUN — the census path step 9 printed does not exist on disk: ${census}` };
      return run(['--text', census], ROOT);
    },
    must: [/UNTRACKED TARGET \(1\)/, new RegExp(live.pickUntracked.replace(/[./]/g, '\\$&')), /FALSE LEDGER CITATIONS \(1\)/] });
}

let missed = 0;
const rows = [];
for (const a of ARMS) {
  const { code, out } = a.run();
  const bad = (a.must ?? []).filter((re) => !re.test(out));
  const wrongly = (a.absent ?? []).filter((re) => re.test(out));
  const ok = code === a.expect && bad.length === 0 && wrongly.length === 0;
  if (!ok) missed += 1;
  rows.push({ name: a.name, expect: a.expect, code, ok, out, bad, wrongly });
}

console.log('NEXUS — witness for the UNTRACKED TARGET class (gate step 8, D203)');
console.log(`  reader: ${READER}`);
console.log(`  fixture root: ${FIX}`);
console.log(`  this repository: ${live.tree} paths in HEAD's tree, ${live.others} untracked candidates,`);
console.log(`    untracked pick ${live.pickUntracked ?? 'NONE'}, tracked pick ${live.pickTracked ?? 'NONE'}`);
console.log('');
for (const r of rows) {
  console.log(`${r.ok ? 'held   ' : 'MISSED '} exit ${r.expect} expected, ${r.code} printed   ${r.name}`);
  if (!r.ok) {
    for (const re of r.bad) console.log(`    never printed: ${re}`);
    for (const re of r.wrongly) console.log(`    should be absent: ${re}`);
    console.log(r.out.split('\n').slice(0, 24).map((l) => `    | ${l}`).join('\n'));
  }
}
rmSync(FIX, { recursive: true, force: true });
// S6 and S7 leave step 9's generated census describing this harness's fixture plane, and the file lives outside
// FIX so the cleanup above cannot reach it. Rather than delete a directory another lane's step 9 may be reading,
// the shipped reader is run once more over its own plane, which leaves the artifact as the repository's census.
// The exit code is printed, not asserted: a red here would be this tree's comment plane, not D203.
const restore = runStep9([], ROOT);
console.log(`\n  step 9's census regenerated over the repository plane (exit ${restore.code})`);
console.log(`\n  ${rows.length} arms · ${rows.filter((r) => r.ok).length} held · ${missed} missed`);
console.log(missed === 0 ? '\nRESULT: PASS — the class reddens an untracked target and spares a tracked one.'
  : '\nRESULT: FAIL — the UNTRACKED TARGET class does not do what D203 claims');
process.exit(missed === 0 ? 0 : 1);
