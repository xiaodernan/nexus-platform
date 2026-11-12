#!/usr/bin/env node
/**
 * NEXUS D1006 — the cloud path filter covers the full line-171 chain it verifies.
 *
 * The changes job gates the cloud CI job with a path grep. The cloud job's first real step is the
 * line-171 self-test chain: ~45 `node scripts/<reader>.mjs [--self-test]` invocations. Before this
 * unit, the filter admitted only cloud-named readers (`check_cloud_*`, `falsify_cloud_*`, plus the
 * smoke- and service-script prefixes), so a push touching `check_d981_contract_and_d705_followup.mjs` —
 * the exact reader whose line-171 arm drifted after D1003 — could never re-run the chain that was
 * failing because of it. D1004 went red at the chain on a perfectly good reader owner; the green that
 * landed in D1005 was never CI-verified, because this push matched no cloud path either.
 *
 * This reader pins the two sides together:
 *   (a) the filter line exists and admits every `scripts/...` file invoked by the line-171 chain —
 *       i.e. the regex literal in `ci.yml` matches `^scripts/<file>` for every invoked reader/script
 *       (the grep is `grep -qE`, so an admitted prefix means a push touching that file re-triggers);
 *   (b) the smoke chain's helper scripts are all admitted too (same construction);
 *   (c) the chain reader census is non-empty and complete — an empty census is uncheckable, never green.
 *
 * SELF-TEST: widened regex reverted to the pre-D1006 shape (a named reader drops out);
 * one prefix deleted from the regex (a mid-chain reader drops out); the filter line erased;
 * the line-171 chain emptied (census uncheckable); ATLAS/ledger anchors erased; the CI smoke chain
 * invocation erased. A legitimate comment edit stays GREEN.
 *
 * Usage:  node scripts/check_cloud_filter_covers_chain.mjs [--self-test] [--report]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cloud_filter_covers_chain.mjs';
const PATHS = [CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1006\. D1006(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1006 plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  for (const p of PATHS) exists(p, `${p} exists`);

  const ciText = t(CI);

  /* locate the filter line: `p cloud '<regex>'` */
  const filterMatch = /p cloud '([^']+)'/.exec(ciText);
  if (!filterMatch) {
    offenders.push(`MISSING — ${CI}: the changes-job \`p cloud '<regex>'\` filter line not found${tag('FILTER-MISSING')}`);
    return { offenders, notes, paths: PATHS, unchecked: 'no filter line — refusing to agree with an absent gate' };
  }
  const regexSource = filterMatch[1];
  let re;
  try {
    re = new RegExp(regexSource);
  } catch (err) {
    offenders.push(`BROKEN — ${CI}: the cloud path regex does not compile: ${err.message}${tag('FILTER-BROKEN')}`);
    return { offenders, notes, paths: PATHS };
  }
  notes.push(`held the cloud path filter line found and compiles: ${regexSource.slice(0, 60)}…`);

  /* census the line-171 chain: every `node scripts/<file>[ --self-test]` invocation inside the chain block */
  const chainStart = ciText.indexOf('node scripts/check_cloud_plane_ports.mjs');
  if (chainStart < 0) {
    return { offenders: [`MISSING — ${CI}: the line-171 chain sentinel not found — the census has nothing to scan${tag('CHAIN-MISSING')}`], notes, paths: PATHS };
  }
  const chainBlock = ciText.slice(chainStart, ciText.indexOf('- name: Apply migrations', chainStart));
  const invocations = [...chainBlock.matchAll(/node (scripts\/[A-Za-z0-9_.-]+\.mjs)/g)].map((m) => m[1]);
  const census = [...new Set(invocations)].sort();
  if (census.length === 0) {
    return { offenders: [`EMPTY CENSUS — ${CI}: the line-171 chain invokes no readers — a chain with nothing to verify verified nothing${tag('CHAIN-EMPTY')}`], notes, paths: PATHS };
  }
  notes.push(`held the chain census: ${census.length} distinct reader scripts invoked`);

  /* every invoked reader must be admitted by the filter regex (a push touching it re-triggers) */
  const misses = census.filter((file) => !re.test(file));
  for (const miss of misses) {
    offenders.push(`ESCAPED — ${CI}: the chain invokes ${miss} but the cloud path filter does not admit it — `
      + `a push touching that reader will never re-run the chain that verifies it${tag('FILTER-UNDERCOVER')}`);
  }
  if (misses.length === 0) notes.push(`held every chain reader is admitted by the cloud filter`);

  /* the smoke chain's helper scripts must be admitted too (same marker file set) */
  const smokeMarkers = ['ci_ensure_redis.sh', 'dispatcher_config_smoke.sh', 'insight_config_smoke.sh',
                        'eureka_ha_smoke.sh', 'events_group_smoke.sh', 'events_claim_smoke.sh'];
  const smokeMisses = smokeMarkers.filter((file) => !re.test('scripts/' + file));
  for (const miss of smokeMisses) {
    offenders.push(`ESCAPED — ${CI}: the smoke chain needs ${miss} but the cloud path filter does not admit it${tag('SMOKE-UNDERCOVER')}`);
  }
  if (smokeMisses.length === 0) notes.push(`held every smoke-chain helper is admitted by the cloud filter`);

  /* (d) wiring: CI runs this reader; ATLAS lists it; the ledger holds the D1006 heading */
  if (!ciText.includes(CI_SELFTEST)) {
    offenders.push(`MISSING — ${CI}: this reader is not in the CI self-test chain (${CI_SELFTEST})${tag('CI-READER')}`);
  } else notes.push('held CI runs this reader in the self-test chain');
  const atlasText = t(ATLAS);
  if (!atlasText.includes(SELF)) {
    offenders.push(`MISSING — ${ATLAS}: no D1006 reader row${tag('ATLAS-READER')}`);
  } else notes.push('held ATLAS lists this reader');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1006. D1006\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1006 heading line');
  return { offenders, notes, paths: PATHS };
}

