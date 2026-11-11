#!/usr/bin/env node
/**
 * NEXUS D940 — deterministic cache-TTL decorrelation (thundering-herd guard), and stays WIRED.
 *
 * A batch of keys written with the SAME TTL (TokenRegistry refresh families, a cache backfill, a deploy)
 * expires at the SAME instant, so every miss hits the backing store at once — a self-synchronised stampede.
 * D940 gives KeyValueStore.set() an OPT-IN (default OFF) deterministic TTL offset: base +
 * unsigned_fnv1a64(key) mod spread. The offset is a STABLE function of the key (same key -> same lifetime on
 * every node and after every restart); decorrelation comes from keys DIFFERING, not process randomness.
 * It only ever LENGTHENS the TTL, so no cache entry expires earlier than requested.
 *
 * THIS reader holds the structural claims a live smoke cannot: the FNV constants + the UNSIGNED remainder
 * are really in the source (a signed % shortens ~half of TTLs — a worse defect than the stampede), the
 * golden vector is pinned, the opt-in flag is DEFAULT FALSE, set() keeps the byte-for-byte D909 SETEX path
 * when off and issues ONE atomic PSETEX when on, the fallback stays bounded, and — critically — the D932
 * counter, D937 sliding window and D932 replay-dedup setIfAbsent are NOT polluted by jitter. The positive
 * property (1 bucket -> 16, never shorter) and the FALSIFIER (signed % -> early expiry) live in the two
 * wire smokes and TtlJitterTest, run against live Redis/Maven; this reader starts no Redis and claims no
 * test ran today.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory — FNV prime
 * changed, unsigned -> signed remainder, default flipped TRUE, PSETEX swapped back to unconditional SETEX,
 * golden vector edited, jitter leaked into the D932 counter, a smoke assertion weakened, a CI/census binding
 * cut — and requires EACH to redden while the real plane holds. A seam whose proof can vanish unnoticed is
 * not a seam.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that Redis answered, that a production cache was
 * migrated (jitter is OFF by default), any hit-rate / throughput improvement, or that a real backing-store
 * stampede was measured. No cross-node claim beyond the hash being a pure, portable function of the key.
 *
 * Usage:  node scripts/check_ttl_jitter.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const JITTER = 'services/platform/src/main/java/com/nexus/platform/TtlJitter.java';
const STORE = 'services/platform/src/main/java/com/nexus/platform/KeyValueStore.java';
const YAML = 'services/platform/src/main/resources/application.yml';
const TEST = 'services/platform/src/test/java/com/nexus/platform/TtlJitterTest.java';
const SMOKE = 'scripts/ttl_jitter_smoke.sh';
const FALSIFIER = 'scripts/falsify_ttl_jitter_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_ttl_jitter.mjs';
const PATHS = [JITTER, STORE, YAML, TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the ttl-jitter plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — the FNV constants + the LOAD-BEARING unsigned remainder are really in the source. */
  has(JITTER, 'FNV_OFFSET_BASIS = 0xcbf29ce484222325L', 'the FNV-1a 64 offset basis is pinned');
  has(JITTER, 'FNV_PRIME = 0x100000001b3L', 'the FNV-1a 64 prime is pinned');
  has(JITTER, 'Long.remainderUnsigned(fnv1a64(key), spreadMs)', 'the offset uses the UNSIGNED remainder (signed % would shorten TTLs)');
  has(JITTER, 'return baseTtlMs + offset', 'the result only ever LENGTHENS the TTL');
  has(JITTER, 'if (spreadMs <= 1L) {\n            return baseTtlMs;', 'spread<=1 is the identity (default-off passes 0/1)');
  // The jitterMs body must NOT contain a bare signed remainder — that is the falsifier's planted bug.
  const jm = /public static long jitterMs\(String key, long baseTtlMs, long spreadMs\) \{([\s\S]*?)\n    \}/.exec(t(JITTER));
  if (!jm) offenders.push('MISSING — the jitterMs(String, long, long) body could not be isolated');
  else {
    if (/fnv1a64\(key\)\s*%/.test(jm[1])) offenders.push('STALE — jitterMs() uses a bare signed % (the early-expiry bug)');
    else notes.push('held jitterMs() has NO bare signed remainder');
  }

  /* 2 — the GOLDEN VECTOR is pinned in the unit test (the wire smoke recomputes it from source constants). */
  for (const [key, ttl] of [['nexus:jc:0', '60_583'], ['nexus:jc:1', '60_148'],
                            ['nexus:jc:7', '60_302'], ['nexus:jc:42', '60_267'],
                            ['nexus:refreshfam:demo', '61_020']]) {
    has(TEST, `jitterMs("${key}", BASE, SPREAD)).isEqualTo(${ttl}L`, `golden vector pins ${key} -> ${ttl}ms`);
  }

  /* 3 — opt-in is DEFAULT FALSE, two constructors, Spring chooses the 6-arg primary. */
  has(STORE, '@Value("${nexus.cache.ttl-jitter-enabled:false}") boolean ttlJitterEnabled',
      'the 6-arg primary constructor defaults jitter OFF');
  has(STORE, '@Value("${nexus.cache.ttl-jitter-spread-ms:1024}") long ttlJitterSpreadMs',
      'the spread knob is configured, default 1024ms');
  has(STORE, '@Autowired\n    public KeyValueStore(', 'the multi-constructor store marks a @Autowired primary (no no-arg ambiguity)');
  has(STORE, 'this(redisEnabled, url, timeoutMs, fallbackMaxEntries, false, 1024L);',
      'the 4-arg compatibility constructor delegates with jitter OFF');
  has(STORE, 'public boolean usingTtlJitter()', 'the store exposes whether jitter is active');
  has(YAML, 'ttl-jitter-enabled: ${NEXUS_CACHE_TTL_JITTER_ENABLED:false}', 'application config defaults jitter OFF');
  has(YAML, 'ttl-jitter-spread-ms: ${NEXUS_CACHE_TTL_JITTER_SPREAD_MS:1024}', 'application config sets the spread default');

  /* 4 — set() keeps the D909 SETEX path when off, issues ONE PSETEX when on; fallback uses effectiveTtlMs. */
  const set = /public void set\(String key, String value, Duration ttl\) \{([\s\S]*?)\n    \}\n\n    public boolean setIfAbsent/.exec(t(STORE));
  if (!set) offenders.push('MISSING — the set(String,String,Duration) body could not be isolated');
  else {
    has(STORE, 'redis.psetex(key, effectiveTtlMs(key, ttl), value);', 'the ON branch issues ONE atomic PSETEX');
    has(STORE, 'redis.setex(key, ttl.getSeconds(), value);', 'the OFF branch keeps the D909 SETEX path');
    if (!set[1].includes('if (ttlJitterEnabled)')) offenders.push('MISSING — set() branches on ttlJitterEnabled');
    else notes.push('held set() branches on the opt-in flag');
    if (!set[1].includes('effectiveTtlMs(key, ttl)')) offenders.push('MISSING — set() applies effectiveTtlMs to the fallback');
    else notes.push('held the fallback applies the same decorrelated TTL');
  }
  has(STORE, 'return TtlJitter.jitterMs(key, base, ttlJitterSpreadMs);', 'effectiveTtlMs delegates to the pure jitter function');
  has(STORE, 'sweepExpired', 'the D909 bounded/swept in-memory fallback is preserved');

  /* 4b — CRITICAL: jitter is applied ONLY by set(); the D932/D937/SETNX contracts are UNTOUCHED. */
  for (const sig of [
    'public boolean setIfAbsent(String key, String value, Duration ttl)',
    'public long increment(String key, Duration window)',
    'public long slidingWindow(String key, long windowMs, long nowMs, String member)',
  ]) {
    const body = new RegExp(sig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([\\s\\S]*?)\\n    \\}').exec(t(STORE));
    if (!body) { offenders.push(`MISSING — could not isolate ${sig}`); continue; }
    if (body[1].includes('effectiveTtlMs') || body[1].includes('TtlJitter') || body[1].includes('psetex')) {
      offenders.push(`STALE — ${sig} was polluted by D940 jitter (it keeps its own TTL contract)`);
    } else notes.push(`held ${sig.split('(')[0]} keeps its own TTL contract (no jitter)`);
  }
  has(STORE, 'INCR_AND_EXPIRE_LUA', 'the D932 fixed-window counter is preserved');
  has(STORE, 'SLIDING_WINDOW_LUA', 'the D937 sliding window is preserved');

  /* 5 — the unit-test arms (golden, properties, falsifier, wiring, live). */
  for (const arm of ['goldenVectorPinsBothImplementations', 'offsetIsStableAcrossInstances',
                     'jitterOnlyLengthensAndIsBounded', 'sameTtlBatchDecorrelates',
                     'spreadAtMostOneIsIdentity', 'signedRemainderFalsifierReddened',
                     'defaultStoreKeepsLegacySetex', 'enabledStoreUsesOneAtomicPsetex',
                     'fallbackDecorrelatesAndStaysBounded', 'liveRedisArmsDecorrelatedMillisecondTtl']) {
    has(TEST, `void ${arm}()`, `the ${arm} arm exists`);
  }

  /* 6 — the TWO WIRE-LEVEL Redis smokes: load-bearing assertions + source-extraction. */
  has(SMOKE, 'FNV_OFFSET_BASIS', 'the positive smoke extracts the FNV constant from the source');
  has(SMOKE, 'Long.remainderUnsigned', 'the positive smoke requires the unsigned remainder in the source');
  has(SMOKE, 'golden FNV hash drift', 'the positive smoke cross-checks its Python replica against the golden vector');
  has(SMOKE, '[ "$plain_buckets" -eq 1 ]', 'the positive smoke asserts no-jitter collapses to one bucket');
  has(SMOKE, '[ "$jitter_buckets" -ge 16 ]', 'the positive smoke asserts jitter spreads to >= 16 buckets');
  has(SMOKE, '[ "$shortened" -eq 0 ]', 'the positive smoke asserts NO key expires shorter than base');
  has(SMOKE, '[ "$first_off" = "$again" ]', 'the positive smoke asserts the offset is a stable function of the key');
  has(FALSIFIER, 'Long.remainderUnsigned', 'the falsifier requires the honest unsigned operator to exist before flipping it');
  has(FALSIFIER, 'java_signed_mod', 'the falsifier plants the SIGNED remainder bug');
  has(FALSIFIER, '[ "$shortened" -gt 0 ]', 'the falsifier asserts the signed bug SHORTENS TTLs (early expiry)');
  has(FALSIFIER, '[ "$honest_shortened" -eq 0 ]', 'the falsifier control: the unsigned arm keeps all TTLs >= base');

  /* 7 — wiring into CI, docs, machine census and the ledger (four corners + this ledger). */
  has(CI, 'scripts/ttl_jitter_smoke.sh', 'CI runs the positive wire smoke');
  has(CI, 'scripts/falsify_ttl_jitter_smoke.sh', 'CI runs the wire falsifier');
  has(CI, 'node scripts/check_ttl_jitter.mjs --self-test', 'CI runs this reader (reachability)');
  has(ATLAS, 'scripts/check_ttl_jitter.mjs', 'ATLAS lists this reader');
  has(ATLAS, 'scripts/ttl_jitter_smoke.sh', 'ATLAS lists the positive wire smoke');
  has(ATLAS, 'scripts/falsify_ttl_jitter_smoke.sh', 'ATLAS lists the wire falsifier');
  has(CLOUD, 'check_ttl_jitter.mjs', 'CLOUD.md lists this reader');
  has(CLOUD, 'ttl_jitter_smoke.sh', 'CLOUD.md lists the positive wire smoke');
  has(CLOUD, 'falsify_ttl_jitter_smoke.sh', 'CLOUD.md lists the wire falsifier');
  has(CLOUD, 'D940', 'CLOUD.md records the D940 seam');
  has(CENSUS, '- id: D940', 'the machine census indexes D940');
  has(CENSUS, 'smoke: ttl_jitter_smoke.sh', 'the census binds the positive wire smoke');
  has(CENSUS, 'falsifier: falsify_ttl_jitter_smoke.sh', 'the census binds the wire falsifier');
  has(CENSUS, 'gate: check_ttl_jitter.mjs', 'the census binds this reader as the gate');
  has(CENSUS, 'honesty_anchor: D940', 'D940 binds an exact honesty anchor');
  has(STATUS, '## 940. D940', 'the ledger holds §940');

  return { offenders, notes, unchecked: null, paths: PATHS };
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

