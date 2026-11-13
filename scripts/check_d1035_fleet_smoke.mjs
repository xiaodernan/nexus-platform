#!/usr/bin/env node
/**
 * NEXUS D1035 — the whole Bus-lite fleet flips from ONE notice, pinned off disk.
 *
 * D1024 (dispatcher), D1025 (insight, two-member), D1026 (events, three-member), D1034 (gateway)
 * armed the members piecewise. D1035 is the fourth-and-final stitch: `scripts/bus_fleet_smoke.sh`
 * boots ALL FOUR members against a throwaway Config Server, POSTs `target=all` from the gateway's
 * door, and requires every member to answer `refresh-v2` on the same pid; then it rewrites the repo
 * to v3, POSTs `target=gateway`, and requires the gateway to flip to `refresh-v3` while the three
 * sidecars stay at `refresh-v2` — the negative arm for the hottest path of the product.
 *
 * This reader pins:
 *   (a) the smoke's boot manifest — all four members with the bus armed;
 *   (b) the target=all fleet flip and the receivers>=4 pin (hearers, not actors — the
 *       load-bearing proof is the label reads, and the reader pins those);
 *   (c) the same-pid rebind claim; the PASS line;
 *   (d) CI runs the smoke and this reader's self-test; ATLAS lists this reader; ledger holds D1035.
 *
 * SELF-TEST: 13 corruption arms + 1 GREEN control — target=all erased, receivers>=4 erased,
 * fleet v2 claim erased, target=gateway erased, same-pid rebind claim erased, the PASS line erased,
 * CI invocation erased, ATLAS row erased, ledger heading erased, the boot line for a member erased,
 * the all-resolve-refresh-v1 pin erased. Each must redden.
 *
 * Usage:  node scripts/check_d1035_fleet_smoke.mjs [--self-test]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const SMOKE = 'scripts/bus_fleet_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1035_fleet_smoke.mjs';
const PATHS = [SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1035\. D1035(?=\s|$)/m;
const CI_SMOKE = 'bus_fleet_smoke.sh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1035 plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* 1 — the smoke boots ALL FOUR members with the bus armed. */
  has(SMOKE, 'NEXUS_GATEWAY_BUS_ENABLED=true', 'the smoke arms the gateway with the bus', 'SMOKE-GW-ARM');
  has(SMOKE, 'NEXUS_BUS_ENABLED=true', 'the smoke arms the dispatcher with the bus', 'SMOKE-DISP-ARM');
  has(SMOKE, 'NEXUS_INSIGHT_BUS_ENABLED=true', 'the smoke arms insight with the bus', 'SMOKE-INSIGHT-ARM');
  has(SMOKE, 'NEXUS_EVENTS_BUS_ENABLED=true', 'the smoke arms events with the bus', 'SMOKE-EVENTS-ARM');
  has(SMOKE, 'all four members resolve refresh-v1', 'the smoke asserts all four boot on refresh-v1', 'SMOKE-V1');

  /* 2 — Scenario 1: one notice from the edge flips all four (hearers pinned, actors proven by labels). */
  has(SMOKE, 'target=all', 'the fleet smoke drives the target=all arm', 'SMOKE-ALL');
  has(SMOKE, '-ge 4', 'the fleet smoke pins receivers >= 4 (four subscribers HEAR the all-flip)', 'SMOKE-FOUR');
  has(SMOKE, 'the notice flipped the FLEET', 'the fleet smoke claims the same-pid fleet-wide flip', 'SMOKE-FLEET');

  /* 3 — Scenario 2: target=gateway rebinds ONLY the gateway (the negative arm, full fleet). */
  has(SMOKE, 'target=gateway', 'the fleet smoke drives the target=gateway negative arm', 'SMOKE-TARGETED');
  has(SMOKE, 'the target grammar held fleet-wide', 'the fleet smoke claims the negative arm honestly', 'SMOKE-NEGATIVE');

  /* 4 — the smoke ends in its PASS line. */
  has(SMOKE, 'PASS: fleet smoke', 'the smoke ends in its PASS line', 'SMOKE-PASS');

  /* 5 — CI + ATLAS + ledger. */
  has(CI, CI_SMOKE, 'CI runs the fleet smoke', 'CI-SMOKE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1035. D1035\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1035 heading line');

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
    ['the target=all arm was erased from the smoke',
      mutate(real, SMOKE, 'target=all', 'target-erased'), 'SMOKE-ALL'],
    ['the receivers>=4 pin was erased',
      mutate(real, SMOKE, '-ge 4', '-ge 1'), 'SMOKE-FOUR'],
    ['the fleet-flip claim was erased',
      mutate(real, SMOKE, 'the notice flipped the FLEET', 'who knows what happened'), 'SMOKE-FLEET'],
    ['the scenario-2 target=gateway pin was erased',
      mutate(real, SMOKE, 'target=gateway', 'target-gone'), 'SMOKE-TARGETED'],
    ['the fleet-wide negative arm claim was erased',
      mutate(real, SMOKE, 'the target grammar held fleet-wide', 'somehow it works'), 'SMOKE-NEGATIVE'],
    ['the gateway boot line was erased',
      mutate(real, SMOKE, 'NEXUS_GATEWAY_BUS_ENABLED=true', 'NEXUS_GATEWAY_BUS_ENABLED=false'), 'SMOKE-GW-ARM'],
    ['the dispatcher boot line was erased',
      mutate(real, SMOKE, 'NEXUS_BUS_ENABLED=true', 'NEXUS_BUS_ENABLED=false'), 'SMOKE-DISP-ARM'],
    ['the insight boot line was erased',
      mutate(real, SMOKE, 'NEXUS_INSIGHT_BUS_ENABLED=true', 'NEXUS_INSIGHT_BUS_ENABLED=false'), 'SMOKE-INSIGHT-ARM'],
    ['the events boot line was erased',
      mutate(real, SMOKE, 'NEXUS_EVENTS_BUS_ENABLED=true', 'NEXUS_EVENTS_BUS_ENABLED=false'), 'SMOKE-EVENTS-ARM'],
    ['the PASS line was erased',
      mutate(real, SMOKE, 'PASS: fleet smoke', 'PASS-erased'), 'SMOKE-PASS'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'bus_fleet_smoke_erased.sh'), 'CI-SMOKE'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1035_fleet_smoke_erased.mjs'), 'ATLAS-READER'],
    ['ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(44)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(44)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  {
    const p = new Map(real);
    p.set(SMOKE, p.get(SMOKE) + '\n# (a benign trailing comment edit — judged GREEN)\n');
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN            ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
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
  console.log(`\nFALSE D1035 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1035 fleet smoke wiring complete, ${result.notes.length} holds`);
process.exit(0);
