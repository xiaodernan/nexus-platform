#!/usr/bin/env node
/**
 * NEXUS D897 (Phase G / G3) — the wiring reader for gateway registry FAILOVER.
 *
 * D894 proved two Eureka SERVERS replicate registrations; no client was ever pointed at both.
 * `scripts/cloud_ha_failover_smoke.sh` now gives the gateway both URLs, kills the primary while
 * the registry cache has NEVER held NEXUS-PLATFORM, and only then registers the upstream with
 * the SECONDARY — so a 200 answer can only come from a real client failover, not stale memory.
 * `scripts/falsify_cloud_ha_failover_smoke.sh` removes the second URL and requires the same
 * assertion to redden. THIS reader guards the parts that could silently disappear: the empty-cache
 * baseline, the kill, the late registration, the honest failure message, the falsifier's red
 * requirement, the CI/ATLAS/ledger wiring, and CLOUD.md's "NOT SHIPPED" honesty clause.
 *
 * WHAT THIS DOES NOT SAY: that the pair is deployed, that a gateway is running, that failover is
 * fast, or that the smoke ran today. Runtime belongs to the two live arms.
 *
 * SELF-TEST: `judge` is pure over (path -> text); `--self-test` plants corruptions in memory and
 * requires EACH to redden, plus an empty plane to be refused and the real plane to hold.
 *
 * Exit: 0 every wiring claim holds · 1 an offender.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const HA_SMOKE = 'scripts/eureka_ha_smoke.sh';
const FIXTURE = 'scripts/fixture_insight_upstream.py';
const SMOKE = 'scripts/cloud_ha_failover_smoke.sh';
const FALSIFIER = 'scripts/falsify_cloud_ha_failover_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD_DOC = 'docs/CLOUD.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_cloud_ha_failover.mjs';

const FILES = [HA_SMOKE, FIXTURE, SMOKE, FALSIFIER, CI, ATLAS, CLOUD_DOC, STATUS, SELF];

function judge(plane) {
  const offenders = [];
  const notes = [];
  const text = (rel) => plane.get(rel) ?? '';
  const has = (rel, needle, label) => {
    const t = text(rel);
    if (!t) offenders.push(`UNREADABLE — ${rel} (${label})`);
    else if (!t.includes(needle)) offenders.push(`MISSING — ${rel}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };

  for (const rel of FILES) {
    if (!existsSync(join(ROOT, rel))) offenders.push(`ABSENT — ${rel}`);
    else notes.push(`held ${rel} exists`);
  }

  /* The anti-cache design: empty registries at boot, primary killed, upstream registered LATE. */
  has(SMOKE, 'clean baseline: NEITHER registry may know the upstream yet',
    'the smoke asserts both registries start empty of the upstream');
  has(SMOKE, 'probe_absent', 'the empty-registry baseline is a real JSON probe');
  has(SMOKE, 'kill "$NODE1_PID"', 'the smoke really kills the primary eureka process');
  has(SMOKE, 'primary node is down', 'the smoke proves the primary stopped answering');
  has(SMOKE, 'ONLY NOW register the upstream with the SECONDARY node',
    'the upstream is registered only AFTER the primary dies');
  has(SMOKE, 'INSIGHT_FIXTURE_EUREKA="http://127.0.0.2:$P2/eureka/"',
    'the upstream registers with the SECONDARY, not the dead primary');
  has(SMOKE, 'secondary node lists $APP UP',
    'the smoke proves the surviving registry holds the upstream (emitted from the APP variable)');
  has(SMOKE, 'probe_fixture_answer', 'the 200 answer must be the fixture\'s own body, not a fallback');
  has(SMOKE, "grep -qF 'SERVE /api/v1/health'", 'the fixture access log must prove the request arrived');
  has(SMOKE, 'lb://NEXUS-PLATFORM (cloud profile did not take)',
    'the route table must really resolve by name');
  has(SMOKE, '--spring.profiles.active=cloud', 'the gateway uses the lb:// cloud profile');
  has(SMOKE, '--eureka.client.registry-fetch-interval-seconds=3',
    'the discovery refresh interval is shortened for this throwaway process');
  has(SMOKE, '--resilience4j.circuitbreaker.instances.platform.minimumNumberOfCalls=100',
    'the breaker is explicitly isolated so a discovery delay cannot be misread as a trip');
  has(SMOKE, 'no lb://NEXUS-PLATFORM answer after the primary died',
    'the failure message names the missing failover');
  has(SMOKE, 'NEXUS_HA_FAILOVER_SINGLE', 'the smoke has a switch for the falsifier arm');
  has(SMOKE, 'http://127.0.0.1:$P1/eureka/,http://127.0.0.2:$P2/eureka/',
    'the gateway is given BOTH registry URLs');
  has(SMOKE, 'scripts/fixture_insight_upstream.py', 'the smoke reuses D887\'s self-registering fixture');
  has(HA_SMOKE, '--eureka.client.availability-zones.nexus=',
    'the pair still uses D894\'s explicit zone wiring');

  /* The falsifier removes the SECOND URL and requires the unchanged assertion to redden. */
  has(FALSIFIER, 'NEXUS_HA_FAILOVER_SINGLE=1', 'the falsifier removes the second registry URL');
  has(FALSIFIER, '[ "$rc" -ne 0 ]', 'the falsifier requires the smoke to exit non-zero');
  has(FALSIFIER, 'secondary node lists NEXUS-PLATFORM UP',
    'the falsifier proves the surviving registry really holds the upstream');
  has(FALSIFIER, 'no lb://NEXUS-PLATFORM answer after the primary died',
    'the falsifier attributes the red to the missing resolution');
  has(FALSIFIER, 'a failover smoke green with one registry proves nothing',
    'the falsifier states why a green single-registry run would be worthless');

  /* A claim needs a runner, a map entry, a ledger section and an unchanged honesty boundary. */
  has(CI, 'scripts/cloud_ha_failover_smoke.sh', 'CI runs the failover smoke');
  has(CI, 'scripts/falsify_cloud_ha_failover_smoke.sh', 'CI runs the single-registry falsifier');
  has(CI, 'scripts/check_cloud_ha_failover.mjs', 'CI runs this reader');
  has(ATLAS, 'scripts/cloud_ha_failover_smoke.sh', 'the atlas lists the smoke');
  has(ATLAS, 'scripts/falsify_cloud_ha_failover_smoke.sh', 'the atlas lists the falsifier');
  has(ATLAS, 'scripts/check_cloud_ha_failover.mjs', 'the atlas lists this reader');
  has(CLOUD_DOC, 'D897', 'CLOUD.md names the unit');
  has(CLOUD_DOC, 'HA is PROVEN IN AN EXPERIMENT, NOT SHIPPED',
    'CLOUD.md keeps the honesty boundary: the deployed plane still boots ONE node');
  has(STATUS, '## 897.', 'the ledger has a numbered D897 section');
  has(SELF, '--self-test', 'this reader has a falsifiable self-test');

  return { offenders, notes };
}

