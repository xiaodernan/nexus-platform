#!/usr/bin/env bash
# NEXUS D998 — bring up the ONE Redis plane contract that the Redis smoke chain reaches for.
#
# The chain in ci.yml (ratelimit_atomicity, sliding_window, ttl_jitter, singleflight,
# events_group/claim, falsify_*, ...) does not talk to Redis over a port: it execs a
#   `redis() { docker exec -i nexus-platform-redis redis-cli "$@"; }`
# helper (and the JVMs it boots use redis://127.0.0.1:6380). Locally both are satisfied by
# infra/docker-compose.yml's `redis` service, whose container_name is `nexus-platform-redis`
# and which publishes 127.0.0.1:${NEXUS_REDIS_HOST_PORT:-6380}:6379.
#
# The cloud CI job declared ONLY a postgres service container — no `nexus-platform-redis`
# container and no Redis service of any name. GitHub Actions service containers get generated
# names (e.g. <hash>_redis_1), so `docker exec -i nexus-platform-redis` can NEVER hit them.
# Before D998 the chain never reached these smokes: earlier reader false-reds short-circuited
# the cloud job, so this gap lay latent. Once D996/D995/D993 made the gate honest, the chain
# finally ran and died at `ratelimit_atomicity_smoke.sh`: "nexus-platform-redis not reachable".
#
# This script reproduces the compose contract on any docker-capable host (a GitHub runner has
# docker) by starting a container WITH THAT EXACT NAME and port mapping. It is idempotent: a
# healthy existing container (the local compose plane) is reused untouched, so no dev data is
# ever flushed or removed. CI calls it once at the head of the cloud smoke chain.
#
# NOT CLAIMED: production Redis, persistence across CI runs, or cluster/sentinel behaviour. It is
# the throwaway single-node plane the smokes' Lua/stream/TTL assertions need.
#
# Usage:  bash scripts/ci_ensure_redis.sh
# Env:    NEXUS_REDIS_CONTAINER (default nexus-platform-redis), NEXUS_REDIS_HOST_PORT (default 6380)
set -u

NAME="${NEXUS_REDIS_CONTAINER:-nexus-platform-redis}"
PORT="${NEXUS_REDIS_HOST_PORT:-6380}"
IMAGE="${NEXUS_REDIS_IMAGE:-redis:7.4-alpine}"
READY_SECONDS="${NEXUS_REDIS_READY_SECONDS:-30}"

# The exact predicate every Redis smoke uses. Keep it byte-identical to their `redis()` helper:
#   docker exec -i nexus-platform-redis redis-cli PING | grep -q PONG
redis_ping() { docker exec -i "$NAME" redis-cli PING 2>/dev/null | grep -q PONG; }

if redis_ping; then
    echo "  nexus-platform-redis already reachable on :$PORT — reusing it (idempotent)"
    exit 0
fi

# A same-named but non-responsive container (stale/hung from a prior step) cannot be exec'd or
# re-created; remove ONLY that named container, never anything else on the host.
if docker inspect "$NAME" >/dev/null 2>&1; then
    echo "  $NAME exists but is not answering PING — removing the stale container"
    docker rm -f "$NAME" >/dev/null 2>&1 || true
fi

# Reproduce infra/docker-compose.yml's redis service: same image, command and host port. No volume:
# CI needs a fresh, empty DB for deterministic key counters; local reuses the healthy compose one above.
echo "  starting $NAME ($IMAGE) on 127.0.0.1:$PORT:6379"
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:6379" "$IMAGE" \
    redis-server --appendonly yes --maxmemory-policy noeviction >/dev/null \
    || { echo "FAIL: could not start $NAME"; exit 1; }

# Readiness gate: the first Redis smoke calls PING || fail, so never hand it a cold socket.
attempt=0
while [ "$attempt" -lt "$READY_SECONDS" ]; do
    if redis_ping; then
        echo "  $NAME up on :$PORT (redis-cli PING -> PONG)"
        exit 0
    fi
    attempt=$((attempt + 1))
    sleep 1
done

echo "FAIL: $NAME did not answer PING within ${READY_SECONDS}s" >&2
docker logs "$NAME" 2>&1 | tail -20 >&2
exit 1
