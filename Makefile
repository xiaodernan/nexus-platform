# NEXUS — Makefile (Git Bash / MSYS make on Windows; every recipe is plain bash).
#
# WHY SOME THINGS RUN ON THE HOST: Phase 1 = containerized data stores (postgres + redis) and host
# processes for platform / ai / web, because those three source trees are authored by parallel work
# streams and have no Dockerfiles yet. `up` / `--profile full` is the Phase-7 path and will fail on a
# missing Dockerfile until then. See docs/DEPLOYMENT.md §3 and docs/ENVIRONMENT_REPORT.md §3/§4.
#
# make itself is not installed on this machine (docs/ENVIRONMENT_REPORT.md §3): every recipe below is
# a self-contained bash command, so `make x` and copy-pasting `x`'s body into Git Bash are equivalent.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -o pipefail -ec
.ONESHELL:
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

COMPOSE        := docker compose -f infra/docker-compose.yml --env-file .env
PG_CONTAINER   ?= nexus-platform-postgres
DB_NAME        ?= nexus
WEB_PORT       ?= 3002
AI_PORT        ?= 8010
PLATFORM_PORT  ?= 8090
AI_APP         ?= app.main:app
AI_HOST        ?= 127.0.0.1
# D9 pins these away from 5432/6379/3000/8000/8080 because unrelated stacks own them on this machine.
# The demo-plane credentials and the flyway disable are the boot recipe D304 measured: the datasource
# password fails closed when absent (D7), the demo ledger lags its schema so a booting flyway would try
# to apply unrecorded migrations as the unprivileged role (D331), and the jwt secret refuses to guess
# outside the dev profile - which is why the disable, not the profile's own flyway credentials, is what
# makes the boot work against the demo database (the profile's flyway user needs the root password).

.PHONY: help infra-up infra-down infra-logs db-reset db-migrate seed dev-web dev-ai dev-platform \
        test unit e2e up down logs status ps lint clean

help: ## Show this help
	@echo "NEXUS — available targets (Phase 1 path is infra-up -> db-migrate -> seed -> dev-*)"
	@grep -E '^[a-zA-Z0-9_.-]+:.*## ' $(MAKEFILE_LIST) \
	  | awk -F'## ' '{printf "  %-16s %s\n", $$1, $$2}' | sed 's/:$$//'

# ------------------------------------------------------------------ infrastructure
infra-up: ## Start postgres + redis only (the path that works today) and wait for health
	$(COMPOSE) up -d postgres redis
	$(COMPOSE) ps
	@i=0; until docker exec $(PG_CONTAINER) pg_isready -U postgres -d $(DB_NAME) >/dev/null 2>&1; do \
	  i=$$((i+1)); [ $$i -gt 60 ] && { echo "!! postgres not ready after 60s"; exit 1; }; sleep 1; done
	@echo "postgres ready on 127.0.0.1:$${NEXUS_PG_HOST_PORT:-5433}, redis on 127.0.0.1:$${NEXUS_REDIS_HOST_PORT:-6380}"

infra-down: ## Stop the data stores (keeps named volumes = data survives)
	$(COMPOSE) stop postgres redis

infra-logs: ## Tail logs of the data stores
	$(COMPOSE) logs -f --tail=100 postgres redis

db-migrate: ## Apply infra/db/migrations/*.sql in order, then bind role grants (idempotent)
	bash scripts/db_apply_migrations.sh

seed: ## Apply infra/db/seed/*.sql (tenant hong-kong only); the demo dataset is data/seed/load.sh
	bash scripts/db_apply_migrations.sh --seed

ai-embed: ## Fill chunks.embedding for the chunks that have none (RAG §2 worker; inspect with --dry-run, canary with --limit)
	cd apps/ai && NEXUS_DATABASE_URL='postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/$(DB_NAME)' \
	  bash -c 'command -v uv >/dev/null 2>&1 && uv run --no-sync python -m nexus_ai.rag.embed \
	  || python -m nexus_ai.rag.embed'

db-reset: ## DESTROY local data: drop nexus_pgdata, recreate, migrate, seed
	@echo "!! recreating the nexus database from scratch (volume nexus_pgdata is deleted)"
	docker rm -f $(PG_CONTAINER) >/dev/null 2>&1 || true
	docker volume rm -f nexus_pgdata >/dev/null 2>&1 || true
	$(COMPOSE) up -d postgres
	@i=0; until docker exec $(PG_CONTAINER) pg_isready -U postgres -d $(DB_NAME) >/dev/null 2>&1; do \
	  i=$$((i+1)); [ $$i -gt 90 ] && { echo "!! postgres not ready"; exit 1; }; sleep 1; done
	bash scripts/db_apply_migrations.sh --seed
	docker exec $(PG_CONTAINER) psql -U postgres -d $(DB_NAME) -tAc \
	  "SELECT 'tables='||count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"

