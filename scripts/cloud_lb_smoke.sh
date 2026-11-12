#!/usr/bin/env bash
# NEXUS D848 - the registered monolith, reached BY NAME through the edge. The ONLINE proof that
# scripts/check_cloud_discovery.mjs's wiring claims mean something:
#
#   1. the platform boots with profiles dev,cloud and REGISTERS as NEXUS-PLATFORM on the plane's
#      own registry, on a port of this smoke's own (the canonical :8090 may be serving a live
#      instance owned by another session - this smoke never touches it);
#   2. the AI service boots with NEXUS_AI_EUREKA_ENABLED=true and registers as NEXUS-AI by the
#      same opt-in (D856's second half) - also on a port of this smoke's own;
#   3. the gateway boots with profile cloud and its routes resolve lb://NEXUS-PLATFORM and
#      lb://NEXUS-AI (deterministic limiter: burst=10, replenish=0, management exempt);
#   4. ONE REAL GET /api/v1/health through the edge is answered by the registered instance -
#      judged by the platform's own identity (service=nexus-platform), by the cloud profile in
#      the answer, and by ONE X-Request-Id shared across both hops (the edge mints it, the
#      platform's RequestIdFilter keeps it, the body's request_id equals the edge's header);
#   5. ONE REAL GET /ai/v1/health through the edge is answered by the registered AI instance,
#      and the AI keeps the caller's X-Request-Id (the gateway -> ai correlation, D856);
#   6. the limiter answers bursts with 429 + Retry-After: 1 (D850, deterministic replenish=0);
#   7. the registry holds nothing this repo does not declare, before and after the registrations
#      (D847's isolation rule, same grammar - the AI's declared name is read from discovery.py).
#
# Needs: the nexus-platform-postgres (:5433) and nexus-platform-redis (:6380) containers, the root
# .env (the dev profile's credential chain), uv for the AI service, and Maven. Builds both reactors
# under the shared lock. The config server is deliberately NOT started: the gateway's config import
# is optional, and this proof is about discovery, not configuration (cloud_smoke.sh owns that
# round-trip).
#
# Usage:  scripts/cloud_lb_smoke.sh
# Env:    NEXUS_LB_PLATFORM_PORT (the instance's own port, default 8091, must be FREE),
#         NEXUS_LB_AI_PORT (the AI's own port, default 8011, must be FREE),
#         NEXUS_SMOKE_EUREKA_PORT / NEXUS_SMOKE_GATEWAY_PORT (override the module-declared ports -
#         the defaults are READ from application.yaml, not retyped here), MVN (mvn)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUD="$ROOT/services/cloud"
MVN="${MVN:-mvn}"
module_port() {
    sed -n 's/^[[:space:]]*port:[[:space:]]*${[A-Z_]*:\([0-9]*\)}[[:space:]]*$/\1/p' \
        "$CLOUD/$1/src/main/resources/application.yaml" | head -1
}
EUREKA_PORT="${NEXUS_SMOKE_EUREKA_PORT:-$(module_port eureka-server)}"
GATEWAY_PORT="${NEXUS_SMOKE_GATEWAY_PORT:-$(module_port gateway)}"
PLATFORM_PORT="${NEXUS_LB_PLATFORM_PORT:-8091}"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-lb-smoke"
mkdir -p "$LOG_DIR"

