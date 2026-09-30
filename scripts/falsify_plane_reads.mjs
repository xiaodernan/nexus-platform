/**
 * NEXUS — the witness for gate step 8's plane-aware target reads and its UNCOMMITTED TARGET class (D204).
 *
 * WHAT IS BEING ARMED. `check_ledger_citations.mjs` judges HEAD's ledger text — it reads `docs/DECISIONS.md`
 * and `docs/STATUS.md` out of HEAD with `git show` — but until D204 it read the files those ledgers *cite* out
 * of the working copy on both planes. So a HEAD-plane line number was this machine's line number. Measured at
 * landing on this repository: 10 of the 31 path-exact cited files differ between HEAD's bytes and this disk's,
 * and the shipped reader was wrong in both directions at once — it printed `strict offenders 0` where the same
 * ref frozen in a detached worktree printed a PAST EOF (a cite of `scripts/falsify_ledger_text.mjs:858`, inside
 * this disk's 888-line copy and past HEAD's 737-line one), and it counted 21 blank-line cites as HEAD's
 * committed backlog when HEAD holds a blank line at only 18 of them. D204 reads the judged plane's own bytes;
 * where the two copies disagree and the cite is clean only on the disk, the row is counted as an UNCOMMITTED
 * TARGET instead of reddening a gate that cannot take the fix (the file is another lane's uncommitted rewrite).
 *
 * WHY THE PLANES ARE SYNTHETIC. The unit is about a target whose HEAD copy and disk copy differ, and that
 * state on this repository belongs to whichever lane is mid-edit — a witness keyed to it would go green or red
 * on someone else's commit. So every rig below builds its own git repository under the OS temp directory,
 * commits one copy of a target, leaves another copy on disk, and derives each expected line count from the same
 * bytes it wrote. Only R1 runs against this repository, and it asserts that the class prints a count there,
 * never what the count is today.
 *
 * PREDICTIONS, written before the first run of the armed reader:
 *   P1 the class fires (default plant: a cite at HEAD's line 30, which HEAD's 21-line copy does not have and
 *      this disk's 41-line copy does, plus a control cite at line 5 that both copies hold): exit 0,
 *      `uncommitted targets 1 of 2 citation(s)`, the UNCOMMITTED TARGETS detail row printing BOTH counts,
 *      `PAST EOF` absent, `strict offenders 0`.
 *   P2 control, own repo, cite line 90 — past HEAD's copy AND past this disk's: exit 1, `PAST EOF (1)` naming
 *      the 21-line copy, `uncommitted targets 0 of 1`. The exemption must not swallow it.
 *   P3 control, own repo, cite line 30 of a target whose two copies are identical (21 lines each): exit 1
 *      `PAST EOF (1)`, `uncommitted targets 0 of 1` — a dirty file elsewhere in the tree must not become an
 *      excuse for the plane.
 *   P4 the backlog self-heals: the P1 plant in a repo where the rewrite has been committed, so both copies are
 *      41 lines. exit 0, `uncommitted targets 0 of 2`, no detail row, no PAST EOF.
 *   P5 own repo, same line count on both planes, blank AT HEAD only: exit 0, `blank-line cites 1 at HEAD` and
 *      `uncommitted targets 0 of 1` — the two backlog classes must not double-charge one row, and they cannot,
 *      because a blank in a committed section is counted rather than offended, so it never reaches the new
 *      exemption at all.
 *   P6 own repo, the mirror: HEAD holds text at line 8 and this disk is blank. exit 0 with `blank-line cites 0
 *      at HEAD` — the reader that shipped today bills this row to HEAD's backlog off this machine's bytes.
 *   P7 a root with ledgers, targets and NO git: exit 2 and `RESULT: UNCHECKED — … ledger read(s) failed`, i.e.
 *      the new target-read refusal does not hijack the message on a plane where nothing can be read.
 *   P8 the supplied `--dir`/`--head-dir` pair, head plane holding the 21-line copy while the repository disk
 *      holds 41: exit 0, `uncommitted targets 1 of 1 citation(s)` — the class must be buildable from files or
 *      its red side has no re-runnable arm (D163's lesson).
 *   P9 the same pair with a head plane that holds NO copy of the target: exit 0, `uncommitted targets 0 of 1`,
 *      no PAST EOF — a plane with no copy gets no line claim, and the census must not fall through to the disk.
 *   R1 this repository, `--report`: exit 0 and the `uncommitted targets <N> of <M> citation(s)` line printed.
 *
 * RUN 1, recorded because the predictions above were written before it: 8 of 10 held and P1 and P8 MISSED on
 * a clause of this file's own making — both arms require the detail row that says "PAST EOF would fire here"
 * and simultaneously forbade the bare string `PAST EOF`. Exit codes and every predicted line held, so the
 * reader's behaviour was as written; the forbidden pattern now names the charged spelling `PAST EOF (N)`, the
 * same distinction D192 made about a report line. Run 2: 10 arms, 10 held, 0 missed.
 *
 * usage: node scripts/falsify_plane_reads.mjs [--reader=<planted reader>] [--help]
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLANT_ARG = process.argv.find((a) => a.startsWith('--reader='));
if (process.argv.includes('--help')) {
  console.log('usage: node scripts/falsify_plane_reads.mjs [--reader=<planted reader>] [--help]');
  console.log('  the reader defaults to scripts/check_ledger_citations.mjs beside this file');
  process.exit(0);
}
const READER = PLANT_ARG ? PLANT_ARG.slice('--reader='.length) : join(HERE, 'check_ledger_citations.mjs');
const ROOT = process.cwd();
const FIX = join(tmpdir(), 'nexus-d204-plane-reads');
rmSync(FIX, { recursive: true, force: true });

const die = (m) => { console.error(`RIG REFUSED — ${m}`); process.exit(2); };
// The identity goes on the command, never into config, and a failed git call is fatal HERE rather than
// surfacing three statements later as "the commit does not hold the target" — which is exactly the
// mis-attribution this repository's own gate exists to refuse (the first run of this file died on that
// downstream guard while the real cause was `Author identity unknown` in the commit it had swallowed).
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=NEXUS Witness', '-c', 'user.email=witness@nexus.local',
    '-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')} in ${dir} failed — ${r.stderr.trim() || r.status}`);
  return r;
};
/** Lines the way the reader counts them: `split(/\r?\n/)`, so a body ending in a newline has one more. */
const count = (text) => text.split(/\r?\n/).length;
function fileBody(n, tag, blankAt = null) {
  return Array.from({ length: n }, (_, i) => (blankAt === i + 1 ? '' : `${tag} line ${i + 1}`)).join('\n') + '\n';
}
function run(args, cwd) {
  const r = spawnSync(process.execPath, [READER, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const LEDGER = (plant) => ['# D204 witness — committed plane', '', '## D901 A section that exists at HEAD', '',
  plant, ''].join('\r\n');
const NO_CITE = 'No citation-shaped token here, and that is fine.';
const DEFAULT_PLANT = 'The rewrite is at scripts/target_short.mjs:30 and a line both copies hold is at scripts/target_short.mjs:5.';

/**
 * One fixture repository: 120 filler files (the reader refuses a source index under 100), four targets with the
 * plane relationships the arms need, the two ledgers with `plant` committed into DECISIONS, one commit, then
 * this disk rewritten to the dirty copies. `committed` folds the rewrite into the commit, which is P4's plane.
 * Every number an arm predicts comes out of the bodies returned here, never out of a typed count.
 */
function rig(name, { plant = DEFAULT_PLANT, committed = false } = {}) {
  const dir = join(FIX, name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  for (let i = 0; i < 120; i += 1) {
    writeFileSync(join(dir, 'scripts', `filler${String(i).padStart(3, '0')}.mjs`), fileBody(3, 'filler'), 'utf8');
  }
  const targets = {
    'scripts/target_short.mjs': { head: fileBody(20, 'short'), disk: fileBody(40, 'short') },
    'scripts/target_clean.mjs': { head: fileBody(20, 'clean'), disk: fileBody(20, 'clean') },
    'scripts/target_blankhead.mjs': { head: fileBody(20, 'bh', 8), disk: fileBody(20, 'bh') },
    'scripts/target_blankdisk.mjs': { head: fileBody(20, 'bd'), disk: fileBody(20, 'bd', 8) },
  };
  if (committed) for (const t of Object.values(targets)) t.head = t.disk;
  for (const [rel, t] of Object.entries(targets)) writeFileSync(join(dir, rel), t.head, 'utf8');
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), LEDGER(plant), 'utf8');
  writeFileSync(join(dir, 'docs', 'STATUS.md'), LEDGER(NO_CITE), 'utf8');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'witness: HEAD copies of four targets and two ledgers');
  const tree = git(dir, 'ls-tree', '-r', '--name-only', 'HEAD').stdout.split('\n');
  for (const rel of Object.keys(targets)) {
    if (!tree.includes(rel)) die(`${name}: the commit does not hold ${rel} — the arm cannot ask HEAD for its bytes`);
  }
  if (git(dir, 'show', 'HEAD:docs/DECISIONS.md').status !== 0) die(`${name}: HEAD holds no ledger for the committed plane`);
  if (!committed) for (const [rel, t] of Object.entries(targets)) {
    if (t.disk !== t.head) writeFileSync(join(dir, rel), t.disk, 'utf8');
  }
  const diskLine8 = readFileSync(join(dir, 'scripts', 'target_blankhead.mjs'), 'utf8').split(/\r?\n/)[7];
  if (committed ? diskLine8.trim() === '' : diskLine8.trim() === '') die(`${name}: the disk copy of blankhead must hold text at line 8`);
  const headLine8 = git(dir, 'show', 'HEAD:scripts/target_blankhead.mjs').stdout.split(/\r?\n/)[7];
  if (!committed && headLine8.trim() !== '') die(`${name}: HEAD's copy of blankhead must be blank at line 8`);
  return { dir, plant, nHead: count(targets['scripts/target_short.mjs'].head),
    nDisk: count(targets['scripts/target_short.mjs'].disk) };
}

const ARMS = [];
const arm = (a) => { ARMS.push(a); };
/** A repo of its own, so one arm's plant cannot leak into another's verdict. */
const solo = (name, opts) => { const r = rig(name, opts); return { run: () => run([], r.dir), r }; };

const P1 = rig('p1_fire');
arm({ name: 'P1 — a cite past HEAD\'s copy of a dirty target is counted, not judged', expect: 0,
  run: () => run([], P1.dir),
  must: [/uncommitted targets\s+1 of 2 citation\(s\)/,
    /UNCOMMITTED TARGETS — cites whose line exists only in this disk's rewrite \(1\)/,
    new RegExp(`HEAD's copy of scripts/target_short\\.mjs has ${P1.nHead} line\\(s\\) and this disk's has ${P1.nDisk}`),
    /strict offenders\s+0 offender\(s\)/],
  absent: [/PAST EOF \(\d+\)/, /FALSE LEDGER CITATIONS/] });

const P2 = solo('p2_both_planes', { plant: 'The far line is at scripts/target_short.mjs:90.' });
arm({ name: 'P2 control — a cite that offends on both copies stays a strict offender: the class is not a mute',
  expect: 1, run: P2.run,
  must: [/FALSE LEDGER CITATIONS \(1\)/, /PAST EOF \(1\)/, /uncommitted targets\s+0 of 1 citation\(s\)/] });

const P3 = solo('p3_clean_target', { plant: 'The clean target is at scripts/target_clean.mjs:30.' });
arm({ name: 'P3 control — a dirty file elsewhere in the tree does not exempt a cite into a file whose copies agree',
  expect: 1, run: P3.run,
  must: [/FALSE LEDGER CITATIONS \(1\)/, /PAST EOF \(1\)/, /uncommitted targets\s+0 of 1 citation\(s\)/] });

const P4 = rig('p4_committed', { committed: true });
arm({ name: 'P4 — once the rewrite is committed the two copies agree and the backlog is gone', expect: 0,
  run: () => run([], P4.dir),
  must: [/uncommitted targets\s+0 of 2 citation\(s\)/, /strict offenders\s+0 offender\(s\)/],
  absent: [/UNCOMMITTED TARGETS —/, /PAST EOF \(\d+\)/] });

const P5 = solo('p5_blank_head', { plant: 'The blank line is at scripts/target_blankhead.mjs:8.' });
arm({ name: 'P5 — a blank at HEAD is HEAD\'s blank backlog, and it is not double-charged as uncommitted',
  expect: 0, run: P5.run,
  must: [/blank-line cites\s+1 at HEAD/, /uncommitted targets\s+0 of 1 citation\(s\)/, /strict offenders\s+0/] });

const P6 = solo('p6_blank_disk', { plant: 'The line is at scripts/target_blankdisk.mjs:8.' });
arm({ name: 'P6 — a blank that exists only on this disk is not counted as HEAD\'s backlog', expect: 0,
  run: P6.run, must: [/blank-line cites\s+0 at HEAD/, /strict offenders\s+0/], absent: [/is empty/] });

arm({ name: 'P7 — a plane with no git refuses as an unread ledger, not as a clean census', expect: 2,
  run: () => {
    const dir = join(FIX, 'p7_plain');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'docs'), { recursive: true });
    for (let i = 0; i < 120; i += 1) {
      writeFileSync(join(dir, 'scripts', `filler${String(i).padStart(3, '0')}.mjs`), fileBody(3, 'filler'), 'utf8');
    }
    writeFileSync(join(dir, 'scripts', 'target_short.mjs'), fileBody(20, 'short'), 'utf8');
    writeFileSync(join(dir, 'docs', 'DECISIONS.md'), LEDGER('The cite is at scripts/target_short.mjs:8.'), 'utf8');
    writeFileSync(join(dir, 'docs', 'STATUS.md'), LEDGER(NO_CITE), 'utf8');
    return run([], dir);
  },
  must: [/RESULT: UNCHECKED/, /ledger read\(s\) failed/] });