db-verify: ## Table count, tenant row, HNSW index presence (no heredoc: works with any make)
	docker exec $(PG_CONTAINER) psql -v ON_ERROR_STOP=1 -U postgres -d $(DB_NAME) -tA 	  -c "SELECT 'base_tables='||count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'" 	  -c "SELECT 'tenants='||count(*) FROM tenants" 	  -c "SELECT 'hnsw='||count(*) FROM pg_indexes WHERE tablename='chunks' AND indexdef ILIKE '%hnsw%'" 	  -c "SELECT 'ai_reachable_tables='||count(DISTINCT table_name) FROM information_schema.role_table_grants WHERE grantee='nexus_ai'"

# ------------------------------------------------------------------ host-run dev services (Phase 1)
dev-web: ## Next.js dev server on :3002 (apps/web)
	cd apps/web && npm run dev -- --port $(WEB_PORT)

dev-ai: ## FastAPI dev server on :8010 (apps/ai, uv-managed venv, demo database)
	cd apps/ai && NEXUS_DATABASE_URL='postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/$(DB_NAME)' \
	  bash -c 'command -v uv >/dev/null 2>&1 && uv run uvicorn $(AI_APP) --reload --host $(AI_HOST) --port $(AI_PORT) \
	  || python -m uvicorn $(AI_APP) --reload --host $(AI_HOST) --port $(AI_PORT)'

dev-platform: ## Spring Boot dev server on :8090 (services/platform, Maven; the boot recipe D304 measured)
	cd services/platform && NEXUS_PORT=$(PLATFORM_PORT) NEXUS_DB_PASSWORD=nexus_dev_app_only \
	  SPRING_FLYWAY_ENABLED=false SPRING_PROFILES_ACTIVE=dev mvn -o -DskipTests spring-boot:run

# ------------------------------------------------------------------ tests
test: ## Unit + integration tests for every stack present in the tree
	@if [ -f package.json ]; then npm run test --if-present; fi
	@if [ -d apps/ai ]; then (cd apps/ai && (uv run pytest -q || python -m pytest -q)); fi
	@if [ -f services/platform/pom.xml ]; then (cd services/platform && mvn -q test); fi

unit: ## Fast unit tests only (no DB) — apps/ai suite
	cd apps/ai && (uv run pytest -q -m "not integration" || python -m pytest -q -m "not integration")

# The harness reads its three service URLs from the environment and falls back to the framework defaults,
# which are NOT this Makefile's ports. Export them here, derived from the *_PORT knobs above, so `make e2e`
# tests the stack `make dev-*` actually started. scripts/check_plane_coordinates.mjs is what keeps this
# recipe and those fallbacks from drifting apart again.
e2e: ## Playwright suites (needs infra-up + dev-web/dev-ai/dev-platform running)
	cd tests/e2e && NEXUS_WEB_URL=http://127.0.0.1:$(WEB_PORT) \
	  NEXUS_PLATFORM_URL=http://127.0.0.1:$(PLATFORM_PORT) \
	  NEXUS_AI_URL=http://127.0.0.1:$(AI_PORT) npx playwright test

lint: ## Lint/format checks where configured
	@npm run lint --if-present
	@if [ -f apps/web/package.json ]; then (cd apps/web && npm run lint --if-present); fi
	@if [ -d apps/ai ]; then (cd apps/ai && (uv run ruff check . || python -m ruff check .) || true); fi

# ------------------------------------------------------------------ full stack (profile: full)
up: ## Build + start ALL services; REQUIRES a Dockerfile in each of services/platform, apps/ai, apps/web
	$(COMPOSE) --profile full up -d --build
	$(COMPOSE) --profile full ps

down: ## Stop everything (default + full profile) and remove containers, keep data
	$(COMPOSE) --profile full down

logs: ## Tail all container logs
	$(COMPOSE) --profile full logs -f --tail=100

status: ## Show container health + host port bindings
	docker ps --filter "name=nexus-" --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'

ps: ## Raw compose ps
	$(COMPOSE) ps

clean: ## Remove build output (does not touch data volumes)
	rm -rf apps/web/.next apps/web/out dist coverage test-results playwright-report
	find . -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true