LOCK="$ROOT/.tmp-p4/mvnlock"
LOCK_OWNED=0
PIDS=()
cleanup() {
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do
        kill "$pid" 2>/dev/null || true
    done
    wait 2>/dev/null || true
    [ "$LOCK_OWNED" = 1 ] && rmdir "$LOCK" 2>/dev/null
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    echo "logs: $LOG_DIR" >&2
    # Every child logged its own output to $LOG_DIR/*.log; print the last 60 lines each so the
    # failure shows up in CI, not just the waits that expired. Bounded, one file at a time.
    if [ -d "$LOG_DIR" ]; then
        for f in "$LOG_DIR"/*.log; do
            [ -f "$f" ] || continue
            echo "----- $f"
            tail -n 60 "$f" || true
        done
    fi
    exit 1
}

if [ -f "$ROOT/.env" ]; then
    # Caller overrides survive .env (D54's guard): the names come out of the service's own three config
    # files, not a list kept here, and no value is printed.
    KEPT=""
    RESTORE=""
    for key in $(grep -hoE '\$\{[A-Z][A-Z0-9_]{2,}' \
                       "$ROOT/services/platform/src/main/resources/application.yml" \
                       "$ROOT/services/platform/src/main/resources/application-dev.yml" \
                       "$ROOT/services/platform/src/main/resources/application-cloud.yml" \
                   | sed -E 's/^\$\{//' | sort -u); do
        [ -n "${!key:-}" ] || continue
        KEPT="$KEPT $key"
        RESTORE="$RESTORE $key=${!key}"
    done
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
    for pair in $RESTORE; do export "${pair%%=*}"="${pair#*=}"; done
    [ -n "$KEPT" ] || KEPT=" none"
    echo "caller overrides kept over .env:$KEPT" >&2
else
    # No .env on disk — fall back to the same defaults a fresh clone/CI job can boot without a root
    # .env. The caller's environment still wins. Credentials mirror the CI job's own service container:
    # a disposable postgres on :5433 with password ci_secret, and the integration-test JWT secret.
    export NEXUS_PLATFORM_DB_URL="${NEXUS_PLATFORM_DB_URL:-${NEXUS_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus}}"
    export NEXUS_PLATFORM_DB_USERNAME="${NEXUS_PLATFORM_DB_USERNAME:-${NEXUS_DB_USER:-postgres}}"
    # D992: derive the runtime datasource password from whatever CI/this job supplied. We deliberately
    # do NOT export NEXUS_MIGRATION_DB_PASSWORD here — Flyway's superuser password cascades to this same
    # value in application-dev.yml (migration > root > platform-db > db), so setting it here would hide a
    # future regression of that chain and split the two connections' credentials. The platform boots as
    # the same `postgres` user with one secret under both the dev and cloud profiles.
    export NEXUS_PLATFORM_DB_PASSWORD="${NEXUS_PLATFORM_DB_PASSWORD:-${NEXUS_DB_PASSWORD:-ci_secret}}"
    export NEXUS_JWT_SECRET="${NEXUS_JWT_SECRET:-ci_only_not_a_real_secret_0123456789abcdef}"
    export NEXUS_REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
    export NEXUS_LLM_PROVIDER="${NEXUS_LLM_PROVIDER:-mock}"
    echo "no root .env — falling back to CI/fresh-clone defaults (all exportable; caller wins)" >&2
fi

# The platform's declared name, read not retyped: Eureka lists it uppercased, the health body lower.
PLATFORM_NAME="$(sed -n 's/^[[:space:]]*name:[[:space:]]*\([A-Za-z0-9._-]*\)[[:space:]]*$/\1/p' \
    "$ROOT/services/platform/src/main/resources/application.yml" | head -1)"
[ -n "$PLATFORM_NAME" ] || fail "the platform declares no spring.application.name to register as"
PLATFORM_NAME_UPPER="$(echo "$PLATFORM_NAME" | tr '[:lower:]' '[:upper:]')"

wait_for() {
    local name="$1" url="$2" pattern="$3" limit="${4:-90}" attempt=0
    while [ "$attempt" -lt "$limit" ]; do
        if curl -fsS "$url" 2>/dev/null | grep -q "$pattern"; then
            echo "  $name ready ($url)"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    fail "$name never answered $pattern at $url (see $LOG_DIR/$name.log)"
}

start() {
    local name="$1" jar="$2"
    shift 2
    [ -f "$jar" ] || fail "missing $jar"
    java -jar "$jar" "$@" >"$LOG_DIR/$name.log" 2>&1 &
    PIDS+=("$!")
    echo "  $name started (pid $!)"
}

# Every application name this repo declares (D847's grammar): the three cloud modules + the monolith,
# plus the AI service's opt-in default read from discovery.py (D856) - never retyped here.
plane_names() {
    {
        grep -h -A1 '^  application:' "$CLOUD"/*/src/main/resources/application.yaml \
            "$ROOT/services/platform/src/main/resources/application.yml" 2>/dev/null \
            | sed -n 's/^[[:space:]]*name:[[:space:]]*\([A-Za-z0-9._-]*\)[[:space:]]*$/\1/p'
        sed -n 's/.*NEXUS_AI_APP_NAME[^,]*,[[:space:]]*"\([A-Za-z0-9._-]*\)".*/\1/p' \
            "$ROOT/apps/ai/nexus_ai/discovery.py" | head -1
    } | tr '[:lower:]' '[:upper:]' | sort -u
}
assert_registry_is_ours() {
    local allowed listed n foreign=""
    allowed="$(plane_names)"
    [ -n "$allowed" ] || fail "no application name could be read from the repo - the isolation check is empty"
    listed="$(curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -o '{"name":"[^"]*","instance"' | sed 's/{"name":"//; s/","instance"//' \
        | tr '[:lower:]' '[:upper:]' | sort -u)"
    for n in $listed; do
        echo "$allowed" | grep -qx "$n" || foreign="$foreign $n"
    done
    [ -z "$foreign" ] \
        || fail "the registry on :$EUREKA_PORT lists application(s) this repo does not declare:$foreign"
    echo "  registry on :$EUREKA_PORT holds only declared names (${listed:-none yet})"
}

[ -n "$EUREKA_PORT" ] && [ -n "$GATEWAY_PORT" ] \
    || fail "a cloud module's application.yaml declares no \${ENV:<port>} default this script can read"
if (echo > "/dev/tcp/127.0.0.1/$PLATFORM_PORT") 2>/dev/null; then
    fail "platform port $PLATFORM_PORT is already bound - this smoke needs a port of its own (NEXUS_LB_PLATFORM_PORT)"
fi

echo "== build (under the shared maven lock) =="
if [ "${NEXUS_LB_SKIP_REBUILD:-}" = "1" ]; then
    echo "  NEXUS_LB_SKIP_REBUILD=1 - using the existing target/ jars"
else
    mkdir -p "$ROOT/.tmp-p4"
    mkdir "$LOCK" 2>/dev/null || fail "maven lock held (.tmp-p4/mvnlock) - another build is running"
    LOCK_OWNED=1
    "$MVN" -B -q -DskipTests -f "$CLOUD/pom.xml" package || fail "cloud reactor build failed"
    "$MVN" -B -q -DskipTests -f "$ROOT/services/platform/pom.xml" package || fail "platform build failed"
    rmdir "$LOCK" 2>/dev/null && LOCK_OWNED=0
fi
echo "  both reactors built"

echo "== start the registry =="
start eureka "$CLOUD/eureka-server/target/app.jar" --server.port="$EUREKA_PORT"
wait_for eureka "http://127.0.0.1:$EUREKA_PORT/actuator/health" '"status":"UP"'
assert_registry_is_ours

echo "== start the monolith (profiles dev,cloud) =="
start platform "$ROOT/services/platform/target/nexus-platform.jar" \
    --spring.profiles.active=dev,cloud --server.port="$PLATFORM_PORT"
# The boot budget for the platform/AI is env-tunable so CI (cold, slow runner) gets a wider budget than a development machine.
PLATFORM_WAIT="${NEXUS_LB_PLATFORM_WAIT:-240}"
AI_WAIT="${NEXUS_LB_AI_WAIT:-180}"
wait_for platform "http://127.0.0.1:$PLATFORM_PORT/api/v1/health" '"status":"ok"' "$PLATFORM_WAIT"

echo "== the registry learns the monolith =="
registered=0
attempt=0
while [ "$attempt" -lt 60 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -q '"app":"'"$PLATFORM_NAME_UPPER"'"'; then
        registered=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$registered" = 1 ] || fail "eureka never listed $PLATFORM_NAME_UPPER"
apps="$(curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps")"
echo "$apps" | grep -q '"$":'"$PLATFORM_PORT" \
    || fail "the registered $PLATFORM_NAME_UPPER instance does not carry port $PLATFORM_PORT"
echo "  $PLATFORM_NAME_UPPER registered on :$PLATFORM_PORT"
assert_registry_is_ours

echo "== start the AI service with the opt-in registration (D856) =="
AI_PORT="${NEXUS_LB_AI_PORT:-8011}"
if (echo > "/dev/tcp/127.0.0.1/$AI_PORT") 2>/dev/null; then
    fail "AI port $AI_PORT is already bound - this smoke needs a port of its own (NEXUS_LB_AI_PORT)"
fi
env NEXUS_AI_HOST_PORT="$AI_PORT" \
    NEXUS_DATABASE_URL="${NEXUS_DATABASE_URL:-postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus_verify2}" \
    NEXUS_LLM_PROVIDER=mock \
    NEXUS_AI_EUREKA_ENABLED=true \
    NEXUS_EUREKA_URI="http://127.0.0.1:$EUREKA_PORT/eureka/" \
    uv run --directory "$ROOT/apps/ai" python start_ai.py >"$LOG_DIR/ai-lb.log" 2>&1 &
PIDS+=("$!")
echo "  ai started (pid $!)"
wait_for ai "http://127.0.0.1:$AI_PORT/ai/v1/health" '"status":"ok"' "$AI_WAIT"

echo "== the registry learns the AI =="
registered_ai=0
attempt=0
while [ "$attempt" -lt 90 ]; do
    if curl -fsS -H 'Accept: application/json' "http://127.0.0.1:$EUREKA_PORT/eureka/apps" 2>/dev/null \
        | grep -q '"app":"NEXUS-AI"'; then
        registered_ai=1
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done
[ "$registered_ai" = 1 ] || fail "eureka never listed NEXUS-AI from the AI service's opt-in registration"
echo "  NEXUS-AI registered"
assert_registry_is_ours

echo "== start the edge (profile cloud, deterministic limiter: burst=10, replenish=0) =="
# D850: the edge's limiter cannot be load-dependent on wall-clock replenishment. burst=10 and
# replenish=0 make the 25-call burst deterministic; the management exemption keeps wait_for's
# health polls off the bucket.
export NEXUS_GATEWAY_RATE_BURST=10
export NEXUS_GATEWAY_RATE_REPLENISH=0
start gateway "$CLOUD/gateway/target/app.jar" --spring.profiles.active=cloud --server.port="$GATEWAY_PORT"
wait_for gateway "http://127.0.0.1:$GATEWAY_PORT/actuator/health" '"status":"UP"'

echo "== the platform is still alive before the edge asks =="
curl -fsS --max-time 5 "http://127.0.0.1:$PLATFORM_PORT/api/v1/health" >/dev/null 2>&1 \
    || fail "the platform stopped answering on :$PLATFORM_PORT after 'platform ready' — it died during the AI-registration wait (memory? see $LOG_DIR/platform.log)"

echo "== the platform route resolves by name =="
routes="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/gateway/routes")" || fail "actuator/gateway/routes failed"
echo "$routes" | grep -q "lb://$PLATFORM_NAME_UPPER" \
    || fail "the platform route is not lb://$PLATFORM_NAME_UPPER under the cloud profile: $routes"
