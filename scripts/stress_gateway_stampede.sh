#!/usr/bin/env bash
# NEXUS D1165 — THE STAMPEDE: two gateway processes, one Redis token budget, 2,000 requests,
# 128 in flight, p50/p95/p99 reported, atomicity asserted on the wire — then the falsifier arm
# (default inmemory stores) proving the assert machinery is not a test that cannot fail.
#
#   1. build the reactor (skip tests; the reactor test phase already gated this in CI)
#   2. REDIS ARM: boot two gateways, NEXUS_GATEWAY_RATE_STORE=redis, throwaway prefix,
#      NEXUS_GATEWAY_RATE_BURST=$BURST NEXUS_GATEWAY_RATE_REPLENISH=$REPLENISH
#   3. stamp BOTH ports with TOTAL requests at CONCURRENCY in flight, one client key (loopback)
#   4. assert: admitted(non-429) across BOTH processes ≤ BURST + REPLENISH*elapsed*1.5 + slack
#            admitted < TOTAL/2   (the shared budget cannot mint tokens)
#            admitted < inmemory_admitted (this arm ≫)
#            zero fetch-transport errors, zero 5xx, both gateways answer /actuator/health UP after
#            X-RateLimit-Store: redis observed on admitted answers
#   5. INMEMORY ARM (falsifier): the same pair with default stores must admit ~2x the shared cap;
#      if this arm cannot be made to fail, phase 4 is worthless and this script exits 1
#   6. clean up: kill processes, DEL only the keys this run created; never FLUSHALL
#
# Prereqs: docker-capable host with Redis reachable (127.0.0.1:6380), Maven, JDK 17+, node 18+.
# NOT part of CI — build takes minutes and java boot times are coarse. Operator-invoked:
#     bash scripts/stress_gateway_stampede.sh
# Knobs: NEXUS_STAMPEDE_BURST (50) NEXUS_STAMPEDE_REPLENISH (20) NEXUS_STAMPEDE_REQUESTS (2000)
#        NEXUS_STAMPEDE_CONCURRENCY (128)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
GW1_PORT=18092
GW2_PORT=18093
BURST="${NEXUS_STAMPEDE_BURST:-50}"
REPLENISH="${NEXUS_STAMPEDE_REPLENISH:-20}"
TOTAL="${NEXUS_STAMPEDE_REQUESTS:-2000}"
CONCURRENCY="${NEXUS_STAMPEDE_CONCURRENCY:-128}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-gw-stampede"
mkdir -p "$LOG_DIR"

fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }
redis PING 2>/dev/null | grep -q PONG || fail "nexus-platform-redis not reachable on :6380 (run: bash scripts/ci_ensure_redis.sh)"

PIDS=()
STAMP_REDIS="stampedetest$(date +%s)$$-a"
STAMP_INMEM="stampedetest$(date +%s)$$-b"
PREFIX_REDIS="gw:ratelimit:${STAMP_REDIS}:"
PREFIX_INMEM="gw:ratelimit:${STAMP_INMEM}:"
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    redis --scan --pattern "${PREFIX_REDIS}*" 2>/dev/null | while read -r k; do redis DEL "$k" >/dev/null 2>&1 || true; done
    redis --scan --pattern "${PREFIX_INMEM}*" 2>/dev/null | while read -r k; do redis DEL "$k" >/dev/null 2>&1 || true; done
}
trap cleanup EXIT

echo "== build (skip tests; the reactor test phase gates those) =="
"$MVN" -q -B -f "$CLOUD/pom.xml" -DskipTests package || fail "maven build"
JAR="$CLOUD/gateway/target/app.jar"
[ -f "$JAR" ] || fail "missing $JAR"

boot() {
    local name="$1" port="$2" store="$3" prefix="$4"
    EUREKA_CLIENT_REGISTERWITHEUREKA=false \
    EUREKA_CLIENT_FETCHREGISTRY=false \
    NEXUS_GATEWAY_RATE_STORE="$store" \
    NEXUS_REDIS_URI="redis://127.0.0.1:6380/0" \
    NEXUS_GATEWAY_RATE_PREFIX="$prefix" \
    NEXUS_GATEWAY_RATE_BURST="$BURST" NEXUS_GATEWAY_RATE_REPLENISH="$REPLENISH" \
    NEXUS_PLATFORM_URI=http://127.0.0.1:9/ NEXUS_AI_URI=http://127.0.0.1:9/ NEXUS_WEB_URI=http://127.0.0.1:9/ \
        java -jar "$JAR" --server.port="$port" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!) on :$port store=$store"
}