function realPlane() {
  const plane = new Map();
  for (const rel of FILES) {
    try { plane.set(rel, readFileSync(join(ROOT, rel), 'utf8')); } catch { plane.set(rel, ''); }
  }
  return plane;
}

const selfTest = process.argv.includes('--self-test');
if (selfTest) {
  const live = judge(realPlane());
  const cases = [
    ['empty-cache baseline erased', (p) => p.set(SMOKE, p.get(SMOKE).replace('clean baseline: NEITHER registry may know the upstream yet', 'startup'))],
    ['kill step erased', (p) => p.set(SMOKE, p.get(SMOKE).replace('kill "$NODE1_PID"', 'echo "kill removed"'))],
    ['late registration moved to the primary', (p) => p.set(SMOKE, p.get(SMOKE).replace('INSIGHT_FIXTURE_EUREKA="http://127.0.0.2:$P2/eureka/"', 'INSIGHT_FIXTURE_EUREKA="http://127.0.0.1:$P1/eureka/"'))],
    ['both-URL wiring reduced to one', (p) => p.set(SMOKE, p.get(SMOKE).replace('http://127.0.0.1:$P1/eureka/,http://127.0.0.2:$P2/eureka/', 'http://127.0.0.1:$P1/eureka/'))],
    ['falsifier no longer requires red', (p) => p.set(FALSIFIER, p.get(FALSIFIER).replace('[ "$rc" -ne 0 ]', '[ "$rc" -eq 0 ]'))],
    ['CI smoke step dropped', (p) => p.set(CI, p.get(CI).replaceAll('scripts/cloud_ha_failover_smoke.sh', 'scripts/retired_smoke.sh'))],
    ['atlas reader entry dropped', (p) => p.set(ATLAS, p.get(ATLAS).replaceAll('scripts/check_cloud_ha_failover.mjs', 'scripts/retired_reader.mjs'))],
    ['CLOUD.md HA honesty clause deleted', (p) => p.set(CLOUD_DOC, p.get(CLOUD_DOC).replace('HA is PROVEN IN AN EXPERIMENT, NOT SHIPPED', 'HA SHIPPED EVERYWHERE'))],
    ['ledger section deleted', (p) => p.set(STATUS, p.get(STATUS).replace('## 897.', '## 000.'))],
  ];
  let allCaught = true;
  for (const [label, corrupt] of cases) {
    const plane = realPlane();
    corrupt(plane);
    const caught = judge(plane).offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(42)} caught: ${caught}`);
    if (!caught) allCaught = false;
  }
  const emptyCaught = judge(new Map()).offenders.length > 0;
  console.log(`  self-test  ${'empty scripts plane refused'.padEnd(42)} caught: ${emptyCaught}`);
  console.log(`  self-test  real plane offenders: ${live.offenders.length}`);
  const ok = allCaught && emptyCaught && live.offenders.length === 0 && live.notes.length > 20;
  console.log(ok
    ? '\nRESULT: PASS — every planted corruption reddens and the real plane holds'
    : '\nRESULT: FAIL — a corruption was not caught, or the real plane is red');
  if (live.offenders.length) for (const o of live.offenders) console.log(`  - ${o}`);
  process.exit(ok ? 0 : 1);
}

const { offenders, notes } = judge(realPlane());
if (offenders.length) {
  console.log('CLOUD HA FAILOVER WIRING — FAIL');
  for (const o of offenders) console.log(`  - ${o}`);
  console.log(`${offenders.length} offender(s), ${notes.length} claim(s) held`);
  process.exit(1);
}
console.log('CLOUD HA FAILOVER WIRING — PASS');
console.log(`${notes.length} claim(s) held`);
console.log('\nWHAT THIS DOES NOT SAY: the pair is deployed, a gateway is running, or the smoke ran today.');
process.exit(0);