if (SELF_TEST) {
  const { files: real, present } = fromDisk();
  const base = judge(real, present);
  if (base.unchecked || base.offenders.length) {
    console.log(`RESULT: NOT CHECKED — the real plane must be clean before self-test (${base.offenders[0] ?? base.unchecked})`);
    process.exit(2);
  }
  const mutate = (path, from, to) => {
    const f = new Map(real);
    const text = f.get(path);
    if (!text.includes(from)) return { skipped: `plant token ${JSON.stringify(from)} absent in ${path}` };
    f.set(path, text.replace(from, to));
    return { files: f };
  };
  const arms = [
    ['FNV prime changed', mutate(JITTER, 'FNV_PRIME = 0x100000001b3L', 'FNV_PRIME = 0x100000001b5L')],
    ['unsigned -> signed remainder', mutate(JITTER, 'Long.remainderUnsigned(fnv1a64(key), spreadMs)',
      'fnv1a64(key) % spreadMs')],
    ['result subtracts offset (shortens)', mutate(JITTER, 'return baseTtlMs + offset;', 'return baseTtlMs - offset;')],
    ['opt-in default flipped TRUE', mutate(STORE,
      '@Value("${nexus.cache.ttl-jitter-enabled:false}") boolean ttlJitterEnabled',
      '@Value("${nexus.cache.ttl-jitter-enabled:true}") boolean ttlJitterEnabled')],
    ['set() unconditional PSETEX (off path lost)', mutate(STORE,
      'redis.setex(key, ttl.getSeconds(), value);', 'redis.psetex(key, effectiveTtlMs(key, ttl), value);')],
    ['golden vector edited', mutate(TEST, 'isEqualTo(60_583L)', 'isEqualTo(60_584L)')],
    ['jitter leaked into D932 increment', mutate(STORE,
      'long v;', 'long v; long j = effectiveTtlMs(key, window);')],
    ['census wire-falsifier unbound', mutate(CENSUS, 'falsifier: falsify_ttl_jitter_smoke.sh', 'falsifier: none')],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(38)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(38)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught}`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
if (REPORT) for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`FALSE TTL-JITTER WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D940 ttl-jitter wired, ${result.notes.length} holds`);
process.exit(0);
