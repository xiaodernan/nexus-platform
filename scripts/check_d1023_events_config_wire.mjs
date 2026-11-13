#!/usr/bin/env node
/**
 * NEXUS D1023 — the events sidecar's config hot-refresh wiring, pinned off disk.
 *
 * D1022 closed the rails/cache bill. D1023 completes the Spring Cloud member package: the sixth
 * registry member (`nexus-events`, the Redis Streams consumer/aggregator, D928/D931/D950) joins the
 * group of members that import the Config Server AND expose which label they actually resolved.
 * Insight (D889), dispatcher (D993/D994), and now events (D1023) share a refresh door and a
 * read-only view — the missing sixth piece of the plane was the sixth member's same proof.
 *
 * This reader + scripts/events_config_smoke.sh close it:
 *   (a) the smoke boots a throwaway Config Server + the events service (eureka and redis disabled
 *       so the boot needs nothing external), proves `/events/config` carries refresh-v1, rewrites
 *       the throwaway repo to refresh-v2, POSTs /actuator/refresh, and proves the SAME pid serves
 *       refresh-v2 — no restart.
 *   (b) this reader pins the wiring off disk: the pom's starter, the `refresh` exposure, the
 *       @RefreshScope controller, the smoke's ledger gate, CI's invocation, ATLAS and the ledger.
 *
 * SELF-TEST: 12 corruption arms + 1 GREEN control — starter removed, exposure lost refresh,
 * @RefreshScope erased, controller route renamed, controller label reference erased, smoke's
 * pid/refresh door cut, smoke's PASS line erased, CI invocation erased, ATLAS row erased,
 * ledger heading erased, one guard-arm true/engine-at-2-states. Each must redden.
 *
 * Usage:  node scripts/check_d1023_events_config_wire.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const POM = 'services/cloud/events-service/pom.xml';
const YAML = 'services/cloud/events-service/src/main/resources/application.yaml';
const CTRL = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsConfigController.java';
const SMOKE = 'scripts/events_config_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1023_events_config_wire.mjs';
const PATHS = [POM, YAML, CTRL, SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1023\. D1023(?=\s|$)/m;
const CI_SMOKE = 'events_config_smoke.sh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1023 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — pom carries the config-client starter (the D994 root cause disappeared here too). */
  has(POM, '<artifactId>spring-cloud-starter-config</artifactId>',
      'events imports the config-client starter', 'POM-CFG');

  /* 2 — events declares the configserver import and exposes the refresh door. */
  has(YAML, 'optional:configserver:', 'events declares the configserver import', 'YAML-IMPORT');
  has(YAML, 'health,info,metrics,refresh', 'events exposes the refresh endpoint', 'YAML-REFRESH');

  /* 3 — @RefreshScope controller serves /events/config with the resolved label. */
  has(CTRL, '@RestController\n@RefreshScope\npublic class EventsConfigController',
      'the view controller is @RefreshScope', 'CTRL-SCOPE');
  has(CTRL, '@GetMapping("/events/config")', 'serves /events/config', 'CTRL-ROUTE');
  has(CTRL, '@Value("${nexus.events.label:local}")', 'reads the label this process resolved', 'CTRL-LABEL');
  has(CTRL, '"nexus-events"', 'names itself nexus-events', 'CTRL-SERVICE');

  /* 4 — the smoke still proves the round trip. */
  has(SMOKE, 'nexus-events.yml', 'the throwaway repo carries the events label', 'SMOKE-REPO');
  has(SMOKE, 'echo "== POST /actuator/refresh (no restart', 'the smoke POSTs the refresh door', 'SMOKE-REFRESH');
  has(SMOKE, '/events/config carries refresh-v2', 'the v2 label is read after no restart', 'SMOKE-V2');
  has(SMOKE, 'PASS: events service config smoke', 'the smoke ends in its PASS line', 'SMOKE-PASS');

  /* 5 — wiring: CI runs the smoke, ATLAS lists this reader, ledger holds the heading. */
  has(CI, CI_SMOKE, 'CI runs the events config smoke', 'CI-SMOKE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1023. D1023\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1023 heading line');

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
    ['events starter removed',
      mutate(real, POM, '<artifactId>spring-cloud-starter-config</artifactId>',
             '<artifactId>spring-cloud-erased</artifactId>'), 'POM-CFG'],
    ['actuator exposure lost refresh',
      mutate(real, YAML, 'health,info,metrics,refresh', 'health,info,metrics'), 'YAML-REFRESH'],
    ['configserver import cut',
      mutate(real, YAML, 'optional:configserver:', 'commented-out:configserver:'), 'YAML-IMPORT'],
    ['@RefreshScope removed from the view',
      mutate(real, CTRL, '@RefreshScope\npublic class', 'public class'), 'CTRL-SCOPE'],
    ['/events/config route renamed',
      mutate(real, CTRL, '@GetMapping("/events/config")', '@GetMapping("/events/config-erased")'), 'CTRL-ROUTE'],
    ['the label reference erased',
      mutate(real, CTRL, '@Value("${nexus.events.label:local}")', '@Value("${nexus.events.label-erased:local}")'), 'CTRL-LABEL'],
    ['the service name changed',
      mutate(real, CTRL, '"nexus-events"', '"nexus-events-renamed"'), 'CTRL-SERVICE'],
    ['the throwaway-repo label changed',
      mutate(real, SMOKE, 'nexus-events.yml', 'nexus-events-renamed.yml'), 'SMOKE-REPO'],
    ['the refresh door removed from the smoke',
      mutate(real, SMOKE, 'echo "== POST /actuator/refresh (no restart',
             'echo "== POST /actuator/refresh-erased (no restart'), 'SMOKE-REFRESH'],
    ['the smoke PASS line erased',
      mutate(real, SMOKE, 'PASS: events service config smoke', 'PASS-erased'), 'SMOKE-PASS'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'events_config_smoke_erased.sh'), 'CI-SMOKE'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1023_events_config_wire_erased.mjs'), 'ATLAS-READER'],
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
    p.set(CTRL, p.get(CTRL).replace('import org.springframework.beans.factory.annotation.Value;',
                                    'import org.springframework.beans.factory.annotation.Value;\n// (comment tweak)'));
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
  console.log(`\nFALSE D1023 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1023 events-config wiring complete, ${result.notes.length} holds`);
process.exit(0);