// P8/P9 aim the supplied pair at P1's repository: the head plane is files the arm writes, the disk plane is the
// repository plane the reader already resolves against.
const PAIR_PLANT = 'The supplied line is at scripts/target_short.mjs:30.';
arm({ name: 'P8 — the class is buildable through --head-dir, so its red side is re-runnable', expect: 0,
  run: () => {
    const head = join(FIX, 'p8_head'), disk = join(FIX, 'p8_disk');
    mkdirSync(join(head, 'docs'), { recursive: true });
    mkdirSync(join(head, 'scripts'), { recursive: true });
    mkdirSync(join(disk, 'docs'), { recursive: true });
    writeFileSync(join(head, 'scripts', 'target_short.mjs'), fileBody(20, 'short'), 'utf8');
    for (const d of [head, disk]) {
      writeFileSync(join(d, 'docs', 'DECISIONS.md'), LEDGER(PAIR_PLANT), 'utf8');
      writeFileSync(join(d, 'docs', 'STATUS.md'), LEDGER(NO_CITE), 'utf8');
    }
    return run(['--dir', disk, '--head-dir', head], P1.dir);
  },
  must: [/uncommitted targets\s+1 of 1 citation\(s\)/, /strict offenders\s+0/],
  // The offender SPELLING is what must be absent, never the bare words: the backlog detail row this arm
  // requires says "PAST EOF would fire here" by design, and the first run of this file MISSED P1 and P8 for
  // requiring that row while forbidding the string it contains.
  absent: [/PAST EOF \(\d+\)/] });

