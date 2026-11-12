#!/usr/bin/env node
/**
 * NEXUS D993 — every smoke that points Spring Config Server at a throwaway on-disk repo must
 * build its `file://` URI PORTABLY: an absolute POSIX path on Linux, a drive letter only on
 * Git Bash/MSYS2. A bare, unconditional `cygpath` is a Windows-only assumption that silently
 * collapses to `file:///` on CI's Ubuntu runner.
 *
 * THE BUG (cloud required-gate red on CI run 43239073952 / head 68fdb85, the D992 push): the
 * platform-health red was GONE (D992's Flyway cascade fixed it — cloud got as far as the refresh
 * smoke), and the next step `cloud_refresh.sh` failed with:
 *     scripts/cloud_refresh.sh: line 82: cygpath: command not found
 *       config repo location: file:///
 *       FAIL: gateway resolved label 'local' instead of the repo's refresh-v1
 * `TMP_REPO_JAVA="file:///$(cygpath -m "$TMP_REPO" | ...)"` was written for Git Bash, where
 * `mktemp -d /tmp/...` yields an MSYS2 path the JVM cannot resolve and cygpath -m re-spells it
 * as D:/... . On Linux CI `cygpath` does not exist: the command substitution is empty, the URI
 * collapses to `file:///` (filesystem root), Config Server never sees nexus-gateway.yml, and the
 * gateway falls back to the default label `local`. `cloud_monolith_refresh.sh` ALREADY carried the
 * correct `if command -v cygpath ... else file://$TMP_REPO` guard; D993 applies that same proven
 * shape to `cloud_refresh.sh` (the observed red) and `insight_config_smoke.sh` (the identical
 * latent bug, invoked later in the same cloud job's long smoke chain — it would have been the
 * next red once refresh was fixed).
 *
 * WHAT THIS SOURCE GATE HOLDS (per script that mentions `cygpath` under scripts/):
 *   R1  it is guarded by `command -v cygpath` (never an unconditional invocation);
 *   R2  it has an `else` arm that uses the bare absolute POSIX path `file://$TMP_REPO`;
 *   R3  no naked `TMP_REPO_JAVA="file:///$(cygpath ...` line survives outside a guard;
 *   R4  the three known offenders/references (cloud_refresh, cloud_monolith_refresh,
 *       insight_config_smoke) are ALL present and ALL guarded — the census is non-vacuous, so
 *       deleting every cygpath mention cannot turn the gate green by finding nothing;
 *   R5  each of those three scripts is invoked by the CI cloud job (so a real Linux regression
 *       reddens the wire verifier too), the migration is pinned in the ledger §993 and ATLAS,
 *       and this reader runs in CI's self-test chain.
 * It is a SOURCE gate: it starts no JVM, no Config Server and no gateway. The branch behaviour is
 * separately falsified by an opt-in git-ignored probe (drive-letter URI with cygpath; a
 * repo-resolving `file:///tmp/...` URI without), NOT run by CI. Green here means "the shipped
 * scripts say the portable thing", not "a refresh round trip passed today" — the CI cloud job
 * remains the verifier of record.
 *
 * SELF-TEST: --self-test plants corruptions in memory — make a guarded script unconditional
 * (drop the `command -v` if), delete an `else` POSIX arm, restore a naked cygpath assignment in
 * each of the three, erase one of the three from the census, cut a CI invocation, cut the
 * CI/ATLAS/ledger wiring — and requires EACH to redden for its RIGHT expect tag while the real
 * plane holds. D954 no-op guard, D959 line-anchored `## 993.` heading, and a GREEN control (a
 * legitimate comment rewording) keep the judge honest.
 *
 * Usage:  node scripts/check_config_repo_uri_portable.mjs [--self-test] [--report] [--ci=<path>]
 * Exit:   0 every claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const SELF_TEST = argv.includes('--self-test');
const REPORT = argv.includes('--report');
const CI_OVERRIDE = argv.find((a) => a.startsWith('--ci='))?.slice('--ci='.length);

const SCRIPTS_DIR = 'scripts';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_config_repo_uri_portable.mjs';
const REQUIRED = [
  'scripts/cloud_refresh.sh',
  'scripts/cloud_monolith_refresh.sh',
  'scripts/insight_config_smoke.sh',
];
const GUARD = 'if command -v cygpath >/dev/null 2>&1; then';
const POSIX_ARM = 'TMP_REPO_JAVA="file://$TMP_REPO"';

// All shipped *.sh paths, so the census can be verified both ways without hard-coding the list.
const scriptFiles = () => readdirSync(join(ROOT, SCRIPTS_DIR))
  .filter((f) => f.endsWith('.sh'))
  .map((f) => `${SCRIPTS_DIR}/${f}`)
  .sort();

const HEADING_RE = /^## 993\. D993(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

/** Pure over a (path -> text) map; existence passed as a Set. `allSh` is the discovered script list. */
export function judge(files, present, allSh, ciPath = CI) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the config-URI plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const existsFile = (p, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}${tag(expect ?? `ABSENT — ${p}`)}`);
    else notes.push(`held ${p} exists`);
  };
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  /* 0 — every file this judgement depends on must exist, including the reader itself (so an
        absent-reader corruption reddens for cause rather than passing a vacuous census). */
  for (const p of [CI, ATLAS, STATUS, SELF]) existsFile(p, `ABSENT — ${p}`);

  /* R1-R3 — every shipped script that mentions cygpath must use the guarded, portable shape. */
  const cygScripts = allSh.filter((p) => present.has(p) && t(p).includes('cygpath'));
  if (cygScripts.length === 0) {
    offenders.push(`MISSING — no shipped script mentions cygpath; the portability census is vacuous${tag('CENSUS-NONVACUOUS')}`);
  } else {
    notes.push(`held the census is non-vacuous (${cygScripts.length} scripts mention cygpath)`);
  }
  for (const p of cygScripts) {
    has(p, GUARD, `${p} guards cygpath with command -v`, `GUARD:${p}`);
    has(p, POSIX_ARM, `${p} has the bare POSIX file:// else arm`, `POSIX:${p}`);
    // A guarded script must NOT ALSO carry a second, naked invocation outside the if. Counting
    // cygpath invocations: every `cygpath -m` occurrence must be on a line inside the guarded form.
    const lines = t(p).split(/\r?\n/);
    const cygInvocations = lines.filter((l) => l.includes('cygpath -m') && !l.trim().startsWith('#'));
    for (const l of cygInvocations) {
      // The only legal invocation line is the one nested inside the guarded `then` arm, which is
      // indented 4 spaces and immediately follows the `if command -v` line.
      const idx = lines.indexOf(l);
      const prev = idx > 0 ? lines[idx - 1] : '';
      const legal = l.includes('$(cygpath -m "$TMP_REPO"') && prev.includes(GUARD);
      if (!legal) offenders.push(`STALE — ${p}: a cygpath invocation is not directly inside the command-v guard: ${l.trim()}${tag(`NAKED:${p}`)}`);
    }
    if (cygInvocations.length) notes.push(`held ${cygInvocations.length} guarded cygpath invocation(s) in ${p}`);
  }

  /* R4 — the three known scripts are present and all guarded (deleting one cannot pass). */
  for (const p of REQUIRED) {
    if (!present.has(p)) { offenders.push(`ABSENT — ${p}: a required config-repo smoke is missing${tag('REQUIRED-ABSENT')}`); continue; }
    has(p, GUARD, `${p} still carries the guarded shape`, `REQUIRED-GUARD:${p}`);
    has(p, POSIX_ARM, `${p} still carries the POSIX else arm`, `REQUIRED-POSIX:${p}`);
  }

  /* R5 — CI invokes all three; wiring is intact. */
  for (const p of REQUIRED) {
    has(ciPath, `bash ${p}`, `CI invokes ${p}`, `CI-INVOKE:${p}`);
  }
  has(ciPath, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  for (const p of REQUIRED) has(ATLAS, p, `ATLAS lists ${p}`, `ATLAS-SCRIPT:${p}`);
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 993. D993\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D993 heading line');
  has(STATUS, 'cygpath: command not found', 'the ledger records the real CI failure signature', 'LEDGER-SIGNATURE');
  has(STATUS, 'gateway resolved label', 'the ledger records the label-local fallback', 'LEDGER-LABEL');

  return { offenders, notes, unchecked: null, paths: [...REQUIRED, CI, ATLAS, STATUS, SELF] };
}

