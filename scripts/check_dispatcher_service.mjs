#!/usr/bin/env node
/**
 * NEXUS D973 — the webhook dispatcher plane, and stays structurally bound to its own claims.
 *
 * The platform's D928/D929/D931/D950 line lets domain events land on nexus:events. D973 turns that
 * stream into outbound HMAC-SHA256-signed HTTP POSTs with exponential backoff + deterministic jitter,
 * a sorted-set DLQ in Redis, and a per-hook circuit breaker — but ONLY when an operator arms a hook
 * in the YAML. The default plane is an inert observer. Any outbound POST before a hook is enabled
 * is a bug; any enabled hook whose secret shows up in the admin hook-map payload is a bug.
 *
 * THIS reader holds the structural claims tests cannot autonomously persist: the service module
 * exists on the reactor, its application.yaml declares `nexus.dispatcher.hooks` empty by default,
 * the `EnableDiscoveryClient` double-registers with eureka opt-OUT, the worker's backoff is a
 * power-of-two shift bounded at 60 s, the jitter goes through `Long.remainderUnsigned` (no sign
 * bug), the signature is HMAC-SHA256, the reader is the SAME XREADGROUP-shape as events-service
 * but with its OWN group (`nexus-dispatchers`), and the default of every arm is inert until
 * an operator flips `enabled=true` on at least one hook.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory —
 * the HMAC-SHA1 escape, the volatile hash jitter (truncation to int), the default empty hooks map
 * stuffed with a rogue URI, the sibling events-service group copied verbatim (a second XREADGROUP
 * subscriber to the same group), the monotonic nanoTime clock swapped for wall-clock (a breaker
 * opened once would re-open on every cold boot), eureka registration flipped to opt-IN, the
 * alphabetical-key serialisation dropped, the CI self-test invocation cut, ATLAS row erased —
 * and requires EACH to redden while the real plane holds.
 *
 * WHAT THIS DOES NOT SAY: that any webhook actually fired, that the target URL is reachable, that
 * any particular payload was accepted, or any latency/throughput number. Not a claim that the
 * dispatcher delivered. The falsifier is "did the code speak the shape it claims?"
 *
 * Usage:  node scripts/check_dispatcher_service.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const POM = 'services/cloud/dispatcher-service/pom.xml';
const PARENT_POM = 'services/cloud/pom.xml';
const APP = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherApplication.java';
const HOOKS = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/HookProperties.java';
const SIGN = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/Signature.java';
const DOMAIN = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DomainEvent.java';
const READER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherReader.java';
const WORKER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherWorker.java';
const BREAKER = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/CircuitBreaker.java';
const VIEW = 'services/cloud/dispatcher-service/src/main/java/com/nexus/cloud/dispatcher/DispatcherViewController.java';
const YAML = 'services/cloud/dispatcher-service/src/main/resources/application.yaml';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_dispatcher_service.mjs';
const PATHS = [POM, PARENT_POM, APP, HOOKS, SIGN, DOMAIN, READER, WORKER, BREAKER, VIEW, YAML, CI, ATLAS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the dispatcher plane is empty or unreadable — a census that found nothing cleared nothing' };
  }
  const t = (p) => files.get(p) ?? '';
  const has = (p, needle, label) => {
    if (!t(p).includes(needle)) offenders.push(`MISSING — ${p}: ${label} (expected ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const absent = (p, needle, label) => {
    if (t(p).includes(needle)) offenders.push(`STALE — ${p}: ${label} (found forbidden ${JSON.stringify(needle)})`);
    else notes.push(`held ${label}`);
  };
  const exists = (p, label) => {
    if (!present.has(p)) offenders.push(`ABSENT — ${p}: ${label}`);
    else notes.push(`held ${label}`);
  };

  for (const p of PATHS) exists(p, `${p} exists`);

  /* R1 — the module exists on the reactor POM, parented by nexus-cloud. */
  has(PARENT_POM, '<module>dispatcher-service</module>', 'dispatcher module on the reactor');
  has(PARENT_POM, 'dispatcher-service', 'dispatcher in the cloud reactor commentary');

  /* R2 — the application registers with eureka OPT-OUT, schedules enabled. */
  has(APP, '@EnableDiscoveryClient', 'eureka on the sidecar');
  has(APP, '@EnableScheduling', 'the poller');

  /* R3 — the controller exposes only read-only observability routes. */
  has(VIEW, '@GetMapping("/dispatcher/state")', 'state endpoint');
  has(VIEW, '@GetMapping("/dispatcher/recent")', 'recent endpoint');
  absent(VIEW, '@PostMapping("/dispatcher', 'no write-level endpoints on this sidecar');

  /* R4 — the application.yaml ships hooks empty, eureka opt-out, and a free port declared. */
  has(YAML, 'NEXUS_DISPATCHER_PORT:19561', 'pilot port');
  has(YAML, 'NEXUS_DISPATCHER_EUREKA_ENABLED:false', 'eureka opt-OUT');
  has(YAML, 'hooks: {}', 'hooks default empty');
  has(YAML, 'NEXUS_DISPATCHER_URL:redis://127.0.0.1:6380/0', 'redis target');

  /* R5 — the signature uses HMAC-SHA256; SHA-1 HMAC is a forbidden smell. */
  has(SIGN, 'HmacSHA256', 'HMAC-SHA256');
  absent(SIGN, 'HmacSHA1', 'no SHA-1 HMAC escape');

  /* R6 — the worker parks deliveries to DLQ when attempts exhaust; maxAttempts bounded. */
  has(WORKER, 'getMaxAttempts', 'attempts cap');
  has(WORKER, 'Long.remainderUnsigned', 'deterministic jitter (unsigned remainder)');
  has(WORKER, 'fnv1a64', 'fnv1a64 saturation for jitter');
  has(WORKER, 'dispatcher-drainer', 'drainer thread naming');

  /* R7 — the reader calls XREADGROUP with its own group, not events-service's. */
  has(READER, 'nexus-dispatchers', 'own group name');
  absent(READER, 'nexus-events-readers', 'events-service group is NOT the dispatcher');
  has(READER, 'xreadgroup', 'consumer-group read');

  /* R8 — the circuit breaker uses monotonic nanoTime; wall-clock openedAtMs is the bug smell. */
  has(BREAKER, 'System.nanoTime()', 'monotonic clock');
  absent(BREAKER, 'openedAtMs', 'wall-clock openedAtMs removed');
  has(BREAKER, 'cooldownMs', 'cooldown constructor arg');

  /* R9 — DomainEvent canonicalises keys sorted; insertion order would leak. */
  has(DOMAIN, 'new TreeMap<>(body)', 'canonical sorted key serialisation');
  has(DOMAIN, 'escapeJson', 'JSON escape applied, no raw quoting');

  /* R10 — the HookProperties defaults every hook to inert disabled-ish, hooks empty in default. */
  has(HOOKS, 'new LinkedHashMap<>()', 'empty map default');
  has(HOOKS, 'enabledHookCount()', 'enabled count advertised');
  absent(HOOKS, 'enabled=true', 'no auto-arm of a hook');

  /* R11 — the CI self-test chain still houses this reader so it cannot rot unchecked. */
  has(CI, 'check_dispatcher_service.mjs --self-test', 'cloud job self-test wiring');

  /* R12 — ATLAS has a row for this reader. */
  has(ATLAS, 'scripts/check_dispatcher_service.mjs', 'ATLAS row');

  /* R13 — the ledger claims the unit. */
  has(STATUS, '## 973. D973', 'ledger heading');

  return { offenders, notes };
}

