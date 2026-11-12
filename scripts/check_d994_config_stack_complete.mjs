#!/usr/bin/env node
/**
 * NEXUS D994 — a sidecar that DECLARES `optional:configserver:` must also CARRY the client that resolves it.
 *
 * The gateway (D857), the monolith (D872) and insight (D889) import the Config Server AND bring
 * spring-cloud-starter-config; D973's dispatcher-service and D929/D931's events-service both
 * declared the import with NO config-client on the classpath — a dead declaration (the D886
 * pattern: a wiring that reads as promise and resolves as silence). Every config value silently
 * stayed at its local default; /dispatcher/config would have read 'local' forever even with a
 * healthy Config Server. Same root cause family for the dispatcher's failure to EVER boot after
 * D993's RefreshScope seam: two constructors (production + probe seam) and no @Autowired marker,
 * so Spring had no single autowiring candidate and died with `NoSuchMethodException`.
 *
 * This reader + scripts/dispatcher_config_smoke.sh close it:
 *   (a) the smoke boots a throwaway Config Server + the dispatcher and PROVES the
 *       RefreshScope round trip end to end (v1 -> repo rewrite -> POST /actuator/refresh ->
 *       same pid serves v2). It is the load-bearing behavioural gate.
 *   (b) this reader pins off disk: both starters, both import lines, the @Autowired candidate,
 *       the @RefreshScope controller, the smoke's existence + guards, the CI/ATLAS/ledger rows —
 *       the structural wiring the smoke cannot print at rest.
 *   (c) events-service half: the pom starter + the boot line
 *       `ConfigServerConfigDataLoader: Fetching config from server at ...` was observed with
 *       NEITHER change in isolation; this unit ships both halves because both suffered the
 *       same dead import.
 *
 * SELF-TEST: 14 corruptions planted in memory — starter removed (either pom), import line cut,
 * @Autowired marker dropped (two-ctor ambiguity returns), @RefreshScope removed from the
 * controller, actuator exposure losing `refresh`, smoke's cygpath guard erased, smoke's PASS
 * line cut, ci.yml smoke invocation removed, this reader's self-test chain cut, ATLAS row erased,
 * ledger heading erased — requires EACH to redden FOR ITS OWN expect tag (not merely any
 * offender), with a D954 no-op guard so a corruption that leaves the plane unchanged cannot
 * pass. A GREEN control (legitimate comment edit) stays green, and the real plane must hold.
 * The first draft reddened only 8/13 arms: suffix-appending corruptions (`...-erased`) left the
 * pinned substring intact, so `has()` still matched — the arms now replace a character INSIDE
 * each token and the judge requires the matching `[TAG]`, the D992/D993 for-cause discipline.
 *
 * Usage:  node scripts/check_d994_config_stack_complete.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const DISPATCHER_POM = 'services/cloud/dispatcher-service/pom.xml';
const EVENTS_POM = 'services/cloud/events-service/pom.xml';
const DISPATCHER_YAML = 'services/cloud/dispatcher-service/src/main/resources/application.yaml';
const EVENTS_YAML = 'services/cloud/events-service/src/main/resources/application.yaml';
const WORKER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherWorker.java';
const CONTROLLER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherConfigController.java';
const SMOKE = 'scripts/dispatcher_config_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_d994_config_stack_complete.mjs';
const PATHS = [DISPATCHER_POM, EVENTS_POM, DISPATCHER_YAML, EVENTS_YAML, WORKER, CONTROLLER, SMOKE, CI, ATLAS, STATUS, SELF];
const HEADING_RE = /^## 994\. D994(?=\s|$)/m;
const CI_SMOKE = 'dispatcher_config_smoke.sh';

export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the D994 plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — both poms carry the config-client starter; both yamls declare the import. */
  has(DISPATCHER_POM, 'spring-cloud-starter-config', 'dispatcher imports the config-client starter', 'D-POM-CFG');
  has(EVENTS_POM, 'spring-cloud-starter-config', 'events imports the config-client starter', 'E-POM-CFG');
  has(DISPATCHER_YAML, 'optional:configserver:', 'dispatcher declares the configserver import', 'D-YAML-IMPORT');
  has(EVENTS_YAML, 'optional:configserver:', 'events declares the configserver import', 'E-YAML-IMPORT');

  /* 2 — actuator exposure gains refresh (the @RefreshScope rebind door). */
  has(DISPATCHER_YAML, 'refresh', 'dispatcher exposes the refresh endpoint', 'D-YAML-REFRESH');

  /* 3 — ONE autowiring candidate on the worker (probe seam intact). */
  has(WORKER, '@Autowired', '@Autowired marker present', 'WORKER-AUTOWIRED');
  has(WORKER, 'public DispatcherWorker(HookProperties props)', 'the production ctor signature is intact', 'WORKER-CTOR');

  /* 4 — @RefreshScope read-only view, symmetric with insight (D889). */
  has(CONTROLLER, '@RefreshScope', 'the view controller is @RefreshScope', 'CTRL-SCOPE');
  has(CONTROLLER, '@GetMapping("/dispatcher/config")', 'serves /dispatcher/config', 'CTRL-ROUTE');
  has(CONTROLLER, 'nexus.dispatcher.label:local', 'reads the label this process resolved', 'CTRL-LABEL');

  /* 5 — the smoke still proves the round trip (existence, guard, PASS line). */
  has(SMOKE, 'command -v cygpath', 'the throwaway-repo URI is portable (D993 class)', 'SMOKE-PORTABLE');
  has(SMOKE, 'refresh-v1', 'the v1 label is served and asserted', 'SMOKE-V1');
  has(SMOKE, 'refresh-v2', 'the v2 label is served and asserted', 'SMOKE-V2');
  has(SMOKE, '/actuator/refresh', 'the refresh door is POSTed', 'SMOKE-REFRESH');
  has(SMOKE, 'PASS: dispatcher config smoke', 'the smoke ends in its PASS line', 'SMOKE-PASS');
  absent(SMOKE, 'sk-', 'no credential-shaped strings in the smoke', 'SMOKE-NOSECRET');

  /* 6 — wiring: CI runs the smoke AND this reader's self-test, ATLAS lists it, ledger holds the heading. */
  has(CI, CI_SMOKE, 'CI runs the dispatcher config smoke', 'CI-SMOKE');
  has(CI, `${SELF} --self-test`, 'CI runs this reader in the line 171 self-test chain', 'CI-SELFTEST');
  has(ATLAS, SELF, 'ATLAS lists this reader', 'ATLAS-READER');
  if (!HEADING_RE.test(t(STATUS))) {
    offenders.push(`MISSING — docs/STATUS.md: no \`## 994. D994\` heading line${tag('LEDGER-HEADING')}`);
  } else notes.push('held the ledger holds a D994 heading line');

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
    ['dispatcher starter removed',
      mutate(real, DISPATCHER_POM, 'spring-cloud-starter-config', 'spring-cloud-xtarter-config'), 'D-POM-CFG'],
    ['events starter removed',
      mutate(real, EVENTS_POM, 'spring-cloud-starter-config', 'spring-cloud-xtarter-config'), 'E-POM-CFG'],
    ['dispatcher configserver import cut',
      mutate(real, DISPATCHER_YAML, 'optional:configserver:', 'commented-out:onfigserver:'), 'D-YAML-IMPORT'],
    ['actuator exposure lost refresh',
      mutate(real, DISPATCHER_YAML, 'health,info,metrics,refresh', 'health,info,metrics'), 'D-YAML-REFRESH'],
    ['@Autowired candidate dropped (two-ctor ambiguity)',
      mutate(real, WORKER, '@Autowired', '@Nomapped'), 'WORKER-AUTOWIRED'],
    ['@RefreshScope removed from the view',
      mutate(real, CONTROLLER, '@RefreshScope', '@Norefreshcope'), 'CTRL-SCOPE'],
    ['the view route was renamed',
      mutate(real, CONTROLLER, '@GetMapping("/dispatcher/config")', '@GetMapping("/dispatcher/onfig")'), 'CTRL-ROUTE'],
    ['the smoke lost its portable cygpath guard',
      mutate(real, SMOKE, 'command -v cygpath', 'command -v yygpath'), 'SMOKE-PORTABLE'],
    ['the smoke lost its refresh door',
      mutate(real, SMOKE, '/actuator/refresh', '/actuator/efresh'), 'SMOKE-REFRESH'],
    ['the smoke PASS line erased',
      mutate(real, SMOKE, 'PASS: dispatcher config smoke', 'PSSS: dispatcher config smoke'), 'SMOKE-PASS'],
    ['ATLAS row erased',
      mutate(real, ATLAS, SELF, 'scripts/check_d994_config_stack_xrased.mjs'), 'ATLAS-READER'],
    ['CI invocation cut',
      mutate(real, CI, CI_SMOKE, 'dispatcher_config_smoke_xrased.sh'), 'CI-SMOKE'],
    ['CI self-test chain cut',
      mutate(real, CI, `${SELF} --self-test`, `${SELF} --xelf-test`), 'CI-SELFTEST'],
    ['the ledger heading erased', (() => {
      const f = new Map(real);
      f.set(STATUS, (f.get(STATUS) ?? '').split(/\r?\n/).filter((l) => !HEADING_RE.test(l)).join('\n'));
      return { files: f };
    })(), 'LEDGER-HEADING'],
  ];
  const snapshot = (files) => [...files.entries()].map(([k, v]) => `${k}=${v}`).join('\u0000');
  const baseSig = snapshot(real);
  let allReddened = true;
  for (const [label, arm, expectTag] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(48)} SKIP (${arm.skipped})`); allReddened = false; continue; }
    // D954 no-op guard: the arm must actually change the plane, or it proves nothing.
    if (snapshot(arm.files) === baseSig) { console.log(`  self-test  ${label.padEnd(48)} NO-OP (defect!)`); allReddened = false; continue; }
    const out = judge(arm.files, present);
    // D992/D993 discipline: redden for the RIGHT expect tag, not any stray offender.
    const rightCause = out.offenders.some((o) => o.includes(`[${expectTag}]`));
    const redOk = out.offenders.length > 0 && rightCause;
    console.log(`  self-test  ${label.padEnd(48)} ${redOk ? 'red offenders=' + out.offenders.length : 'GREEN/WRONG (defect!)'} expect=[${expectTag}]`);
    if (!redOk) { allReddened = false; for (const o of out.offenders.slice(0, 2)) console.log('      got: ' + o); }
  }
  {
    const p = new Map(real);
    p.set(CONTROLLER, p.get(CONTROLLER).replace('import java.util.Map;', 'import java.util.Map;\n// (comment tweak)'));
    const out = judge(p, present);
    const ok = out.offenders.length === 0;
    console.log(`  self-test  legitimate comment edit stays GREEN                 ${ok ? 'green' : 'RED (defect!)'} offenders=${out.offenders.length}`);
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
  console.log(`\nFALSE D994 WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D994 config-stack wiring complete, ${result.notes.length} holds`);
process.exit(0);
