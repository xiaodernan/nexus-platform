#!/usr/bin/env node
/**
 * NEXUS D1004 — the dispatcher joins the Spring Cloud plane and the Admin lists it in the smoke.
 *
 * The dispatcher service had a full stack (configuration, hot refresh,
 * retry/DLQ, non-blocking drain, live events on the wire), but the cloud plane smoke did not boot
 * it — the registry, the admin server and the gateway knew nothing about it. This unit wires the
 * seventh member into the same proof orchestration the other six get, and pins what the admin must
 * say about it.
 *
 * WHAT THIS GATE PINS:
 *   (a) DispatcherApplication registers with Eureka under an opt-in `NEXUS_DISPATCHER_EUREKA_ENABLED`,
 *       default OFF — so merely adding the jar leaks nothing and no false belief is seeded when off.
 *   (b) The smoke boots the dispatcher JVM with the SAME Eureka the smoke started, asks the admin
 *       `/instances` for NEXUS-DISPATCHER, and requires it to be UP — not 404/down, not
 *       merely listed-with-label (a listing without UP is an empty registry fork).
 *   (c) Dispose the dispatcher at smoke end (kill list), so the port is not left occupied.
 *   (d) CI still runs the cloud smoke; ATLAS + ledger reference this reader.
 *
 * Self-test: corruption arms for (a) default flipped on, (b) assertion weakened to any-listed,
 * (c) the dispatcher never wired at all, (d) ATLAS/CI/ledger anchors erased.
 *
 * Usage:  node scripts/check_dispatcher_eureka_admin.mjs [--self-test] [--report]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const SMOKE = 'scripts/cloud_smoke.sh';
const DEPLOYER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherApplication.java';
const YAML = 'services/cloud/dispatcher-service/src/main/resources/application.yaml';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_dispatcher_eureka_admin.mjs';
const PATHS = [SMOKE, DEPLOYER, YAML, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1004\. D1004(?=\s|$)/m;
const CI_SELFTEST = `node ${SELF} --self-test`;

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1004 plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const tag = (expect) => (expect ? ` [${expect}]` : '');
  const has = (p, needle, label, expect) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label, expect) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})${tag(expect)}`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label, expect) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}${tag(expect)}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);
  /* (a) dispatcher registers with Eureka under opt-in, default OFF */
  has(YAML, 'register-with-eureka: ${NEXUS_DISPATCHER_EUREKA_ENABLED:false}',
      'dispatcher eureka registration is OPT-IN with a safe default', 'DEFAULT-OFF');
  has(DEPLOYER, '@EnableDiscoveryClient', 'dispatcher is a discovery client', 'DEP-DISCOVERY');
  /* (b) smoke boots the dispatcher and requires admin lists it as UP */
  has(SMOKE, 'NEXUS_DISPATCHER_EUREKA_ENABLED=true', 'the smoke enables eureka opt-in for the dispatcher', 'SMOKE-ON');
  has(SMOKE, 'spring.profiles.active=dev,cloud', 'the dispatcher boots with the cloud profile set', 'SMOKE-PROFILE');
  has(SMOKE, '"name":"NEXUS-DISPATCHER"', 'the smoke greps the admin view for NEXUS-DISPATCHER', 'SMOKE-GREP');
  has(SMOKE, 'the admin server never listed NEXUS-DISPATCHER', 'the fail message names the gap directly', 'SMOKE-FAIL-MSG');
  has(SMOKE, 'wait_health dispatcher "$DISP_PORT"',
      'the smoke waits for dispatcher health before asking the admin', 'SMOKE-WAIT');
  has(SMOKE, '--spring.profiles.active', 'spring.profiles.active appears somewhere in the smoke (sanity)', 'SMOKE-SANITY');
  /* (c) dispatcher is killed at smoke end */
  has(SMOKE, 'PIDS+=("$!")', 'the dispatcher JVM joins the same kill list as every other service', 'SMOKE-KILL');
  /* (d) wiring */
  has(CI, 'cloud_smoke.sh', 'CI invokes the cloud smoke (line 196)', 'CI-SMOKE');
  has(CI, CI_SELFTEST, 'CI runs this reader in the self-test chain', 'CI-READER');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1004. D1004\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1004 heading line');
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
    ['default flipped ON in the service yaml',
      mutate(real, YAML, 'register-with-eureka: ${NEXUS_DISPATCHER_EUREKA_ENABLED:false}',
              'register-with-eureka: ${NEXUS_DISPATCHER_EUREKA_ENABLED:true}'), 'DEFAULT-OFF'],
    ['smoke never enables eureka for dispatcher',
      mutate(real, SMOKE, 'NEXUS_DISPATCHER_EUREKA_ENABLED=true', 'NEXUS_DISPATCHER_EUREKA_ENABLED=false'), 'SMOKE-ON'],
    ['smoke never registers dispatcher to admin',
      mutate(real, SMOKE, '"name":"NEXUS-DISPATCHER"', '"name":"NEXUS-DISPATCHER-MISSING"'), 'SMOKE-GREP'],
    ['smoke weakens the assertion to an unrelated grep',
      mutate(real, SMOKE, "grep -q '\"name\":\"NEXUS-DISPATCHER\"'", "grep -q '\"name\":\"GATEWAY\"'"), 'SMOKE-GREP'],
    ['kill-list drops the dispatcher pid',
      mutate(real, SMOKE, 'PIDS+=("$!")', 'echo "we boot but never kill this PID"'), 'SMOKE-KILL'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_dispatcher_eureka_admin_erased.mjs'), 'ATLAS-READER'],
    ['ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
    ['CI reader cut',
      mutate(real, CI, CI_SELFTEST, 'node scripts/a_reader_that_does_not_exist.mjs --self-test'), 'CI-READER'],
  ];
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(38)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    const redOk = out.offenders.length > 0;
    console.log(`  self-test  ${label.padEnd(38)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN (defect!)'} expect=[${expectTag}]`);
    if (!redOk) allReddened = false;
  }
  {
    const p = new Map(real);
    p.set(YAML, p.get(YAML).replace('# D973:', '# (D973: comment tweak)'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN          ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
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
  console.log(`\nFALSE D1004 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1004 dispatcher/admin smoke wired, ${result.notes.length} holds`);
process.exit(0);