echo "  /api/v1/** -> lb://$PLATFORM_NAME_UPPER"

echo "== one real request through the edge =="
curl -fsS -D "$LOG_DIR/edge-headers.txt" -o "$LOG_DIR/edge-body.json" \
    "http://127.0.0.1:$GATEWAY_PORT/api/v1/health" || fail "the proxied health request failed"
grep -q "\"service\":\"$PLATFORM_NAME\"" "$LOG_DIR/edge-body.json" \
    || fail "the answer is not the platform's identity: $(cat "$LOG_DIR/edge-body.json")"
grep -q '"cloud"' "$LOG_DIR/edge-body.json" \
    || fail "the answering instance does not carry the cloud profile: $(cat "$LOG_DIR/edge-body.json")"
rid="$(grep -i '^x-request-id:' "$LOG_DIR/edge-headers.txt" | tr -d '\r' | sed 's/^[^:]*:[[:space:]]*//')"
[ -n "$rid" ] || fail "the edge sent no X-Request-Id"
grep -q "\"request_id\":\"$rid\"" "$LOG_DIR/edge-body.json" \
    || fail "the platform's request_id is not the edge's id - the two hops did not share one correlation id"
echo "  service=$PLATFORM_NAME, profiles carry cloud, one X-Request-Id across both hops ($rid)"

