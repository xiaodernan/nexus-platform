#!/usr/bin/env node
/**
 * NEXUS D116 — both sides of scripts/check_ledger_sections.mjs, shown rather than asserted.
 *
 * A validator whose first run is also its first test has not been tested, so every arm here states the
 * verdict it expects *before* the shipped checker is called, and the harness exits non-zero if a
 * prediction misses: the arms that must redden are a committed heading deleted from disk, a duplicated
 * heading number, the reconstructed working copy D115 recovered, and a DECISIONS-side deletion (so the
 * rule is shown not to be STATUS-specific); the arms that must stay green are this tree as it stands and
 * a draft section that is on disk and not yet committed — the state writing an entry starts in. The two
 * NOT CHECKED arms are a `git show` that cannot resolve and a ledger whose heading pattern matches
 * nothing, because "did not run" and "found nothing" are different answers (D93, D96).
 *
 * Each arm gets its own fixture directory, so an arm cannot borrow another arm's redness: the only
 * collateral in the table comes from the reconstructed arm, whose `--head-rev` predates D115's decision
 * entry and so also prints one uncommitted DECISIONS heading. That is named, not hidden.
 *
 * Usage: node scripts/falsify_ledger_sections.mjs
 * Exit: 0 every prediction held · 1 an arm missed (the checker cannot do what the ledger says it does)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// D153: this line named one developer's home directory as the fallback, so on any other account the harness
// wrote fixtures into a path that does not exist. `tmpdir()` is the resolver the sibling harness
// (`falsify_status_citations.mjs`) already uses, and it is environment-derived on every platform.
const FIX = join(tmpdir(), 'nexus-d116-falsify');
const CHECKER = join(ROOT, 'scripts', 'check_ledger_sections.mjs');
const RECOVERY = '99e5b0c';

const show = (rev, p) => execFileSync('git', ['show', `${rev}:${p}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }).replace(/\r\n/g, '\n');
const writeLedgers = (dir, status, decisions) => {
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'STATUS.md'), status, 'utf8');
  writeFileSync(join(dir, 'docs', 'DECISIONS.md'), decisions, 'utf8');
  return dir;
};

const diskStatus = readFileSync(join(ROOT, 'docs', 'STATUS.md'), 'utf8').replace(/\r\n/g, '\n');
const diskDecisions = readFileSync(join(ROOT, 'docs', 'DECISIONS.md'), 'utf8').replace(/\r\n/g, '\n');
const headStatus = show('HEAD', 'docs/STATUS.md');

rmSync(FIX, { recursive: true, force: true });

/** Rebuild the properties of the working copy D115 found, from the two commits either side of the recovery:
 *  HEAD-before's file, plus the nine recovered sections put back under the numbers they were written with. */
