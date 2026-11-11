#!/usr/bin/env node
/**
 * NEXUS D932 — the Redis fixed-window limit counter is INCR+EXPIRE in ONE atomic script.
 *
 * The Redis fast path of {@code KeyValueStore.increment} used to send {@code INCR} and (only on the
 * first hit) a SEPARATE {@code EXPIRE}. Two round trips with a crash/fault window between them: a
 * counter that exists with NO ttl never resets, so every later request from that principal is a
 * permanent 429 — a self-inflicted lockout. The in-memory fallback never had the hole (value+expiry
 * under one monitor); only the Redis path a deployment opts into did. D932 replaces both commands with
 * one Lua {@code EVAL} whose body holds the INCR and the conditional EXPIRE together, so Redis's
 * single-threaded script execution makes "counter without expiry" unreachable.
 *
 * THIS reader holds the structural claims a live smoke cannot: the script body really contains BOTH
 * commands (a script with EXPIRE deleted is not atomic), the increment path really calls {@code eval}
 * with an INTEGER output, and the two-command shape is GONE from the increment path (a comment about
 * it is not a fix). The positive property (a real Redis leaves TTL > 0, count climbs, window does not
 * re-arm) and the FALSIFIER (a separate incr+expire with EXPIRE throwing reproduces the TTL-less key,
 * while the eval path never calls the standalone expire) live in KeyValueStoreAtomicityTest and are
 * run by Maven, CI and a live Redis — this reader does not start Redis and claims no test ran.
 *
 * The two WIRE-LEVEL Redis smokes are guarded here too, at D931 parity: the positive smoke really
 * evals the SOURCE-extracted Lua on a live Redis (first write arms a ttl, the next INCR counts without
 * re-arming), and the falsifier reproduces the TTL-less lockout on the legacy split. Their existence,
 * load-bearing assertions and CI/ATLAS/CLOUD/census/ledger wiring are structural claims this reader
 * holds; the smokes themselves own the live measurement, and this reader starts no Redis.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants EIGHT corruptions — the eval
 * swapped back to bare incr, the EXPIRE erased from the Lua body, the falsifier arm removed, the
 * atomicity test deleted, the CI platform command dropped, the census entry deleted, the wire smoke
 * dropped from CI, and the census wire-falsifier binding unbound — and requires EACH to redden while
 * the real plane holds. The D909 in-memory fallback contract (bounded, LRU, window semantics) must
 * ALSO survive.
 *
 * WHAT THIS DOES NOT SAY: that the suite passed today, that a real Redis answered, or that any OTHER
 * two-command sequence is atomic — notably {@code setIfAbsent}'s SETNX+EXPIRE (a replay-dedup key, a
 * different claim with a different failure mode) is out of scope and recorded as not-claimed. Fixed
 * window's boundary burst is a known trade-off, not something this unit claims to remove (a ZSET
 * sliding window is a separate, unclaimed seam).
 *
 * Usage:  node scripts/check_atomic_ratelimit.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const STORE = 'services/platform/src/main/java/com/nexus/platform/KeyValueStore.java';
const RATE = 'services/platform/src/main/java/com/nexus/platform/RateLimiter.java';
const TEST = 'services/platform/src/test/java/com/nexus/platform/KeyValueStoreAtomicityTest.java';
const SMOKE = 'scripts/ratelimit_atomicity_smoke.sh';
const FALSIFIER = 'scripts/falsify_ratelimit_atomicity_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_atomic_ratelimit.mjs';
const PATHS = [STORE, RATE, TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the atomicity plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — the Lua body holds BOTH commands in one script (the structural atomicity). */
  has(STORE, 'INCR_AND_EXPIRE_LUA', 'the atomic script is a named constant');
  const lua = /INCR_AND_EXPIRE_LUA\s*=\s*([\s\S]*?);/.exec(t(STORE));
  if (!lua) offenders.push('MISSING — the Lua script literal could not be isolated in KeyValueStore.java');
  else {
    if (!/redis\.call\(\s*'INCR'/.test(lua[1])) offenders.push('MISSING — the Lua body does not INCR');
    else notes.push('held the Lua body issues INCR');
    if (!/redis\.call\(\s*'EXPIRE'/.test(lua[1])) offenders.push('MISSING — the Lua body does not EXPIRE (a counter could again have no ttl)');
    else notes.push('held the Lua body issues the conditional EXPIRE');
    if (!/n\s*==\s*1/.test(lua[1])) offenders.push('MISSING — the Lua EXPIRE is not conditional on the first write');
    else notes.push('held the EXPIRE is gated on the first write');
  }
  has(STORE, 'ARGV', 'the ttl seconds are passed as ARGV, not interpolated into the script');

  /* 2 — increment really calls eval; the two-command shape is gone from that path. */
  has(STORE, 'redis.eval(', 'the Redis increment path issues one EVAL');
  has(STORE, 'ScriptOutputType.INTEGER', 'the EVAL asks for an integer counter');
  // Isolate the increment method body so a historical mention in the javadoc cannot fake compliance.
  const inc = /public long increment\(String key, Duration window\) \{([\s\S]*?)\n    \}/.exec(t(STORE));
  if (!inc) offenders.push('MISSING — the increment(String, Duration) body could not be isolated');
  else {
    if (!inc[1].includes('redis.eval(')) offenders.push('MISSING — increment() does not call redis.eval');
    else notes.push('held increment() calls redis.eval');
    if (/redis\.incr\s*\(/.test(inc[1])) offenders.push('STALE — increment() still sends a bare redis.incr (the split survived)');
    else notes.push('held increment() has no bare redis.incr');
    if (/redis\.expire\s*\(/.test(inc[1])) offenders.push('STALE — increment() still sends a bare redis.expire (the split survived)');
    else notes.push('held increment() has no bare redis.expire');
  }

  /* 3 — the FALSIFIER and POSITIVE arms exist, and the in-memory fallback contract is intact. */
  has(TEST, 'theLegacySplitLocksOutAndTheAtomicPathDoesNot', 'the falsifier reproduces the TTL-less lockout');
  has(TEST, 'isEqualTo(-1L)', 'the falsifier asserts the legacy key has no ttl');
  has(TEST, 'never()).expire(', 'the atomic path is asserted to never call the standalone expire');
  has(TEST, 'liveRedisLeavesATtlAndCounts', 'a live-Redis positive arm exists');
  has(TEST, 'isGreaterThan(0)', 'the positive arm asserts a real TTL > 0');
  has(STORE, 'sweepExpired', 'the D909 bounded/swept in-memory fallback is preserved');
  has(RATE, 'store.increment(key, window)', 'the limiter still routes through the atomic store');

  /* 4 — wiring into CI, docs, machine census and the ledger. */
  // CI runs the WHOLE platform surefire suite; the new KeyValueStoreAtomicityTest is discovered by
  // surefire's default **/*Test.java include, so the contract to hold is the module test command itself.
  has(CI, 'mvn -B -f services/platform/pom.xml test', 'CI runs the full platform test suite (discovers the atomicity test)');
  has(ATLAS, 'scripts/check_atomic_ratelimit.mjs', 'ATLAS lists this reader');
  has(CLOUD, 'D932', 'CLOUD.md records the D932 seam');
  has(CENSUS, '- id: D932', 'the machine census indexes D932');
  has(CENSUS, 'honesty_anchor: D932', 'D932 binds an exact honesty anchor');
  has(STATUS, '## 932. D932', 'the ledger holds §932');

  /* 5 — the TWO WIRE-LEVEL Redis smokes: load-bearing assertions + all wiring (D931 parity). */
  // The positive smoke must eval the SOURCE-extracted Lua, not a copy that could drift, and must
  // assert BOTH halves of the property: a first-write ttl AND a next INCR that does not re-arm.
  has(SMOKE, 'INCR_AND_EXPIRE_LUA', 'the positive smoke extracts the Lua from KeyValueStore.java');
  has(SMOKE, 'redis EVAL "$SCRIPT"', 'the positive smoke evals the source script on live Redis');
  has(SMOKE, '[ "$ttl1" -gt 0 ]', 'the positive smoke asserts a real first-write ttl > 0');
  has(SMOKE, '[ "$ttl2" -lt "$ttl1" ]', 'the positive smoke asserts the next INCR does NOT re-arm the window');
  // The falsifier must reproduce the TTL-less lockout on the legacy split (the injected fault), then
  // close the loop by showing the one-script path does NOT leave that state.
  has(FALSIFIER, '[ "$ttl" = "-1" ]', 'the falsifier asserts the legacy split reproduces TTL == -1');
  has(FALSIFIER, "Deliberately NO 'redis EXPIRE'", 'the falsifier names the injected fault window');
  has(FALSIFIER, 'redis EVAL "$SCRIPT"', 'the falsifier closes the loop with the one-script path');
  // Wiring: each proof is invoked by CI, listed on the human + map pages, bound in the machine census
  // and recorded in the ledger — the same four corners D931's events-group reader holds.
  has(CI, 'scripts/ratelimit_atomicity_smoke.sh', 'CI runs the positive wire smoke');
  has(CI, 'scripts/falsify_ratelimit_atomicity_smoke.sh', 'CI runs the wire falsifier');
  has(ATLAS, 'scripts/ratelimit_atomicity_smoke.sh', 'ATLAS lists the positive wire smoke');
  has(ATLAS, 'scripts/falsify_ratelimit_atomicity_smoke.sh', 'ATLAS lists the wire falsifier');
  has(CLOUD, 'ratelimit_atomicity_smoke.sh', 'CLOUD.md lists the positive wire smoke');
  has(CLOUD, 'falsify_ratelimit_atomicity_smoke.sh', 'CLOUD.md lists the wire falsifier');
  has(CENSUS, 'smoke: ratelimit_atomicity_smoke.sh', 'the census binds the positive wire smoke');
  has(CENSUS, 'falsifier: falsify_ratelimit_atomicity_smoke.sh', 'the census binds the wire falsifier');
  has(STATUS, 'ratelimit_atomicity_smoke.sh', 'the ledger records the positive wire smoke');
  has(STATUS, 'falsify_ratelimit_atomicity_smoke.sh', 'the ledger records the wire falsifier');

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
    ['eval swapped back to incr', mutate(STORE, 'redis.eval(INCR_AND_EXPIRE_LUA, io.lettuce.core.ScriptOutputType.INTEGER,\n                        new String[]{key}, String.valueOf(seconds))',
      'redis.incr(key); if (true) redis.expire(key, seconds)')],
    ['EXPIRE erased from Lua', mutate(STORE, "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end", 'if n == 1 then return n end')],
    ['falsifier assertion removed', mutate(TEST, 'verify(atomic, never()).expire(', 'verify(atomic, times(0)).nonexistent(')],
    ['positive arm deleted', mutate(TEST, 'void liveRedisLeavesATtlAndCounts()', 'void disabledLiveArm()')],
    ['CI platform test command dropped', mutate(CI, 'mvn -B -f services/platform/pom.xml test',
      '# the platform suite is no longer run')],
    ['census entry deleted', mutate(CENSUS, '- id: D932', '- id: D999')],
    ['wire smoke dropped from CI', mutate(CI, ' && bash scripts/ratelimit_atomicity_smoke.sh', '')],
    ['census wire-falsifier unbound', mutate(CENSUS, 'falsifier: falsify_ratelimit_atomicity_smoke.sh', 'falsifier: none')],
  ];
  let allCaught = true;
  for (const [label, arm] of arms) {
    if (arm.skipped) { console.log(`  self-test  ${label.padEnd(34)} SKIP (${arm.skipped})`); allCaught = false; continue; }
    const j = judge(arm.files, present);
    const red = j.unchecked !== null || j.offenders.length > 0;
    if (!red) allCaught = false;
    console.log(`  self-test  ${label.padEnd(34)} ${red ? 'red' : 'GREEN (defect!)'} offenders=${j.offenders.length}`);
  }
  console.log(`  self-test  all arms redden: ${allCaught}`);
  process.exit(allCaught ? 0 : 1);
}

const { files, present } = fromDisk();
const result = judge(files, present);
if (result.unchecked) { console.log(`RESULT: NOT CHECKED — ${result.unchecked}`); process.exit(2); }
for (const n of result.notes) console.log(`  ${n}`);
if (result.offenders.length) {
  console.log(`\nFALSE ATOMICITY WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D932 atomic limit counter wired, ${result.notes.length} holds`);
process.exit(0);