echo "== the AI is still alive before the edge asks =="
curl -fsS --max-time 5 "http://127.0.0.1:$AI_PORT/ai/v1/health" >/dev/null 2>&1 \
    || fail "the AI stopped answering on :$AI_PORT before the AI proxy test — it died during the edge/boot wait (memory? see $LOG_DIR/ai-lb.log)"

echo "== the AI route resolves by name (lb://NEXUS-AI) =="
routes="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/actuator/gateway/routes")" || fail "actuator/gateway/routes failed"
echo "$routes" | grep -q 'lb://NEXUS-AI' \
    || fail "the gateway route table does not carry lb://NEXUS-AI"
echo "  /ai/v1/health -> lb://NEXUS-AI"

echo "== one real request through the edge to the AI =="
ai_info="$(curl -fsS "http://127.0.0.1:$GATEWAY_PORT/ai/v1/health" 2>/dev/null)" \
    || fail "gateway /ai/v1/health failed (see $LOG_DIR/gateway.log)"
case "$ai_info" in
    *'"status":"ok"'*) echo "  /ai/v1/health through the gateway: ok" ;;
    *) fail "gateway /ai/v1/health returned no ok status: $ai_info" ;;
esac
corr_ai="lbcorrai-$$"
rid_ai="$(curl -fsS -D - -o /dev/null -H "X-Request-Id: $corr_ai" "http://127.0.0.1:$GATEWAY_PORT/ai/v1/health" \
    | tr -d '\r' | awk 'BEGIN{IGNORECASE=1} /^x-request-id:/{print $2}')"