function fromDisk(allSh) {
  const files = new Map();
  const present = new Set();
  for (const p of [...allSh, CI, ATLAS, STATUS, SELF]) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');
const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  f.set(p, text.split(from).join(to));
  return { files: f };
};
const dropHeadingLine = (files, p, headingRe) => {
  const f = new Map(files);
  f.set(p, (f.get(p) ?? '').split(/\r?\n/).filter((l) => !headingRe.test(l)).join('\n'));
  return { files: f };
};

const allSh = scriptFiles();
if (SELF_TEST) {
  const { files: real, present } = fromDisk(allSh);
  const ciPath = CI_OVERRIDE ?? CI;
  const base = judge(real, present, allSh, ciPath);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const R = REQUIRED;
  const arms = [
    ['cloud_refresh guard removed', mutate(real, R[0], GUARD, 'if true; then'), `GUARD:${R[0]}`],
    ['cloud_refresh POSIX else arm erased', mutate(real, R[0], POSIX_ARM, 'TMP_REPO_JAVA="file:///"'), `POSIX:${R[0]}`],
    ['cloud_refresh naked cygpath after the guard', mutate(real, R[0], POSIX_ARM + '\nfi', POSIX_ARM + `\nfi\nTMP_REPO_JAVA="file:///$(cygpath -m "$TMP_REPO" | sed 's|\\\\|/|g')"`), `NAKED:${R[0]}`],
    ['monolith_refresh guard removed', mutate(real, R[1], GUARD, 'if true; then'), `GUARD:${R[1]}`],
    ['monolith_refresh POSIX else arm erased', mutate(real, R[1], POSIX_ARM, 'TMP_REPO_JAVA="file:///"'), `POSIX:${R[1]}`],
    ['insight_config guard removed', mutate(real, R[2], GUARD, 'if true; then'), `GUARD:${R[2]}`],
    ['insight_config POSIX else arm erased', mutate(real, R[2], POSIX_ARM, 'TMP_REPO_JAVA="file:///"'), `POSIX:${R[2]}`],
    ['one required script erased from census', { files: real, present: new Set([...present].filter((p) => p !== R[2])) }, 'REQUIRED-ABSENT'],
    // D995 follow-through: the census is sourced from ALL discovered *.sh that mention cygpath
    // (judge's `cygScripts`), so the vacuous arm must erase cygpath from that whole set — not just
    // the fixed REQUIRED three. A fourth guarded script (dispatcher_config_smoke.sh, D994) joined
    // the plane; erasing only REQUIRED left that one's cygpath intact, so the census never went
    // empty and CENSUS-NONVACUOUS never fired — the arm false-greened as REQUIRED-GUARD instead,
    // reddening CI's line-171 chain on this push. Erase from cygList(real, allSh) to test the real
    // vacuous guard; R4's REQUIRED-GUARD offenders may co-occur but CENSUS-NONVACUOUS is now in
    // the list, so the for-cause `[expect]` check passes again.
    ['all cygpath mentions removed (vacuous census)', (() => {
      const f = new Map(real);
      for (const p of cygList(real, allSh)) f.set(p, (f.get(p) ?? '').split('cygpath').join('true'));
      return { files: f };
    })(), 'CENSUS-NONVACUOUS'],
    ['CI cloud_refresh invocation cut', mutate(real, ciPath, `bash ${R[0]}`, 'bash scripts/_absent.sh'), `CI-INVOKE:${R[0]}`],
    ['CI insight_config invocation cut', mutate(real, ciPath, `bash ${R[2]}`, 'bash scripts/_absent.sh'), `CI-INVOKE:${R[2]}`],
    ['CI self-test chain cut', mutate(real, ciPath, CI_SELFTEST, 'node scripts/_absent.mjs --self-test'), 'CI-READER'],
    ['ATLAS reader row erased', mutate(real, ATLAS, `\`${SELF}\``, '`scripts/_removed.mjs`'), 'ATLAS-READER'],
    ['ATLAS cloud_refresh row erased', mutate(real, ATLAS, `\`${R[0]}\``, '`scripts/_removed.sh`'), `ATLAS-SCRIPT:${R[0]}`],
    ['ledger D993 heading removed', dropHeadingLine(real, STATUS, HEADING_RE), 'LEDGER-HEADING'],
    ['ledger failure signature erased', mutate(real, STATUS, 'cygpath: command not found', 'a path bug'), 'LEDGER-SIGNATURE'],
    ['ledger label fallback erased', mutate(real, STATUS, 'gateway resolved label', 'the gateway answered'), 'LEDGER-LABEL'],
  ];
  const absentPresent = new Set(present);
  absentPresent.delete(SELF);
  arms.push(['reader file absent', { files: real, present: absentPresent, expect: `ABSENT — ${SELF}` }]);

  const baseSig = snapshot(real) + '\u0001' + [...present].sort().join(',');
  let allCaught = true;
  for (const [label, arm, tagName] of arms) {
    const expect = arm.expect ?? tagName;
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(44)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const sig = snapshot(arm.files) + '\u0001' + [...(arm.present ?? present)].sort().join(',');
    if (sig === baseSig) { console.log(`  self-test  ${label.padEnd(44)} NO-OP (defect!)`); allCaught = false; continue; }
    const out = judge(arm.files, arm.present ?? present, allSh, ciPath);
    const red = out.offenders.length > 0 || out.unchecked;
    const rightReason = out.offenders.some((o) => o.includes(expect));
    const pass = red && rightReason;
    console.log(`  self-test  ${label.padEnd(44)} ${pass ? 'red' : 'GREEN/WRONG (defect!)'} offenders=${out.offenders.length} expect="${expect}"`);
    if (!pass) { allCaught = false; for (const o of out.offenders.slice(0, 3)) console.log('      got: ' + o); }
  }
  // GREEN control: a legitimate comment rewording must NOT redden (guards an overfit judge).
  {
    const f = new Map(real);
    f.set(R[0], (f.get(R[0]) ?? '').replace('Guard on the command\'s presence, never assume it.', 'Guard on the command being available; never assume that.'));
    const out = judge(f, present, allSh, ciPath);
    const controlGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate comment rewording stays GREEN'.padEnd(44)} ${controlGreen ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!controlGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  {
    const out = judge(real, present, allSh, ciPath);
    const realGreen = out.offenders.length === 0;
    console.log(`  self-test  ${'legitimate plane stays GREEN'.padEnd(44)} green offenders=${out.offenders.length}`);
    if (!realGreen) { for (const o of out.offenders) console.log('      got: ' + o); allCaught = false; }
  }
  console.log(`  self-test  all arms redden for cause + guards green: ${allCaught} (${arms.length} corruption arms)`);
  process.exit(allCaught ? 0 : 1);
}

function cygList(files, paths) {
  return paths.filter((p) => (files.get(p) ?? '').includes('cygpath'));
}

const ciPath = CI_OVERRIDE ?? CI;
const { files, present } = fromDisk(allSh);
const result = judge(files, present, allSh, ciPath);
if (result.unchecked) { console.log('RESULT: NOT CHECKED — ' + result.unchecked); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log('  ' + n);
if (result.offenders.length) {
  console.log(`FALSE CONFIG-URI PORTABILITY (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D993 config-repo URIs are portable, ${result.notes.length} holds`);