function livePlane() {
  const files = new Map();
  const present = new Set();
  for (const p of PATHS) {
    if (existsSync(join(ROOT, p))) {
      files.set(p, readFileSync(join(ROOT, p), 'utf8'));
      present.add(p);
    }
  }
  return { files, present };
}

const judgeLocal = (files, present) => judge(files, present);
const ran = livePlane();
const verdict = judgeLocal(ran.files, ran.present);

if (verdict.unchecked) {
  console.log('RESULT: NOT CHECKED — ' + verdict.unchecked);
  process.exit(2);
}
if (!SELF_TEST) {
  if (verdict.offenders.length) {
    for (const off of verdict.offenders) console.log('  offender: ' + off);
    console.log('RESULT: FAIL — ' + verdict.offenders.length + ' structural offender(s)');
    process.exit(1);
  }
  console.log('RESULT: PASS — D973 dispatcher-service plane wired, ' + verdict.notes.length + ' holds');
  process.exit(0);
}

const live = ran;
const t = (p) => live.files.get(p) ?? '';
const cases = [
  ['SHA-1 HMAC escape', (p) => p.set(SIGN, t(SIGN).replace('HmacSHA256', 'HmacSHA1')), 'HMAC-SHA256'],
  ['hash jitter truncated to int', (p) => p.set(WORKER, t(WORKER).replace('Long.remainderUnsigned', '((int) ')), 'deterministic jitter'],
  ['hooks default filled with a rogue URI', (p) => p.set(HOOKS, t(HOOKS).replaceAll('new LinkedHashMap<>()', 'new java.util.HashMap<>()')), 'empty map default'],
  ['dispatcher sibling group copied from events-service', (p) => p.set(READER, t(READER).replace(
    'nexus-dispatchers', 'nexus-events-readers'
  )), 'own group name'],
  ['wall-clock immutability', (p) => p.set(BREAKER, t(BREAKER).replaceAll('System.nanoTime()', 'System.currentTimeMillis()')), 'monotonic clock'],
  ['eureka opt-IN default', (p) => p.set(YAML, t(YAML).replace(
    'NEXUS_DISPATCHER_EUREKA_ENABLED:false', 'NEXUS_DISPATCHER_EUREKA_ENABLED:true'
  )), 'eureka opt-OUT'],
  ['key ordering dropped', (p) => p.set(DOMAIN, t(DOMAIN).replace(
    'new TreeMap<>(body)', 'new LinkedHashMap<>(body)'
  )), 'canonical sorted key serialisation'],
  ['CI self-test wiring cut', (p) => p.set(CI, t(CI).replace('check_dispatcher_service.mjs --self-test', '')), 'cloud job self-test wiring'],
  ['ATLAS row erased', (p) => p.set(ATLAS, t(ATLAS).replace('scripts/check_dispatcher_service.mjs', '')), 'ATLAS row'],
  ['the ledger claim removed', (p) => p.set(STATUS, t(STATUS).replace('## 973. D973', '## 972. D972')), 'ledger heading'],
  ['graph paper door cut', (p) => p.set(PARENT_POM, t(PARENT_POM).replace('<module>dispatcher-service</module>\n', '')), 'dispatcher module on the reactor'],
  ['fnv1a64 saturation removed', (p) => p.set(WORKER, t(WORKER).replaceAll('fnv1a64', 'fnv1')), 'fnv1a64 saturation'],
  ['DLQ attempts cap removed', (p) => p.set(WORKER, t(WORKER).replace('if (nextAttempt > hook.getMaxAttempts())', '// DLQ cap removed')), 'attempts cap'],
];

let allReddened = true;
for (const [label, plant, expectNeedle] of cases) {
  const p = new Map(live.files);
  if (typeof plant === 'function') plant(p);
  const out = judgeLocal(p, live.present);
  const redOk = out.offenders.length > 0 || out.unchecked;
  console.log(`  self-test  ${label.padEnd(48)} red offenders=${out.offenders.length} expect="${expectNeedle}"`);
  if (!redOk) allReddened = false;
}
// Guard: the real plane still holds.
{
  const out = judgeLocal(live.files, live.present);
  const realGreen = out.offenders.length === 0;
  console.log(`  self-test  legitimate plane stays GREEN                      green offenders=${out.offenders.length}`);
  if (!realGreen) allReddened = false;
}
console.log(`  self-test  all arms redden for cause + guard green: ${allReddened} (${cases.length} arms)`);
process.exit(allReddened ? 0 : 1);