arm({ name: 'P9 — a supplied head plane without the target makes no line claim at all', expect: 0,
  run: () => {
    const head = join(FIX, 'p9_head'), disk = join(FIX, 'p9_disk');
    mkdirSync(join(head, 'docs'), { recursive: true });
    mkdirSync(join(disk, 'docs'), { recursive: true });
    for (const d of [head, disk]) {
      writeFileSync(join(d, 'docs', 'DECISIONS.md'), LEDGER(PAIR_PLANT), 'utf8');
      writeFileSync(join(d, 'docs', 'STATUS.md'), LEDGER(NO_CITE), 'utf8');
    }
    return run(['--dir', disk, '--head-dir', head], P1.dir);
  },
  must: [/uncommitted targets\s+0 of 1 citation\(s\)/, /strict offenders\s+0/],
  absent: [/PAST EOF \(\d+\)/, /UNCOMMITTED TARGETS —/] });

arm({ name: 'R1 — the class is reachable on this repository\'s own ledgers', expect: 0,
  run: () => run(['--report'], ROOT),
  must: [/uncommitted targets\s+\d+ of \d+ citation\(s\)/, /strict offenders\s+\d+ offender\(s\)/] });

let missed = 0;
for (const a of ARMS) {
  const { code, out } = a.run();
  const badMust = (a.must ?? []).filter((re) => !re.test(out));
  const badAbsent = (a.absent ?? []).filter((re) => re.test(out));
  const held = code === a.expect && badMust.length === 0 && badAbsent.length === 0;
  if (!held) {
    missed += 1;
    console.log(`MISSED  ${a.name}`);
    console.log(`        exit ${code} (expected ${a.expect})`
      + `${badMust.length ? `, ${badMust.length} predicted line(s) absent` : ''}`
      + `${badAbsent.length ? `, ${badAbsent.length} forbidden line(s) present` : ''}`);
    for (const l of out.split('\n').filter((x) => /offender|EOF|blank-line|untracked|uncommitted|RESULT|FALSE|UNCHECKED|RIG|Error/.test(x))) {
      console.log(`        | ${l}`);
    }
  } else {
    console.log(`held    exit ${code} as predicted   ${a.name}`);
  }
}
rmSync(FIX, { recursive: true, force: true });
console.log(`\n  ${ARMS.length} arms · ${ARMS.length - missed} held · ${missed} missed`);
console.log(`RESULT: ${missed === 0 ? 'PASS' : 'FAIL'} — line claims are read from the plane being judged,`
  + ' and a cite that offends on both copies still reddens.');
process.exit(missed === 0 ? 0 : 1);