const preRecoveryTree = () => {
  const before = show(`${RECOVERY}^`, 'docs/STATUS.md');
  const recovered = show(RECOVERY, 'docs/STATUS.md');
  const block = recovered.split('\n');
  const from = block.findIndex((l) => l.startsWith('## 115. '));
  if (from < 0) throw new Error('the recovery commit holds no §115 heading, so the fixture has nothing to put back');
  const nine = block.slice(from).join('\n')
    .replace(/^## \d+\. \[recovered by D115 from the working copy's §(\d+)\] /gm, '## $1. ');
  const cut = before.split('\n').findIndex((l) => l.startsWith('## 100. The gate was measured on a tree'));
  if (cut < 0) throw new Error('HEAD-before-recovery holds no §100 to insert the nine against');
  return { text: [...before.split('\n').slice(0, cut), ...nine.split('\n'), ...before.split('\n').slice(cut)].join('\n'),
           headings: [...nine.matchAll(/^## (\d+)\. /gm)].length };
};

// A draft number is derived, never written down: this arm said `125` until the day §125 was committed,
// and then it was a duplicate rather than a draft and reddened for the wrong reason.
const FREE = 1 + Math.max(...[...headStatus.matchAll(/^## (\d+)\. /gm)].map((m) => +m[1]));
const ARMS = [
  { name: 'control: this tree as it stands', dir: ROOT, expect: 0, must: [/RESULT: PASS/] },
  { name: 'a committed section deleted from the working copy', status: headStatus.replace('## 124. Nine sections stranded', '## 999. Nine sections stranded'), expect: 1, must: [/FORK docs\/STATUS\.md: 1 section\(s\) committed/, /absent/] },
  { name: 'the same section duplicated on disk', status: headStatus + '\n## 124. A second claim on one number\n\nbody\n', expect: 1, must: [/FORK docs\/STATUS\.md: duplicated section numbers/, /on disk: 124×2/] },
  { name: `a draft section on disk, not yet committed (§${FREE} does not exist at HEAD)`, status: headStatus + `\n## ${FREE}. A section being written right now\n\nbody\n`, expect: 0, must: [/RESULT: PASS/, /NOTE docs\/STATUS\.md: 1 section\(s\) on disk and not at/] },
  { name: 'the DECISIONS plane, same rule', decisions: diskDecisions.replace('## D115 A recovery commit', '## D999 A recovery commit'), expect: 1, must: [/FORK docs\/DECISIONS\.md: 1 decision\(s\) committed/] },
  { name: 'a ledger whose heading pattern matches nothing', status: headStatus.split('\n').slice(0, 40).join('\n'), expect: 2, must: [/NOT CHECKED/] },
  { name: 'a HEAD revision that does not resolve', headRev: 'no-such-revision-9b4c1', expect: 2, must: [/NOT CHECKED/] },
];

const results = [];
for (const arm of ARMS) {
  let dir = ROOT, args = ['--head-rev', arm.headRev || 'HEAD'];
  if (arm.status || arm.decisions || arm.pre) {
    dir = writeLedgers(join(FIX, arm.name.replace(/[^\w]+/g, '_').slice(0, 40)),
      arm.pre ? preRecoveryTree().text : (arm.status ?? diskStatus),
      arm.decisions ?? diskDecisions);
    if (arm.pre) args = ['--head-rev', `${RECOVERY}^`];
  }
  let out, code;
  try {
    out = execFileSync('node', [CHECKER, ...args, '--dir', dir], { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
    code = 0;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
    code = e.status === undefined ? -1 : e.status;
  }
  const missed = arm.must.filter((re) => !re.test(out));
  results.push({ arm, code, missed, out });
}

// The reconstructed pre-recovery tree is checked on its properties as well as its verdict. The predictions
// below were written from the two properties D115 measured on the real tree — nine sections put back under
// the numbers the working copy wrote them with (§100-§108 there; §101-§108 are gaps at HEAD, which is why
// the checker sees eight disk-only and one collision), and nothing else lost — not from a first run.
{
  const tree = preRecoveryTree();
  if (tree.headings !== 9) throw new Error(`the fixture put back ${tree.headings} headings, not nine`);
  const dir = writeLedgers(join(FIX, 'prerecovery'), tree.text, diskDecisions);
  let out, code;
  try { out = execFileSync('node', [CHECKER, '--head-rev', `${RECOVERY}^`, '--dir', dir], { encoding: 'utf8', cwd: ROOT }); code = 0; }
  catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status === undefined ? -1 : e.status; }
  // The DECISIONS NOTE count is deliberately not pinned: `99e5b0c^` predates every decision written since
  // the recovery, so the arm's own fixture grows by one disk-only decision each time this lane lands an
  // entry. Pinning it to `1` made this arm MISS the day D116 was committed — a rot the check itself
  // predicts. `missing 0` is the property that the reconstruction lost nothing.
  const want = [/FORK docs\/STATUS\.md: duplicated section numbers/, /on disk: 100×2/,
    /8 section\(s\) on disk and not at/, /missing 0/, /decision\(s\) on disk and not at/];
  results.push({
    arm: { name: `the working copy D115 recovered (rebuilt: ${tree.headings} headings put back as §100–§108, 8 of them new to ${RECOVERY}^)`, expect: 1, must: want },
    code, missed: want.filter((re) => !re.test(out)), out,
  });
}

let fails = 0;
for (const r of results) {
  const okCode = r.code === r.arm.expect;
  const ok = okCode && r.missed.length === 0;
  if (!ok) fails += 1;
  console.log(`${ok ? 'held  ' : 'MISSED'}  exit ${r.arm.expect} expected, ${r.code} printed   ${r.arm.name}`);
  if (!okCode) console.log(`        verdict differs — the arm ran on: ${r.out.split('\n').filter((l) => /FORk|FORK|NOTE|RESULT|NOT CHECKED/i.test(l)).slice(0, 4).join(' | ')}`);
  for (const m of r.missed) console.log(`        expected text missing: ${m}   — printed: ${r.out.split('\n').filter((l) => /RESULT|FORK|NOTE/.test(l)).slice(0, 3).join(' | ')}`);
}
console.log(`\n  ${results.length} arms · ${results.length - fails} held · ${fails} missed`);
console.log(`  fixture root: ${FIX}`);
console.log('  grammar: every arm runs the shipped checker as a subprocess on its own fixture directory, so');
console.log('           no arm can redden another; the only cross-plane noise is the reconstructed arm\'s');
console.log('           --head-rev, which predates D115 and so prints every DECISIONS entry written since');
console.log('           the recovery as disk-only — a count this harness deliberately does not pin.');
if (fails) { console.log('\nRESULT: FAIL — the fork guard does not do what its arms claim'); process.exit(1); }
console.log('\nRESULT: PASS — the guard reddens on every way a committed heading can go missing, and stays green on a draft');