function fromDisk() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (existsSync(abs)) { present.add(p); files.set(p, readFileSync(abs, 'utf8')); }
  }
  return { files, present };
}

const mutate = (files, p, from, to) => {
  const f = new Map(files);
  const text = f.get(p);
  if (text === undefined || !text.includes(from)) {
    return { skipped: `plant token ${JSON.stringify(from)} absent in ${p}` };
  }
  f.set(p, text.split(from).join(to));
  return { files: f };
};

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const arms = [
    ['filter reverts to the pre-D1006 cloud-only reader set',
      mutate(real, CI,
             `^(services/cloud/|services/platform/|scripts/(check_|verify_|falsify_|cloud|`,
             `^(services/cloud/|services/platform/|scripts/(cloud|check_cloud|falsify_cloud|`),
             'FILTER-UNDERCOVER'],
    ['filter drops the shared-reader catch-all',
      mutate(real, CI, `check_|verify_|falsify_`, `check_cloud_`), 'FILTER-UNDERCOVER'],
    ['filter line erased',
      { files: (() => { const f = new Map(real); const t = f.get(CI) ?? ''; f.set(CI, t.replace(/\s*p cloud '[^']*'/, '')); return f; })(), present }, 'FILTER-MISSING'],
    ['the chain sentinel is cut',
      mutate(real, CI, 'node scripts/check_cloud_plane_ports.mjs', 'node scripts/definitely_not_invoked.mjs'), 'CHAIN-MISSING'],
    ['census emptied (chain step removed)',
      (() => {
        const f = new Map(real); const t = f.get(CI) ?? '';
        f.set(CI, t.replace(/node scripts\/check_cloud_plane_ports\.mjs[\s\S]*?- name: Apply migrations/, '- name: Apply migrations'));
        return { files: f };
      })(), 'CHAIN-MISSING'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_cloud_filter_erased.mjs'), 'ATLAS-READER'],
    ['ledger heading erased',
      (() => {
        const f = new Map(real);
        f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
        return { files: f };
      })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(52)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(52)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  {
    const p = new Map(real);
    p.set(CI, p.get(CI).replace('echo "Edge wiring reads"', 'echo "Edge wiring reads (comment tweak)"'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate filter-adjacent comment edit stays GREEN   ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
    if (!ok) allReddened = false;
  }
  console.log(`  self-test  all arms redden for cause + control green: ${allReddened} (${arms.length} arms)`);
  process.exit(allReddened ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE D1006 FILTER COVERAGE (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} filter offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1006 filter covers the chain, ${result.notes.length} holds`);
process.exit(0);