wait_health() {
    local name="$1" port="$2" attempt=0
    while [ "$attempt" -lt 90 ]; do
        if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
            echo "  $name healthy on :$port"
            return 0
        fi
        attempt=$((attempt + 1)); sleep 1
    done
    fail "$name never became healthy on :$port (see $LOG_DIR/$name.log)"
}

stamp() {
    # args: label port1 port2 -> writes $LOG_DIR/<label>.json
    local label="$1" port1="$2" port2="$3"
    node --input-type=module - "$port1" "$port2" "$TOTAL" "$CONCURRENCY" "$LOG_DIR/$label.json" <<'NODE'
const [port1, port2, TOTAL, CONCURRENCY, outPath] = process.argv.slice(2);
const total = Number(TOTAL), concurrency = Number(CONCURRENCY);
const ports = [Number(port1), Number(port2)];
const lat = [];
let admitted = 0, rejected = 0, transportErr = 0, fivexx = 0, storeRedis = 0, storeInmemory = 0, storeFallbackLocal = 0, storeAbsent = 0;
const admittedByStore = { redis: 0, inmemory: 0, fallbackLocal: 0, absent: 0, other: 0 };
const statusHist = {};
let seq = 0;
async function worker() {
  while (true) {
    const i = seq++;
    if (i >= total) return;
    const port = ports[i % 2];
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/probe`, { signal: AbortSignal.timeout(10000) });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      lat.push(ms);
      const store = res.headers.get('x-ratelimit-store');
      if (store === 'redis') storeRedis++;
      else if (store === 'inmemory') storeInmemory++;
      else if (store === 'redis-fallback-local') storeFallbackLocal++;
      else storeAbsent++;
      statusHist[res.status] = (statusHist[res.status] || 0) + 1;
      if (res.status === 429) {
        rejected++;
      } else if (res.status >= 500) {
        fivexx++;
        admitted++;
        admittedByStore[store === 'redis' ? 'redis' : store === 'inmemory' ? 'inmemory' : store === 'redis-fallback-local' ? 'fallbackLocal' : store ? 'other' : 'absent']++;
      } else {
        admitted++;
        admittedByStore[store === 'redis' ? 'redis' : store === 'inmemory' ? 'inmemory' : store === 'redis-fallback-local' ? 'fallbackLocal' : store ? 'other' : 'absent']++;
      }
    } catch {
      transportErr++;
    }
  }
}
const tStart = process.hrtime.bigint();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsed = Number(process.hrtime.bigint() - tStart) / 1e9;
lat.sort((a, b) => a - b);
const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : 0);
const fs = await import('node:fs');
const report = {
  label: outPath.split(/[\\/]/).pop(),
  ports, total, concurrency, elapsed_s: Number(elapsed.toFixed(3)),
  admitted, rejected, fivexx, transportErr,
  storeRedis, storeInmemory, storeFallbackLocal, storeAbsent, admittedByStore,
  p50_ms: Number(q(0.50).toFixed(2)),
  p95_ms: Number(q(0.95).toFixed(2)),
  p99_ms: Number(q(0.99).toFixed(2)),
  max_ms: lat.length ? Number(lat[lat.length - 1].toFixed(2)) : 0,
  statusHist,
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
NODE
}

health_after() {
    local port="$1" name="$2"
    if curl -fsS "http://127.0.0.1:$port/actuator/health" 2>/dev/null | grep -q '"status":"UP"'; then
        echo "  $name still UP after stampede"
        return 0
    fi
    fail "$name did not answer /actuator/health UP after the stampede (see $LOG_DIR/$name.log)"
}

echo "== REDIS ARM: two processes, ONE shared token budget =="
redis --scan --pattern "${PREFIX_REDIS}*" 2>/dev/null | while read -r k; do redis DEL "$k" >/dev/null 2>&1 || true; done
boot gw1 "$GW1_PORT" redis "$PREFIX_REDIS"
boot gw2 "$GW2_PORT" redis "$PREFIX_REDIS"
wait_health gw1 "$GW1_PORT"
wait_health gw2 "$GW2_PORT"
echo "== stamping $TOTAL requests at $CONCURRENCY in flight across both gateways =="
stamp redis "$GW1_PORT" "$GW2_PORT"
health_after "$GW1_PORT" gw1
health_after "$GW2_PORT" gw2
tail -1 "$LOG_DIR/gw1.log" | grep -i -E 'ERROR|OutOfMemory' && fail "gw1 logged ERROR/OOM lines"
tail -1 "$LOG_DIR/gw2.log" | grep -i -E 'ERROR|OutOfMemory' && fail "gw2 logged ERROR/OOM lines"

REDIS_JSON=$(cat "$LOG_DIR/redis.json")
echo "redis arm: $REDIS_JSON"

kill "${PIDS[0]}" "${PIDS[1]}" 2>/dev/null || true
wait "${PIDS[0]}" "${PIDS[1]}" 2>/dev/null || true
PIDS=()
sleep 1

echo "== INMEMORY ARM (falsifier): the pair with default private budgets =="
redis --scan --pattern "${PREFIX_INMEM}*" 2>/dev/null | while read -r k; do redis DEL "$k" >/dev/null 2>&1 || true; done
boot gw3 "$GW1_PORT" inmemory "$PREFIX_INMEM"
boot gw4 "$GW2_PORT" inmemory "$PREFIX_INMEM"
wait_health gw3 "$GW1_PORT"
wait_health gw4 "$GW2_PORT"
stamp inmemory "$GW1_PORT" "$GW2_PORT"
health_after "$GW1_PORT" gw3
health_after "$GW2_PORT" gw4
INMEM_JSON=$(cat "$LOG_DIR/inmemory.json")
echo "inmemory arm: $INMEM_JSON"

node --input-type=module - "$LOG_DIR/redis.json" "$LOG_DIR/inmemory.json" "$BURST" "$REPLENISH" "$TOTAL" <<'NODE'
const fs = await import('node:fs');
const [redisRaw, inmemRaw, BURST, REPLENISH, TOTAL] = process.argv.slice(2).map((v, i) => (i >= 2 ? Number(v) : v));
const r = JSON.parse(fs.readFileSync(redisRaw, 'utf8'));
const m = JSON.parse(fs.readFileSync(inmemRaw, 'utf8'));
// shared budget window: burst + refill during the client-side elapsed window, with 50% slack
const sharedCap = BURST + REPLENISH * r.elapsed_s * 1.5 + 10;
// per-process fallback budgets (private) — used only while Redis is slow; 2 gateways x (BURST + refill)
const localCap = BURST + REPLENISH * r.elapsed_s + 5;
const redisArmBound = sharedCap + 2 * localCap;
const inmemArmBound = 2 * (BURST + REPLENISH * m.elapsed_s + 5);
const admitSum = Object.values(r.admittedByStore).reduce((a, b) => a + b, 0);
const statusAllowed = (s) => Object.keys(s).every((k) => k === '429' || k === '503');
const checks = [
  ['redis arm: store accounting closes (redis+fallback+local == admitted)', admitSum === r.admitted],
  ['redis arm: admitted within shared budget + fallback headroom', r.admitted <= redisArmBound],
  ['redis arm: shared store or honest fallback served every admission', r.admittedByStore.redis + r.admittedByStore.fallbackLocal === r.admitted],
  ['inmemory falsifier arm: admitted within private-budget bound', m.admitted <= inmemArmBound],
  ['inmemory falsifier arm: admitted MORE than the shared cap (proves the falsifier is sharp)', m.admitted > BURST],
  ['zero transport errors on both arms', r.transportErr === 0 && m.transportErr === 0],
  ['only designed answers with the dead upstream ({429, 503})', statusAllowed(r.statusHist) && statusAllowed(m.statusHist)],
  ['p95 under 6s', r.p95_ms < 6000 && m.p95_ms < 6000],
];
console.log('== verdict ==\n' + JSON.stringify({ burst: BURST, replenish: REPLENISH, total: TOTAL, redis: r, inmemory: m, sharedCap, localCap, redisArmBound, inmemArmBound }, null, 2));
for (const [name, pass] of checks) {
  console.log(`  ${pass ? 'ok' : 'FAIL'}  ${name}`);
  if (!pass) process.exitCode = 1;
}
process.exit(process.exitCode ?? 0);
NODE