[ "$rid_ai" = "$corr_ai" ] \
    || fail "the AI did not echo the gateway's X-Request-Id (got '$rid_ai', want '$corr_ai')"
echo "  gateway -> ai correlation: $corr_ai"

echo "== the edge rate limiter answers bursts with 429 + Retry-After (D850) =="
ok=0; limited=0
for i in $(seq 1 25); do
    code="$(curl -s -D "$LOG_DIR/d850_hdr_$i" -o /dev/null -w '%{http_code}' \
               -H "X-Request-Id: lbcorburst-$i" "http://127.0.0.1:$GATEWAY_PORT/api/v1/health")"
    case "$code" in
        200) ok=$((ok + 1)) ;;
        429) limited=$((limited + 1)) ;;
    esac
done
[ "$limited" -ge 1 ] || fail "no 429 in 25 rapid calls (the limiter admitted all of them)"
[ "$ok" -ge 1 ] || fail "no 200 in 25 rapid calls (the limiter refused everything; burst=10)"
retry_after="$(grep -ih '^retry-after:' "$LOG_DIR"/d850_hdr_* | head -1 \
    | sed -E 's/^[Rr]etry-[Aa]fter:[[:space:]]*//' | tr -d '\r')"
[ "$retry_after" = "1" ] || fail "a 429 is missing Retry-After: 1 (saw: '${retry_after:-none}')"
echo "  25 rapid calls -> $ok admitted, $limited refused; a 429 carries Retry-After: 1"

echo "PASS: cloud discovery smoke — eureka + platform(cloud profile) + ai(opt-in registration) + gateway(lb:// for both, limiter, correlation)"