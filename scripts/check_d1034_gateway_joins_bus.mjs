#!/usr/bin/env node
/**
 * NEXUS D1034 — the gateway (the plane's reactive edge) joins the bus, pinned off disk.
 *
 * D1024 armed the dispatcher; D1025 armed insight; D1026 armed events. D1034 arms `nexus-gateway`,
 * the WebFlux edge — the member whose event loop cannot be blocked. The proof is
 * `scripts/bus_gateway_smoke.sh` (two phases, like D1024: Phase 0 409 bus_disabled with the bus off;
 * Phase 1 refresh-v1 → POST → 202 receivers>=1 → same pid refresh-v2).
 *
 * This reader pins:
 *   (a) the gateway carries lettuce (the pub/sub transport) and the D1034 config view (D857 rig);
 *   (b) the yaml defaults the bus OFF; the channel literal is byte-identical to the sidecars';
 *   (c) the subscriber resolves ContextRefresher (the actuator sequence), drops malformed messages,
 *       matches targets exactly after stripping `nexus-`;
 *   (d) the smoke ends in its 202/receivers pin and its same-pid v2 read;
 *   (e) CI runs the smoke and this reader's self-test; ATLAS lists this reader; ledger holds D1034.
 *
 * SELF-TEST: 13 corruption arms + 1 GREEN control — channel literal drifted in the gateway
 * publisher, channel literal drifted in the gateway subscriber, gateway bus defaulted ON,
 * endpoint route renamed, 409 bus_disabled pin erased, actuator engine severed, target grammar
 * loosened, config view erased, the PASS line erased, CI invocation erased, ATLAS row erased,
 * ledger heading erased. Each must redden.
 *
 * Usage:  node scripts/check_d1034_gateway_joins_bus.mjs [--self-test]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const POM = 'services/cloud/gateway/pom.xml';
const YAML = 'services/cloud/gateway/src/main/resources/application.yaml';
const CTRL = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/GatewayBusController.java';
const SUBT = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/GatewayBusRefreshSubscriber.java';
const VIEW = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/GatewayConfigViewController.java';
const SMOKE = 'scripts/bus_gateway_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1034_gateway_joins_bus.mjs';
const PATHS = [POM, YAML, CTRL, SUBT, VIEW, SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1034\. D1034(?=\s|$)/m;
const CI_SMOKE = 'bus_gateway_smoke.sh';
const CHANNEL = 'nexus:bus:refresh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1034 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — the edge carries the pub/sub transport and the D1034 config view (the rig every bus member has). */
  has(POM, '<artifactId>lettuce-core</artifactId>', 'gateway imports the pub/sub transport', 'POM-LETTUCE');
  has(YAML, 'import: optional:configserver:', 'gateway imports the config server', 'YAML-IMPORT');
  has(YAML, 'health,info,gateway,refresh,metrics', 'gateway exposes the refresh door', 'YAML-REFRESH');

  /* 2 — opt-in everywhere, default OFF; the channel literal is shared across ALL four members. */
  has(YAML, 'enabled: ${NEXUS_GATEWAY_BUS_ENABLED:false}', 'gateway yaml defaults the bus to false', 'YAML-BUS-FALSE');
  has(CTRL, `static final String CHANNEL = "${CHANNEL}"`, 'the gateway publisher declares the channel literal', 'CTRL-CHANNEL');
  has(SUBT, `String CHANNEL = "${CHANNEL}"`, 'the gateway subscriber declares the channel literal', 'SUBT-CHANNEL');

  /* 3 — publisher shape on the gateway door. */
  has(CTRL, '@PostMapping("/gateway/bus/refresh")', 'the publisher serves /gateway/bus/refresh', 'CTRL-ROUTE');
  has(CTRL, '"code", "bus_disabled"', 'the publisher refuses with bus_disabled semantics when off', 'CTRL-DISABLED');
  has(CTRL, '.status(202)', 'the publisher answers 202 on publish', 'CTRL-202');
  has(CTRL, '"receivers", receivers', 'the publisher reports the receiver count', 'CTRL-RECEIVERS');

  /* 4 — the receiver: subscribe on boot, ContextRefresher first, exact member match, strict grammar. */
  has(SUBT, '@PostConstruct', 'the subscriber subscribes in @PostConstruct', 'SUBT-POSTCONSTRUCT');
  has(SUBT, 'ContextRefresher.class', 'the subscriber resolves the actuator refresh engine', 'SUBT-CTX');
  has(SUBT, 'contextRefresher.refresh()', 'the subscriber refreshes through the actuator sequence', 'SUBT-REFRESH');
  has(SUBT, '"all".equals(target)', 'the subscriber matches the all-target', 'SUBT-ALL');
  has(SUBT, 'member.equals(target)', 'the subscriber matches only its own member tag', 'SUBT-MEMBER');
  has(SUBT, '[a-z0-9-]{1,64}', 'the target grammar is strict', 'SUBT-GRAMMAR');
  has(SUBT, 'parseTarget', 'the strict target parser exists', 'SUBT-PARSE');

  /* 5 — the config view controller (the D1034 round trip is readable). */
  has(VIEW, '@RefreshScope', 'the config view is @RefreshScope', 'VIEW-SCOPE');
  has(VIEW, '@GetMapping("/gateway/config")', 'the config view serves /gateway/config', 'VIEW-ROUTE');
  has(VIEW, 'nexus.gateway.label', 'the view reads the resolved gateway label', 'VIEW-LABEL');

  /* 6 — the smoke: two phases, the same-pid v2 read, the disabled phase. */
  has(SMOKE, 'NEXUS_GATEWAY_BUS_ENABLED=true', 'the smoke boots phase 1 with the bus armed', 'SMOKE-ARM');
  has(SMOKE, '409 bus_disabled', 'the smoke pins the 409 refusal when the bus is off', 'SMOKE-409');
  has(SMOKE, '"receivers"', 'the smoke pins the 202 receiver count', 'SMOKE-RECEIVERS');
  has(SMOKE, 'the edge rebound, it did not restart', 'the smoke claims the same-pid same-process rebind', 'SMOKE-SAMEPID');
  has(SMOKE, 'PASS: gateway bus smoke', 'the smoke ends in its PASS line', 'SMOKE-PASS');

  /* 7 — CI + ATLAS + ledger. */
  has(CI, CI_SMOKE, 'CI runs the gateway bus smoke', 'CI-SMOKE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1034. D1034\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1034 heading line');

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
    ['the channel literal drifted in the gateway publisher',
      mutate(real, CTRL, `static final String CHANNEL = "${CHANNEL}"`, `static final String CHANNEL = "nexus:bus:refresh-drifted"`), 'CTRL-CHANNEL'],
    ['the channel literal drifted in the gateway subscriber',
      mutate(real, SUBT, `String CHANNEL = "${CHANNEL}"`, `String CHANNEL = "nexus:bus:refresh-drifted"`), 'SUBT-CHANNEL'],
    ['the gateway bus defaulted ON',
      mutate(real, YAML, 'enabled: ${NEXUS_GATEWAY_BUS_ENABLED:false}', 'enabled: ${NEXUS_GATEWAY_BUS_ENABLED:true}'), 'YAML-BUS-FALSE'],
    ['the gateway door route was renamed',
      mutate(real, CTRL, '@PostMapping("/gateway/bus/refresh")', '@PostMapping("/gateway/bus/refresh-erased")'), 'CTRL-ROUTE'],
    ['the 409 refusal pin was erased',
      mutate(real, CTRL, '"code", "bus_disabled"', '"code", "bus_disabled_erased"'), 'CTRL-DISABLED'],
    ['the actuator engine was severed',
      mutate(real, SUBT, 'contextRefresher.refresh()', 'contextRefresher.refreshGONE()'), 'SUBT-REFRESH'],
    ['the target grammar was loosened to any string',
      mutate(real, SUBT, '[a-z0-9-]{1,64}', '[a-z0-9-]*'), 'SUBT-GRAMMAR'],
    ['the config view was erased',
      mutate(real, VIEW, '@GetMapping("/gateway/config")', '@GetMapping("/gateway/config-erased")'), 'VIEW-ROUTE'],
    ['the same-pid same-process claim was erased from the smoke',
      mutate(real, SMOKE, 'the edge rebound, it did not restart', 'who knows what happened'), 'SMOKE-SAMEPID'],
    ['the smoke PASS line was erased',
      mutate(real, SMOKE, 'PASS: gateway bus smoke', 'PASS-erased'), 'SMOKE-PASS'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'bus_gateway_smoke_erased.sh'), 'CI-SMOKE'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1034_gateway_joins_bus_erased.mjs'), 'ATLAS-READER'],
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
    p.set(CTRL, p.get(CTRL) + '\n// (a benign trailing comment edit — judged GREEN)\n');
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
  console.log(`\nFALSE D1034 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1034 gateway-joins-bus wiring complete, ${result.notes.length} holds`);
process.exit(0);
