#!/usr/bin/env node
/**
 * NEXUS D937 — the Redis-ZSET sliding window closes fixed-window's boundary burst, and stays WIRED.
 *
 * D932 made the fixed-window limit counter's INCR+first-write EXPIRE atomic, but a fixed window has a
 * BOUNDARY BURST: limit N per W lets a caller send N just before the edge and N just after, getting 2N
 * through in a span far shorter than W. D937 adds an OPT-IN sliding window (default OFF, so D932's fixed
 * path and its seven tests are untouched) over a Redis sorted set. ONE Lua EVAL does all four commands —
 * ZREMRANGEBYSCORE (drop scores <= now-W) + ZADD (append this hit) + PEXPIRE (reclaim idle keys) + ZCARD
 * (count) — indivisibly, so two concurrent callers cannot both read count < limit and both append (TOCTOU).
 * nowMs is injected so a test can pin the clock and PROVE the property without sleeping.
 *
 * THIS reader holds the structural claims a live smoke cannot: the source Lua really contains all FOUR
 * ZSET commands in one body (a script with ZREMRANGEBYSCORE deleted no longer slides), the slidingWindow
 * path really calls {@code eval} with INTEGER output and NO bare zadd/zcard/zremrangebyscore, the fallback
 * stays bounded by the D909 cap, the opt-in flag is DEFAULT FALSE, and RateLimiter really branches between
 * the fixed and sliding stores. The positive property (fixed admits 2N at the edge, sliding N, a hit a
 * window later resets to 1) and the FALSIFIER (delete ZREMRANGEBYSCORE => the window never resets => the
 * reset assertion reddens) live in sliding_window_smoke.sh / falsify_sliding_window_smoke.sh and
 * SlidingWindowTest, are run by Maven/CI and a live Redis; this reader starts no Redis and claims no test
 * ran today.
 *
 * SELF-TEST: `judge` is pure over (path -> text). `--self-test` plants corruptions in memory — the sweep
 * erased from the Lua, the eval swapped back to bare zadd, the default flipped to TRUE, the RateLimiter
 * branch removed, the fallback cap dropped, the falsifier assertion weakened, and the CI/census/ATLAS
 * bindings cut — and requires EACH to redden while the real plane holds. A seam whose proof can vanish
 * unnoticed is not a seam.
 *
 * WHAT THIS DOES NOT SAY: that any smoke ran today, that Redis answered, that the edge gateway's D917
 * token bucket uses this store (it does not), or that the in-memory fallback is as fast as Redis. No
 * production throughput, no cross-node guarantee beyond Redis's single-threaded script execution.
 *
 * Usage:  node scripts/check_sliding_window.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');
const REPORT = process.argv.includes('--report');

const STORE = 'services/platform/src/main/java/com/nexus/platform/KeyValueStore.java';
const RATE = 'services/platform/src/main/java/com/nexus/platform/RateLimiter.java';
const YAML = 'services/platform/src/main/resources/application.yml';
const TEST = 'services/platform/src/test/java/com/nexus/platform/SlidingWindowTest.java';
const SMOKE = 'scripts/sliding_window_smoke.sh';
const FALSIFIER = 'scripts/falsify_sliding_window_smoke.sh';
const CI = '.github/workflows/ci.yml';
const ATLAS = 'docs/ATLAS.md';
const CLOUD = 'docs/CLOUD.md';
const CENSUS = 'docs/cloud_claims.yaml';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_sliding_window.mjs';
const PATHS = [STORE, RATE, YAML, TEST, SMOKE, FALSIFIER, CI, ATLAS, CLOUD, CENSUS, STATUS, SELF];

/** Pure over a (path -> text) map; existence passed as a Set. */
export function judge(files, present) {
  const offenders = [];
  const notes = [];
  if (!(files instanceof Map) || files.size === 0) {
    return { offenders, notes, unchecked: 'the sliding-window plane is empty or unreadable — a census that found nothing cleared nothing' };
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

  /* 1 — the Lua body holds ALL FOUR commands in ONE script (the structural sliding property). */
  has(STORE, 'SLIDING_WINDOW_LUA', 'the atomic script is a named constant');
  const lua = /SLIDING_WINDOW_LUA\s*=\s*([\s\S]*?);/.exec(t(STORE));
  if (!lua) offenders.push('MISSING — the Lua script literal could not be isolated in KeyValueStore.java');
  else {
    for (const [re, label] of [
      [/redis\.call\(\s*'ZREMRANGEBYSCORE'/, 'the Lua body sweeps scores <= cutoff (the sliding half)'],
      [/redis\.call\(\s*'ZADD'/, 'the Lua body appends this hit'],
      [/redis\.call\(\s*'ZCARD'/, 'the Lua body counts the surviving hits'],
      [/redis\.call\(\s*'PEXPIRE'/, 'the Lua body reclaims idle keys'],
    ]) {
      if (!re.test(lua[1])) offenders.push(`MISSING — ${label}`);
      else notes.push(`held ${label}`);
    }
    if (!/ARGV\[1\]/.test(lua[1]) || !/'-inf'/.test(lua[1])) {
      offenders.push('MISSING — the sweep uses an injected cutoff (ARGV[1]) from -inf, not a hardcoded bound');
    } else notes.push('held the sweep cutoff is the injected now-W boundary');
  }

  /* 2 — slidingWindow really calls eval; the split commands are GONE from that path. */
  has(STORE, 'redis.eval(', 'the Redis sliding path issues one EVAL');
  has(STORE, 'ScriptOutputType.INTEGER', 'the EVAL asks for an integer count');
  const sw = /public long slidingWindow\(String key, long windowMs, long nowMs, String member\) \{([\s\S]*?)\n    \}/.exec(t(STORE));
  if (!sw) offenders.push('MISSING — the slidingWindow(String, long, long, String) body could not be isolated');
  else {
    if (!sw[1].includes('redis.eval(')) offenders.push('MISSING — slidingWindow() does not call redis.eval');
    else notes.push('held slidingWindow() calls redis.eval');
    for (const bare of ['zadd(', 'zcard(', 'zremrangebyscore(']) {
      if (sw[1].includes('redis.' + bare)) offenders.push(`STALE — slidingWindow() still sends a bare redis.${bare} (the split survived)`);
      else notes.push(`held slidingWindow() has no bare redis.${bare}`);
    }
    if (!sw[1].includes('nowMs - w')) offenders.push('MISSING — slidingWindow() derives the cutoff from the injected nowMs');
    else notes.push('held the cutoff is derived from injected nowMs');
  }

  /* 3 — the FALSIFIER and POSITIVE arms, the bounded fallback, and the D932 fixed path preserved. */
  has(TEST, 'liveRedisCountsAndSweeps', 'a live-Redis positive arm exists');
  has(TEST, 'slidingHoldsTheBoundaryBurstThatFixedLetsThrough', 'the fixed-2N-vs-sliding-N boundary arm exists');
  has(TEST, 'droppingTheCutoffReddensTheBurstClaim', 'the falsifier reproduces the no-sweep failure');
  has(TEST, 'fallbackStaysBounded', 'the in-memory fallback bounded arm exists');
  has(TEST, 'redisPathIsOneAtomicEval', 'the one-eval / no-split arm exists');
  has(TEST, 'limiterSelectsPathByFlag', 'the opt-in routing arm exists');
  has(STORE, 'sweepExpired', 'the D909 bounded/swept in-memory fallback is preserved');
  has(STORE, 'INCR_AND_EXPIRE_LUA', 'the D932 fixed-window counter is preserved (not replaced)');
  has(STORE, 'sweepExpired(nowMs)', 'the sliding fallback sweeps its bounded map on the write path');

  /* 4 — the opt-in flag is DEFAULT FALSE, and RateLimiter really branches. */
  has(RATE, 'nexus.ratelimit.sliding-enabled:false', 'the RateLimiter sliding flag defaults to OFF');
  has(RATE, 'slidingEnabled', 'RateLimiter carries the sliding flag');
  has(RATE, 'store.slidingWindow(key, window.toMillis())', 'RateLimiter routes the sliding branch to the ZSET store');
  has(RATE, 'store.increment(key, window)', 'RateLimiter keeps the D932 fixed-window branch');
  has(RATE, 'usingSlidingWindow()', 'RateLimiter exposes which path is active');
  has(YAML, 'sliding-enabled: ${NEXUS_RL_SLIDING_ENABLED:false}', 'the application config defaults sliding OFF');

  /* 5 — the TWO WIRE-LEVEL Redis smokes: load-bearing assertions + all wiring (D931/D932 parity). */
  has(SMOKE, 'SLIDING_WINDOW_LUA', 'the positive smoke extracts the Lua from KeyValueStore.java');
  has(SMOKE, 'redis EVAL "$SCRIPT"', 'the positive smoke evals the source script on live Redis');
  has(SMOKE, '2 x limit', 'the positive smoke names the fixed-window 2×limit burst');
  has(SMOKE, '[ "$fixed_admitted" -eq $((2 * LIMIT)) ]', 'the positive smoke asserts fixed really admitted 2×limit');
  has(SMOKE, '[ "$sliding_admitted" -le "$LIMIT" ]', 'the positive smoke asserts sliding held it to limit');
  has(SMOKE, '[ "$c_later" -eq 1 ]', 'the positive smoke asserts a hit a window later resets the window');
  has(FALSIFIER, 'ZREMRANGEBYSCORE statement was not found', 'the falsifier requires the sweep line to be present to delete');
  has(FALSIFIER, '[ "$c_no_sweep" -gt 1 ]', 'the falsifier asserts the sweep-less window never resets (permanent throttle)');
  has(FALSIFIER, '[ "$c_intact" -eq 1 ]', 'the falsifier control: the intact script still resets to 1');

  /* 6 — wiring into CI, docs, machine census and the ledger (four corners + this ledger). */
  has(CI, 'scripts/sliding_window_smoke.sh', 'CI runs the positive wire smoke');
  has(CI, 'scripts/falsify_sliding_window_smoke.sh', 'CI runs the wire falsifier');
  has(CI, 'node scripts/check_sliding_window.mjs --self-test', 'CI runs this reader (reachability)');
  has(ATLAS, 'scripts/check_sliding_window.mjs', 'ATLAS lists this reader');
  has(ATLAS, 'scripts/sliding_window_smoke.sh', 'ATLAS lists the positive wire smoke');
  has(ATLAS, 'scripts/falsify_sliding_window_smoke.sh', 'ATLAS lists the wire falsifier');
  has(CLOUD, 'check_sliding_window.mjs', 'CLOUD.md lists this reader');
  has(CLOUD, 'sliding_window_smoke.sh', 'CLOUD.md lists the positive wire smoke');
  has(CLOUD, 'falsify_sliding_window_smoke.sh', 'CLOUD.md lists the wire falsifier');
  has(CLOUD, 'D937', 'CLOUD.md records the D937 seam');
  has(CENSUS, '- id: D937', 'the machine census indexes D937');
  has(CENSUS, 'smoke: sliding_window_smoke.sh', 'the census binds the positive wire smoke');
  has(CENSUS, 'falsifier: falsify_sliding_window_smoke.sh', 'the census binds the wire falsifier');
  has(CENSUS, 'gate: check_sliding_window.mjs', 'the census binds this reader as the gate');
  has(CENSUS, 'honesty_anchor: D937', 'D937 binds an exact honesty anchor');
  has(STATUS, '## 937. D937', 'the ledger holds §937');

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
    ['sweep erased from Lua', mutate(STORE, "redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1]) ", '')],
    ['eval swapped back to zadd', mutate(STORE,
      'redis.eval(SLIDING_WINDOW_LUA, io.lettuce.core.ScriptOutputType.INTEGER,\n                        new String[]{key}, String.valueOf(cutoff), String.valueOf(nowMs),\n                        member, String.valueOf(w))',
      'redis.zadd(key, nowMs, member); return redis.zcard(key)')],
    ['opt-in default flipped TRUE', mutate(RATE, 'nexus.ratelimit.sliding-enabled:false', 'nexus.ratelimit.sliding-enabled:true')],
    ['RateLimiter sliding branch removed', mutate(RATE, 'store.slidingWindow(key, window.toMillis())', 'store.increment(key, window)')],
    ['fallback cap sweep dropped', mutate(STORE, 'sweepExpired(nowMs)', '/* no sweep */')],
    ['falsifier reset assertion weakened', mutate(FALSIFIER, '[ "$c_no_sweep" -gt 1 ]', '[ "$c_no_sweep" -eq 0 ]')],
    ['wire smoke dropped from CI', mutate(CI, ' && bash scripts/sliding_window_smoke.sh', '')],
    ['census wire-falsifier unbound', mutate(CENSUS, 'falsifier: falsify_sliding_window_smoke.sh', 'falsifier: none')],
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
  console.log(`FALSE SLIDING-WINDOW WIRING (${result.offenders.length}):`);
  for (const o of result.offenders) console.log('  - ' + o);
  console.log(`\nRESULT: FAIL — ${result.offenders.length} wiring offender(s)`);
  process.exit(1);
}
console.log(`RESULT: PASS — D937 sliding-window limiter wired, ${result.notes.length} holds`);
process.exit(0);
