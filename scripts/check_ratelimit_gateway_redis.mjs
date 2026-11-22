#!/usr/bin/env node
/**
 * NEXUS D1140 — the gateway edge rate limiter has an opt-in SHARED Redis bucket: structural reads.
 *
 * D850 shipped the edge's limiter as a per-process in-memory token bucket and said so honestly;
 * two gateways behind one balancer admitted 2x the declared burst. D1140 closes that seam behind
 * NEXUS_GATEWAY_RATE_STORE=redis: one atomic EVAL (HMGET/HSET/PEXPIRE under Redis's single
 * thread — the D932/D937 discipline) against NEXUS_GATEWAY_RATE_PREFIX{clientKey}, same BURST /
 * REPLENISH envs, default still inmemory. If Redis errors or stalls past the 500ms timeout the
 * FILTER falls back to the per-process bucket (never fail-open, never a hung edge) and LABELS the
 * fallback on the wire as X-RateLimit-Store: redis-fallback-local.
 *
 * What this reader holds (structural; it BOOTS nothing):
 *   1. the limiter Java exists and its Lua body keeps HMGET/HSET/PEXPIRE and the HSET-atomic pair
 *   2. EdgeRateLimitFilter really takes the redis branch and really falls back, with the label
 *   3. the gateway pom carries spring-boot-starter-data-redis-reactive
 *   4. ci.yml invokes BOTH the smoke and its falsifier inside the cloud chain (asserted by NAME, not by
 *      file length — D1535 removed the `548` pin, which reddened on every unrelated CI edit)
 *   5. the two smokes exist and the positive one actually asserts the cross-process claim
 *   6. docs/CLOUD.md names both smokes and carries the D1140 section header
 *   7. DECISIONS/STATUS carry the D1140 section
 *
 * What this does NOT say: that two gateways already booted in this environment, that Redis
 * answered, or that any node ran a test — the live measurement lives in ratelimit_gateway_redis_smoke.sh
 * and its falsifier, executed on the cloud CI job against the ci_ensure_redis plane.
 *
 * Usage:  node scripts/check_ratelimit_gateway_redis.mjs [--self-test] [--report]
 * Exit:   0 every wiring claim holds · 1 an offender · 2 the plane could not be read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF_TEST = process.argv.includes('--self-test');

const LIMITER = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/RedisTokenBucketLimiter.java';
const FILTER = 'services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeRateLimitFilter.java';
const POM = 'services/cloud/gateway/pom.xml';
const APPYAML = 'services/cloud/gateway/src/main/resources/application.yaml';
const SMOKE = 'scripts/ratelimit_gateway_redis_smoke.sh';
const FALSIFIER = 'scripts/falsify_ratelimit_gateway_redis_smoke.sh';
const CI = '.github/workflows/ci.yml';
const CLOUD = 'docs/CLOUD.md';
const ATLAS = 'docs/ATLAS.md';
const DECISIONS = 'docs/DECISIONS.md';
const STATUS = 'docs/STATUS.md';
const SELF = 'scripts/check_ratelimit_gateway_redis.mjs';
const PATHS = [LIMITER, FILTER, POM, APPYAML, SMOKE, FALSIFIER, CI, CLOUD, ATLAS, DECISIONS, STATUS, SELF];

function judge(files) {
  const offenders = [];
  const notes = [];
  const need = (rel, needle, label) => {
    const text = files.get(rel);
    if (text == null) { offenders.push(`MISSING — ${rel} unreadable (or ${label} erased)`); return; }
    if (!text.includes(needle)) offenders.push(`MISSING — ${rel} lost: ${label} [${JSON.stringify(needle).slice(0, 60)}]`);
    else notes.push(`held ${label}`);
  };
  const absent = (rel, needle, label) => {
    const text = files.get(rel);
    if (text != null && text.includes(needle)) offenders.push(`DRIFT — ${rel} must NOT carry: ${label} [${JSON.stringify(needle).slice(0, 60)}]`);
    else notes.push(`absent ${label}`);
  };

  need(LIMITER, 'TOKEN_BUCKET_LUA', 'the Lua constant is named (the smoke and the test bind to it)');
  need(LIMITER, "'HMGET'", 'HMGET reads the (tokens,ts) pair in ONE call');
  need(LIMITER, "'HSET'", 'HSET writes both fields together (no torn pair)');
  need(LIMITER, "'PEXPIRE'", 'every write re-arms a bounded TTL (no forever-key)');
  need(LIMITER, 'NEXUS_GATEWAY_RATE_STORE', 'the store is OPT-IN via env (default stays inmemory)');
  need(LIMITER, 'redis://127.0.0.1:6380/0', 'the dev-plane default points at the documented compose Redis');
  need(LIMITER, 'math.min(capacity', 'refill clamps at capacity (a long idle never over-fills)');
  need(FILTER, 'redisLimiter.admit(key)', 'the edge really takes the redis branch');
  need(FILTER, 'redis-fallback-local', 'a Redis failure degrades to the local bucket with the wire label');
  need(FILTER, 'X-RateLimit-Store', 'the answering store is labelled on EVERY answer, allowed or refused');
  need(FILTER, 'RedisTokenBucketLimiter.disabled()', 'the 2-arg constructor stays a local-only twin (tests stable)');
  need(POM, 'spring-boot-starter-data-redis-reactive', 'the reactive Redis client is on the classpath');
  need(APPYAML, 'rate-limit-store: ${NEXUS_GATEWAY_RATE_STORE:inmemory}', 'the shipped yaml documents the opt-in, default inmemory');
  need(SMOKE, 'NEXUS_GATEWAY_RATE_STORE=redis', 'the positive smoke boots with the redis store armed');
  need(SMOKE, 'two gateways', 'the positive smoke really boots a PAIR of gateways');
  need(SMOKE, 'X-RateLimit-Store', 'the positive smoke asserts the honest label, not only the 429');
  need(FALSIFIER, 'NEXUS_GATEWAY_RATE_STORE=inmemory', 'the falsifier boots the pre-D1140 default store');
  need(FALSIFIER, 'req3 gw2', 'the falsifier demands the private budget admits req3');
  need(CI, 'bash scripts/ratelimit_gateway_redis_smoke.sh', 'CI runs the live shared-store proof');
  need(CI, 'bash scripts/falsify_ratelimit_gateway_redis_smoke.sh', 'CI runs the falsifier');
  need(CI, 'node scripts/check_ratelimit_gateway_redis.mjs --self-test', 'CI runs this reader with its self-test');
  need(CLOUD, 'scripts/ratelimit_gateway_redis_smoke.sh', 'CLOUD.md names the positive smoke');
  need(CLOUD, 'scripts/falsify_ratelimit_gateway_redis_smoke.sh', 'CLOUD.md names the falsifier');
  need(CLOUD, 'D1140', 'CLOUD.md carries the D1140 section header');
  need(ATLAS, 'scripts/check_ratelimit_gateway_redis.mjs', 'ATLAS lists this reader');
  need(ATLAS, 'scripts/ratelimit_gateway_redis_smoke.sh', 'ATLAS lists the positive smoke');
  need(ATLAS, 'scripts/falsify_ratelimit_gateway_redis_smoke.sh', 'ATLAS lists the falsifier');
  need(DECISIONS, '## D1140', 'the ledger carries §D1140');
  need(STATUS, '## 1140. D1140', 'the ledger carries §1140');
  absent(LIMITER, 'SCAN', 'a per-request SCAN (hot path must be O(1))');
  absent(FILTER, 'StringRedisTemplate', 'blocking Redis client inside a reactive filter (would stall the loop)');

  return { offenders, notes };
}

function fromDisk() {
  const files = new Map();
  for (const p of PATHS) {
    const abs = join(ROOT, p);
    if (!existsSync(abs)) return { files, error: `${p} does not exist` };
    files.set(p, readFileSync(abs, 'utf8'));
  }
  // D1535 — this used to be `if (ciLines !== 548)`, a pin on the FILE'S LENGTH as a proxy for "the
  // smoke and its falsifier are still wired into the cloud chain". Every unrelated CI edit reddened it
  // and nothing about the wiring changed; a 12-line insert for another reader made the whole tree
  // "FAIL", which is the same failure mode D1534 found in the atlas fence — a reader deriving its
  // expectation from something that is not the property it claims to measure. The property is that the
  // two invocations are present in this file. So that is what is asserted, and the length is printed
  // instead of pinned: it is a fact about the tree, not a claim about the wiring.
  const ci = files.get(CI);
  const missing = ['ratelimit_gateway_redis_smoke.sh', 'falsify_ratelimit_gateway_redis_smoke.sh'].filter(
    (needle) => !ci.includes(needle),
  );
  if (missing.length) {
    return { files, error: `.github/workflows/ci.yml no longer invokes: ${missing.join(', ')} (D952 R5 wiring)` };
  }
  return { files, error: null };
}

function printResult({ offenders, notes }) {
  for (const n of notes) console.log(`  ${n}`);
  if (offenders.length) {
    console.log(`\nD1140 WIRING OFFENDER(S) (${offenders.length}):`);
    for (const o of offenders) console.log(`  ${o}`);
    process.exitCode = 1;
  } else {
    console.log('\nRESULT: PASS — the shared Redis edge bucket is wired end to end (Java, Lua, pom, yaml, CI chain, falsifier, docs, ledgers)');
  }
}

if (SELF_TEST) {
  const base = fromDisk();
  if (base.error) { console.error(base.error); process.exit(2); }
  const corrupt = (fn) => {
    const files = new Map(base.files);
    fn(files);
    return judge(files).offenders.length > 0;
  };
  const arms = [
    ['Lua loses PEXPIRE (a forever-key creeps in)', (f) => f.set(LIMITER, f.get(LIMITER).replace("'PEXPIRE'", "'PEXPR'"))],
    ['the fallback label is erased (the wire lies about the enforcement store)', (f) => f.set(FILTER, f.get(FILTER).split('redis-fallback-local').join('redis-fallback'))],
    ['the reactor loses spring-data-redis (the branch can never work)', (f) => f.set(POM, f.get(POM).replace('spring-boot-starter-data-redis-reactive', 'spring-boot-starter-web'))],
    ['CI drops the live smoke (green without measurement)', (f) => f.set(CI, f.get(CI).replace(' && bash scripts/ratelimit_gateway_redis_smoke.sh', ''))],
    ['CI drops the falsifier (green without opposition)', (f) => f.set(CI, f.get(CI).replace(' && bash scripts/falsify_ratelimit_gateway_redis_smoke.sh', ''))],
    ['the CLOUD.md section vanishes (the plane is not documented)', (f) => f.set(CLOUD, f.get(CLOUD).split('D1140').join('D114A'))],
  ];
  let failed = 0;
  for (const [label, fn] of arms) {
    const red = corrupt(fn);
    console.log(`  ${red ? 'ok  ' : 'BAD '}self-test arm: ${label}`);
    if (!red) failed += 1;
  }
  if (failed) { console.error(`\nSELF-TEST FAILED (${failed}/${arms.length} arms did not redden)`); process.exit(1); }
  console.log('\nSELF-TEST PASS — every planted corruption reddens');
  process.exit(0);
}

const from = fromDisk();
if (from.error) { console.error(from.error); process.exit(2); }
printResult(judge(from.files));
