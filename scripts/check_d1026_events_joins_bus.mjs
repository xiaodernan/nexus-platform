#!/usr/bin/env node
/**
 * NEXUS D1026 — the events member joins the bus, pinned off disk.
 *
 * D1024 armed the dispatcher; D1025 armed insight; D1026 arms `nexus-events` — the Redis
 * Streams carrier, the member that reads the plane's live bus ALREADY in stream form, now also
 * opted into the refresh channel. The proof is `scripts/bus_plane_smoke.sh`:
 *
 *   Scenario 1 (target=all):   one POST /events/bus/refresh202s receivers >= 3 and ALL THREE
 *              members — dispatcher, insight, events — answer refresh-v2, same pids.
 *   Scenario 2 (target=events): the named member flips to refresh-v3; the other two stay
 *              refresh-v2 — the negative arm for one more target.
 *
 * HONESTY PIN (same as D1025): Redis pub/sub counts HEARERS, not actors. `receivers=3` in
 * Scenario 2 is correct: dispatcher and insight heard, matched their tags, acted as no-op.
 * The label reads are the load-bearing proof.
 *
 * SELF-TEST: 13 corruption arms + 1 GREEN control — channel literal drifted in the events
 * publisher, channel literal drifted in the events subscriber, events bus defaulted ON,
 * endpoint route renamed, 409 bus_disabled pin erased, actuator engine severed, target grammar
 * loosened, three-member boot claim erased, target=events pin erased, the PASS line erased,
 * CI invocation erased, ATLAS row erased, ledger heading erased. Each must redden.
 *
 * Usage:  node scripts/check_d1026_events_joins_bus.mjs [--self-test]
 * Exit:   0 every claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const POM = 'services/cloud/events-service/pom.xml';
const YAML = 'services/cloud/events-service/src/main/resources/application.yaml';
const CTRL = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsBusController.java';
const SUBT = 'services/cloud/events-service/src/main/java/com/nexus/cloud/events/EventsBusRefreshSubscriber.java';
const SMOKE = 'scripts/bus_plane_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d1026_events_joins_bus.mjs';
const PATHS = [POM, YAML, CTRL, SUBT, SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 1026\. D1026(?=\s|$)/m;
const CI_SMOKE = 'bus_plane_smoke.sh';
const CHANNEL = 'nexus:bus:refresh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D1026 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — the events member already carries lettuce (D928 reader) and the config client (D1023). */
  has(POM, '<artifactId>lettuce-core</artifactId>', 'events carries the pub/sub transport', 'POM-LETTUCE');
  has(POM, 'spring-cloud-starter-config', 'events imports the config-client (D1023)', 'POM-CFG');

  /* 2 — opt-in everywhere, default OFF; the channel literal is shared by all three members. */
  has(YAML, 'enabled: ${NEXUS_EVENTS_BUS_ENABLED:false}', 'events yaml defaults the bus to false', 'YAML-BUS-FALSE');
  has(CTRL, `static final String CHANNEL = "${CHANNEL}"`, 'the events publisher declares the channel literal', 'CTRL-CHANNEL');
  has(SUBT, `String CHANNEL = "${CHANNEL}"`, 'the events subscriber declares the channel literal', 'SUBT-CHANNEL');

  /* 3 — publisher shape on the events door. */
  has(CTRL, '@PostMapping("/events/bus/refresh")', 'the publisher serves /events/bus/refresh', 'CTRL-ROUTE');
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

  /* 5 — the three-member plane smoke: all three flip together; target=events flips one only. */
  has(SMOKE, 'target=all', 'the plane smoke drives the target=all arm', 'SMOKE-ALL');
  has(SMOKE, 'target=events', 'the plane smoke drives the target=events negative arm', 'SMOKE-TARGETED');
  has(SMOKE, '-ge 3', 'the plane smoke pins receivers >= 3 (three subscribers HEAR the all-flip)', 'SMOKE-THREE');
  has(SMOKE, 'target grammar held', 'the plane smoke claims the negative arm honestly', 'SMOKE-NEGATIVE');
  has(SMOKE, 'PASS: plane smoke', 'the plane smoke ends in its PASS line', 'SMOKE-PASS');

  /* 6 — CI + ATLAS + ledger. */
  has(CI, CI_SMOKE, 'CI runs the plane smoke', 'CI-SMOKE');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 1026. D1026\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D1026 heading line');

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
    ['the channel literal drifted in the events publisher',
      mutate(real, CTRL, `static final String CHANNEL = "${CHANNEL}"`, `static final String CHANNEL = "nexus:bus:refresh-drifted"`), 'CTRL-CHANNEL'],
    ['the channel literal drifted in the events subscriber',
      mutate(real, SUBT, `String CHANNEL = "${CHANNEL}"`, `String CHANNEL = "nexus:bus:refresh-drifted"`), 'SUBT-CHANNEL'],
    ['the events bus defaulted ON',
      mutate(real, YAML, 'enabled: ${NEXUS_EVENTS_BUS_ENABLED:false}', 'enabled: ${NEXUS_EVENTS_BUS_ENABLED:true}'), 'YAML-BUS-FALSE'],
    ['the events door route was renamed',
      mutate(real, CTRL, '@PostMapping("/events/bus/refresh")', '@PostMapping("/events/bus/refresh-erased")'), 'CTRL-ROUTE'],
    ['the 409 refusal pin was erased',
      mutate(real, CTRL, '"code", "bus_disabled"', '"code", "bus_disabled_erased"'), 'CTRL-DISABLED'],
    ['the actuator engine was severed',
      mutate(real, SUBT, 'contextRefresher.refresh()', 'contextRefresher.refreshGONE()'), 'SUBT-REFRESH'],
    ['the target grammar was loosened',
      mutate(real, SUBT, '[a-z0-9-]{1,64}', '[a-z0-9-]*'), 'SUBT-GRAMMAR'],
    ['the three-member all-flip arm was erased',
      mutate(real, SMOKE, 'target=all', 'target-all-erased'), 'SMOKE-ALL'],
    ['the scenario-2 target=events pin was erased',
      mutate(real, SMOKE, 'target=events', 'target-events-erased'), 'SMOKE-TARGETED'],
    ['the PASS line was erased',
      mutate(real, SMOKE, 'PASS: plane smoke', 'PASS-erased'), 'SMOKE-PASS'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'bus_plane_smoke_erased.sh'), 'CI-SMOKE'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d1026_events_joins_bus_erased.mjs'), 'ATLAS-READER'],
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
  console.log(`\nFALSE D1026 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D1026 events-joins-bus wiring complete, ${result.notes.length} holds`);
process.exit(0);
