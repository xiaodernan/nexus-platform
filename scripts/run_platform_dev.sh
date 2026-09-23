#!/usr/bin/env bash
# Launch the platform service the way this machine actually runs it.
#
# Why a script instead of `make dev-platform`: the Makefile target predates the port ruling in
# docs/DECISIONS.md D9 and still exports :8080, while every verifier, docs claim and running client in
# this repo uses :8090. Worse, the bare profile defaults once pointed the dev datasource at :5432 and
# the AI base URL at :8000 — both of which are *other projects'* listeners on this host, so a
# half-configured restart here could have written rate-limit keys or agent requests into a stack that
# does not belong to NEXUS. The overrides below are the whole point: no secret is printed, no default
# is trusted, and the ports are stated out loud.
#
# Usage:  scripts/run_platform_dev.sh            # foreground, Ctrl-C to stop
#         scripts/run_platform_dev.sh --log      # background, logs to .platform-dev.log, prints the PID
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [ -f .env ]; then
    # Local-only environment file (gitignored at .gitignore:5). Sourced, never echoed.
    #
    # The caller's own assignments have to survive this, so they are captured and restored: `.env` sets
    # NEXUS_PLATFORM_DB_URL, and with `set -a` a plain source silently re-points a run at the live
    # database no matter what the caller exported first. Every `${VAR:-default}` below then reads as if
    # the caller had chosen it. A throwaway verification run would have been proving the wrong database
    # — which is exactly what it did before this block existed.
    # The names come out of the service's own config, not a list kept here. The list used to be eleven
    # hand-typed variables, and D54 measured three it missed — NEXUS_DB_ROOT_PASSWORD, NEXUS_JWT_SECRET and
    # NEXUS_LOG_LEVEL — each of them set in .env, read by application*.yml, and therefore silently clobbered
    # for whoever exported it believing the opposite. A list somebody has to remember is the same defect as a
    # deadline nobody reads (D46), and the clobbered one here was the JWT signing secret.
    KEPT=""
    RESTORE=""
    for key in $(grep -hoE '\$\{[A-Z][A-Z0-9_]{2,}' \
                       services/platform/src/main/resources/application.yml \
                       services/platform/src/main/resources/application-dev.yml \
                   | sed -E 's/^\$\{//' | sort -u) SPRING_PROFILES_ACTIVE; do
        [ -n "${!key:-}" ] || continue
        KEPT="$KEPT $key"
        RESTORE="$RESTORE $key=${!key}"
    done
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
    for pair in $RESTORE; do export "${pair%%=*}"="${pair#*=}"; done
    # Names only, never values: the kept list used to be echoed as KEY=value, which wrote the platform
    # database password into .platform-dev.log for anyone who had exported it (§131).
    [ -n "$KEPT" ] || KEPT=" none"
    echo "caller overrides kept over .env:$KEPT" >&2
else
    echo "note: no .env — falling back to the pinned local container ports in application.yml" >&2
fi

export NEXUS_PORT="${NEXUS_PORT:-8090}"
# The dev profile has to be named out loud: nothing in the service activates it (only compose sets
# SPRING_PROFILES_ACTIVE), so a host launch used to run on the base defaults while everyone believed
# application-dev.yml was in play — including now, where the migration credential lives there.
export SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-${NEXUS_SPRING_PROFILE:-dev}}"
export NEXUS_TENANT="${NEXUS_TENANT:-${NEXUS_DEFAULT_TENANT:-hong-kong}}"
export NEXUS_PLATFORM_DB_URL="${NEXUS_PLATFORM_DB_URL:-jdbc:postgresql://127.0.0.1:5433/nexus}"
export NEXUS_PLATFORM_DB_USERNAME="${NEXUS_PLATFORM_DB_USERNAME:-nexus_app}"
export NEXUS_REDIS_URL="${NEXUS_REDIS_URL:-redis://127.0.0.1:6380/0}"
export NEXUS_AI_BASE_URL="${NEXUS_AI_BASE_URL:-http://127.0.0.1:8010}"

# Flyway needs a credential that can actually run DDL; the runtime role has DML only. The password is
# read from .env and never printed. Without it the boot fails closed on the first pending migration.
if [ -z "${NEXUS_DB_ROOT_PASSWORD:-}" ]; then
    echo "note: NEXUS_DB_ROOT_PASSWORD is unset, so Flyway (which runs as 'postgres', not the runtime" \
         "role) cannot connect and the service will not boot if a migration is pending." >&2
fi

if [ -z "${NEXUS_AI_INTERNAL_TOKEN:-}" ]; then
    echo "note: NEXUS_AI_INTERNAL_TOKEN is unset, so the agent's conversation writes will answer" \
         "503 internal_token_missing until it is set in .env (docs/API_CONTRACT.md §22)." >&2
fi

echo "platform: http://127.0.0.1:${NEXUS_PORT}  tenant=${NEXUS_TENANT}  db=:5433  redis=:6380  ai=:8010" \
     "  datasource=${NEXUS_PLATFORM_DB_URL}" \
     "  profile=${SPRING_PROFILES_ACTIVE}  migrate-as=postgres" >&2

if [ "${1:-}" = "--log" ]; then
    # The log and pid paths are overridable because this file is how *every* session on this machine
    # starts the service: a throwaway verification run that inherits `.platform-dev.log` truncates the
    # log the running instance's owner is reading, and overwrites the pid file they would kill by.
    LOG="${NEXUS_DEV_LOG:-$ROOT/.platform-dev.log}"
    PID="${NEXUS_DEV_PID:-$ROOT/.platform-dev.pid}"
    nohup mvn -o -q -DskipTests -f services/platform/pom.xml spring-boot:run > "$LOG" 2>&1 &
    echo $! > "$PID"
    echo "started in background, maven pid $(cat "$PID"); log: $LOG" >&2
else
    exec mvn -o -q -DskipTests -f services/platform/pom.xml spring-boot:run
fi
