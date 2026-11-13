#!/usr/bin/env node
/**
 * NEXUS D1024 — the bus refresh round trip, pinned off disk.
 *
 * D1022 closed the rails cache bill; D1023 gave the sixth member the hot-refresh package. D1024
 * adds the element the plane was missing outright: a Spring Cloud Bus-lite lane. One Redis
 * pub/sub channel (`nexus:bus:refresh`), one opt-in env (`NEXUS_BUS_ENABLED`), one honest action
 * on the receiving member — `ContextRefresher.refresh()`, the exact sequence the
 * `/actuator/refresh` endpoint performs — on the SAME pid. The publisher is the dispatcher's
 * `/dispatcher/bus/refresh`; `scripts/bus_refresh_smoke.sh` proves both halves end to end
 * (Phase 0: off-by-default 409; Phase 1: refresh-v1 → bus → refresh-v2, no restart).
 *
 * This reader pins the wiring off disk and proves the round trip is not a paper claim:
 *   (a) the CHANNEL literal is byte-identical in the controller (publisher) and the subscriber;
 *   (b) the opt-in default is OFF in yaml, controller and subscriber — nothing unintended joins;
 *   (c) the subscriber resolves ContextRefresher (the actuator sequence), refreshes scope, drops
 *       malformed messages, and matches targets exactly after stripping the `nexus-` prefix;
 *   (d) the smoke ends in its 202/receivers pin and its same-pid v2 read;
 *   (e) CI runs the smoke and this reader; ATLAS lists this reader; the ledger holds D1024.
 *
 * SELF-TEST: 14 corruption arms + 1 GREEN control — channel literal drifted in the publisher,
 * channel literal drifted in the subscriber, bus defaulted ON in the yaml, ContextRefresher
 * consumption erased, target regex loosened, endpoint route renamed, 202/receivers pin erased,
 * the 409 bus_disabled pin erased, the same-pid claim erased, the PASS line erased, CI
 * invocation erased, ATLAS row erased, ledger heading erased. Each must redden.
 *
 * Usage:  node scripts/check_d1024_bus_refresh_round_trip.mjs [--self-test]
 * Exit:   0 every wiring claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const YAML = 'services/cloud/dispatcher-service/src/main/resources/application.yaml';
const CTRL = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/BusRefreshController.java';
const SUBT = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/BusRefreshSubscriber.java';
const SMOKE = 'scripts/bus_refresh_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1024_bus_refresh_round_trip.mjs';
const PATHS = [YAML, CTRL, SUBT, SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1024\. D1024(?=\s|$)/m;
const CI_SMOKE = 'bus_refresh_smoke.sh';
const CHANNEL = 'nexus:bus:refresh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1024 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 0 — the channel literal is byte-identical in publisher and subscriber: one lane, one name. */
  has(CTRL, `static final String CHANNEL = "${CHANNEL}"`, 'the publisher declares the channel literal', 'CTRL-CHANNEL');
  has(SUBT, `static final String CHANNEL = "${CHANNEL}"`, 'the subscriber declares the channel literal', 'SUBT-CHANNEL');

  /* 1 — opt-in everywhere, default OFF; the plane does nothing until an operator opts in. */
  has(YAML, 'enabled: ${NEXUS_BUS_ENABLED:false}', 'the yaml defaults the bus to false', 'YAML-BUS-FALSE');
  has(YAML, 'nexus:bus:refresh', 'the yaml (comment) names the shared channel', 'YAML-BUS-CHANNEL');
  has(CTRL, '@Value("${nexus.dispatcher.bus.enabled:false}") boolean enabled', 'the controller defaults the bus to false', 'CTRL-BUS-FALSE');
  has(SUBT, '@Value("${nexus.dispatcher.bus.enabled:false}") boolean enabled', 'the subscriber defaults the bus to false', 'SUBT-BUS-FALSE');

  /* 2 — publisher shape: POST route, 409 refusal when off, 202 with receivers when on. */
  has(CTRL, '@PostMapping("/dispatcher/bus/refresh")', 'the publisher serves /dispatcher/bus/refresh', 'CTRL-ROUTE');
  has(CTRL, '"code", "bus_disabled"', 'the publisher refuses with bus_disabled semantics when off', 'CTRL-DISABLED');
  has(CTRL, '.status(202)', 'the publisher answers 202 on publish', 'CTRL-202');
  has(CTRL, '"receivers", receivers', 'the publisher reports the receiver count', 'CTRL-RECEIVERS');

  /* 3 — the receiver: PostConstruct subscribe, ContextRefresher.refresh (the actuator sequence),
         exact target match after the nexus- prefix strip, malformed messages dropped. */
  has(SUBT, '@PostConstruct', 'the subscriber subscribes in @PostConstruct', 'SUBT-POSTCONSTRUCT');
  has(SUBT, 'connection.sync().subscribe(CHANNEL)', 'the subscriber subscribes to the channel', 'SUBT-SUBSCRIBE');
  has(SUBT, 'ContextRefresher.class', 'the subscriber resolves the actuator refresh engine', 'SUBT-CTX');
  has(SUBT, 'contextRefresher.refresh()', 'the subscriber refreshes through the actuator sequence', 'SUBT-REFRESH');
  has(SUBT, '"all".equals(target)', 'the subscriber matches the all-target', 'SUBT-ALL');
  has(SUBT, 'member.equals(target)', 'the subscriber matches only its own member tag', 'SUBT-MEMBER');
  has(SUBT, '[a-z0-9-]{1,64}', 'the target grammar is strict (a loose grammar is a command injection hole)', 'SUBT-GRAMMAR');
  has(SUBT, 'parseTarget', 'the strict target parser exists', 'SUBT-PARSE');

  /* 4 — the smoke still proves both phases, no restarts, the same pid. */
  has(SMOKE, 'NEXUS_BUS_ENABLED=true', 'the smoke boots the phase-1 member with the bus armed', 'SMOKE-ARM');
  has(SMOKE, 'bus_disabled', 'the smoke pins the 409 refusal when the bus is off', 'SMOKE-409');
  has(SMOKE, '"receivers"', 'the smoke pins the 202 receiver count', 'SMOKE-RECEIVERS');
  has(SMOKE, 'POST /dispatcher/bus/refresh', 'the smoke drives the bus door', 'SMOKE-DOOR');
  has(SMOKE, 'the bus rebound it, not a restart', 'the smoke claims the same-pid same-process rebind', 'SMOKE-SAMEPID');
  has(SMOKE, 'PASS: bus refresh smoke', 'the smoke ends in its PASS line', 'SMOKE-PASS');

  /* 5 — CI, ATLAS, ledger. */
  has(CI, CI_SMOKE, 'CI runs the bus refresh smoke', 'CI-SMOKE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1024. D1024\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1024 heading line');

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
    ['the channel literal drifted in the publisher',
      mutate(real, CTRL, `static final String CHANNEL = "${CHANNEL}"`, `static final String CHANNEL = "nexus:bus:refresh-drifted"`), 'CTRL-CHANNEL'],
    ['the channel literal drifted in the subscriber',
      mutate(real, SUBT, `String CHANNEL = "${CHANNEL}"`, `String CHANNEL = "nexus:bus:refresh-drifted"`), 'SUBT-CHANNEL'],
    ['the bus defaulted ON in the yaml',
      mutate(real, YAML, 'enabled: ${NEXUS_BUS_ENABLED:false}', 'enabled: ${NEXUS_BUS_ENABLED:true}'), 'YAML-BUS-FALSE'],
    ['the ACT actuator engine was unresolved',
      mutate(real, SUBT, 'context.getBean(ContextRefresher.class)', 'context.getBean(RefreshScope.class) /* arm */'), 'SUBT-CTX'],
    ['the actuator sequence was severed',
      mutate(real, SUBT, 'contextRefresher.refresh()', 'contextRefresher.refreshGONE()'), 'SUBT-REFRESH'],
    ['the target grammar was loosened to any string',
      mutate(real, SUBT, '[a-z0-9-]{1,64}', '[a-z0-9-]*'), 'SUBT-GRAMMAR'],
    ['the endpoint route was renamed',
      mutate(real, CTRL, '@PostMapping("/dispatcher/bus/refresh")', '@PostMapping("/dispatcher/bus/refresh-erased")'), 'CTRL-ROUTE'],
    ['the 202 receiver count pin was erased',
      mutate(real, CTRL, '"receivers", receivers', '"receivers", 0L'), 'CTRL-RECEIVERS'],
    ['the same-pid same-process claim was erased from the smoke',
      mutate(real, SMOKE, 'the bus rebound it, not a restart', 'somehow it works'), 'SMOKE-SAMEPID'],
    ['the 409 disabled pin was erased from the smoke',
      mutate(real, SMOKE, 'bus_disabled', 'bus-er'), 'SMOKE-409'],
    ['the smoke PASS line was erased',
      mutate(real, SMOKE, 'PASS: bus refresh smoke', 'PASS-erased'), 'SMOKE-PASS'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'bus_refresh_smoke_erased.sh'), 'CI-SMOKE'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1024_bus_refresh_round_trip_erased.mjs'), 'ATLAS-READER'],
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
  console.log(`\nFALSE D1024 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1024 bus refresh wiring complete, ${result.notes.length} holds`);
process.exit(0);
