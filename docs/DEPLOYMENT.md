# NEXUS — deployment & runbook (infrastructure owner)

Contract inputs (binding): [DECISIONS.md](DECISIONS.md) D1–D8, [API_CONTRACT.md](API_CONTRACT.md) §0 (topology, ports,
DB role split), [DATABASE.md](DATABASE.md) §9 (grant detail), infra/db/migrations/V1__init.sql + V2__integrity.sql.
Machine reality: [ENVIRONMENT_REPORT.md](ENVIRONMENT_REPORT.md).

---

## 1. Topology (contract §0) vs. this machine

| Surface | Process / image | Contract port | Host port today | How it starts |
|---|---|---|---|---|
| `/api/v1/**` | Spring Boot `services/platform` (Java 25, Maven) | 8080 | 8080 | **host process** `make dev-platform` (or container under `--profile full`) |
| `/ai/v1/**`, `/mcp`, `/.well-known/ucp` | FastAPI `apps/ai` (Python 3.11, uv) | 8000 | 8000 | **host process** `make dev-ai` |
| `/**` | Next.js `apps/web` | 3000 | 3000 | **host process** `make dev-web` |
| data | `pgvector/pgvector:pg16` → container `nexus-postgres` | 5432 | **127.0.0.1:5433** | `make infra-up` |
| cache | `redis:7.4-alpine` → container `nexus-redis` | 6379 | **127.0.0.1:6380** | `make infra-up` |

5432/6379 are taken on this workstation by unrelated projects (`careeros-postgres`, `specproof-redis`) and 9200 by
`specproof-elasticsearch`, hence the offset ports. Override with `NEXUS_PG_HOST_PORT` / `NEXUS_REDIS_HOST_PORT`.
**Inside the compose network nothing changes**: services keep talking to `postgres:5432` / `redis:6379`.

## 2. Connection details (the exact working strings, verified 2026-09-22)

| Fact | Value |
|---|---|
| Postgres container | `nexus-postgres`, image `pgvector/pgvector:pg16`, **PostgreSQL 16.15**, **pgvector 0.8.6** |
| Host mapping | `127.0.0.1:5433 -> 5432/tcp` (loopback only) |
| Database | `nexus` |
| Superuser (dev) | `postgres` / `postgres` |
| Platform role | `nexus_app` / `nexus_dev_app_only` |
| AI role | `nexus_ai` / `nexus_dev_ai_only` |
| Redis container | `nexus-redis`, image `redis:7.4-alpine`, `127.0.0.1:6380 -> 6379/tcp`, AOF on, db 0 |

```text
platform (JDBC) : jdbc:postgresql://127.0.0.1:5433/nexus      user=nexus_app   password=nexus_dev_app_only
ai (asyncpg)    : postgresql://nexus_ai:nexus_dev_ai_only@127.0.0.1:5433/nexus
superuser       : postgresql://postgres:postgres@127.0.0.1:5433/nexus
redis           : redis://127.0.0.1:6380/0
in-compose DNS  : postgres:5432 / redis:6379   (re-verified 2026-10-26 from inside the running containers)
```

The in-compose names were re-checked on this stack's own network, `nexus-platform_default`: `psql -h postgres` from
the Postgres container resolves and answers `current_database() = nexus` over `172.24.0.3`, and `redis-cli -h redis`
from the Redis container answers `PONG`. The network named `nexus_default` on this machine belongs to another
product's container (see §6) and proves nothing about this one.

## 3. Phase 1 = host processes + containerized data stores

`infra/docker-compose.yml` ships all five services, but `platform`, `ai` and `web` carry `profiles: ["full"]` because
their source trees are being authored concurrently and have no Dockerfile yet. Consequences:

* `make infra-up` / `docker compose -f infra/docker-compose.yml --env-file .env up -d postgres redis` works today and
  **cannot** be broken by an unbuilt app service (profile-gated services are ignored unless `--profile full` is passed).
* `make up` (`docker compose --profile full up -d --build`) is the Phase-7 path. It requires, per service:
  `services/platform/Dockerfile`, `apps/ai/Dockerfile`, `apps/web/Dockerfile` in their build contexts. Today it fails
  with `failed to read dockerfile` — verified, see ENVIRONMENT_REPORT §7.
* Env plumbing for the full path is already written (JDBC/asyncpg URLs pointing at `postgres:5432`, `redis:6379`,
  `http://platform:8080`, `http://ai:8000`), so adding the three Dockerfiles is the only remaining step.

## 4. Daily commands (Makefile — every recipe is plain bash for Git Bash)

```bash
cp .env.example .env        # then set NEXUS_JWT_SECRET to any non-empty dev string
make infra-up               # postgres + redis, waits for pg_isready
make db-migrate             # V*.sql in order (single-transaction, ON_ERROR_STOP=1) + re-bind role grants
make seed                   # infra/db/seed/*.sql (idempotent)  -> tenant hong-kong
make db-verify              # table count, HNSW index presence
make dev-platform dev-ai dev-web   # one per terminal (host processes)
make test                   # npm/maven/pytest, guarded by directory presence
make e2e                    # Playwright (needs infra + the three dev servers)
make status / logs / infra-down / db-reset
make up / down              # profile "full" (needs the missing Dockerfiles)
```

`make` is not reliably available on this workstation (ENVIRONMENT_REPORT §3). GNU Make 4.x is required: the file uses
`.ONESHELL`, `SHELL := /usr/bin/env bash`, `$(MAKEFILE_LIST)` and 8-space `.PHONY` continuation. Every recipe body was
syntax-checked with `bash -n` after variable expansion and the data-path recipes were executed verbatim; if you have no
make, run the commands shown in each recipe directly.

## 5. Database: migrations, seeds, roles

* **Migrations** `infra/db/migrations/V1__init.sql`, `V2__integrity.sql` (additive constraints + one index),
  `V3__merchant_funnel_no_fanout.sql` (view rewrite), `V4__tenant_scoped_identity.sql` (identity uniqueness follows
  the tenant, D29). Applied by `scripts/db_apply_migrations.sh` in lexicographic order into
  `public.schema_migrations(version, applied_at)`; re-runs
  skip already-applied versions (`--force` re-applies, `--file <path>` applies one file). Each file runs
  `--single-transaction -v ON_ERROR_STOP=1`, and CRLF is stripped before piping (Windows checkouts).
  That script is the *infra* path and it connects as the superuser. The service also runs Flyway at boot — as the
  superuser in dev, never as `nexus_app`, which has no DDL on tables it must alter (D30) — and the two bookkeeping
  tables are separate (`schema_migrations` vs `flyway_schema_history`), which is why `--file` on a live database
  leaves Flyway unaware of it. There is a third state, a hand-built database with **neither** ledger (this is
  `nexus_test`, which runs with `spring.flyway.enabled=false`): a plain run there stops at `relation "tenants"
  already exists` rather than clobbering it, and names the repair — `--record V<n>__<name>` writes the ledger row
  and executes nothing, which is correct only after comparing the content against a migrated database (D32).
* **No psql on the host**: everything runs as `docker exec -i nexus-platform-postgres psql … -f -` (the image's
  client is the
  supported path) or `docker run --rm --network nexus-platform_default <image> psql -h postgres …` for network tests
  (the compose project is `nexus-platform`, not `nexus` — D22; `nexus_default` on this machine belongs to another
  stack's containers).
* **Seed** `infra/db/seed/00_tenant.sql` — idempotent, creates tenant **`hong-kong` =
  `00000000-0000-0000-0000-000000000001`** with `zh-HK`/`HKD`/`Asia/Hong_Kong`, the HK bbox + 17 districts and
  `config.demo = true`. Use that literal UUID in every fixture/test.
* **Roles** `infra/postgres/init/00_roles.sql` (also applied after migrations so grants bind to real tables):
  `nexus_app` = read-write on all commerce tables, `USAGE` on the schema and no `CREATE` (migrations are not its
  job — Flyway runs as the infra superuser in dev, D30/D32);
  `nexus_ai` = exactly the §0 lists — 11 SELECT-only commerce/taxonomy reads (`merchants, offerings, locations,
  reviews, business_hours, availability_slots, tenants, user_preferences, external_principals, categories,
  merchant_categories`), 14 read-write (`documents, chunks, facts, recommendation_sets, feedback_events, agent_runs,
  llm_calls, eval_suites/eval_cases/eval_runs, review_summaries, seo_pages, campaigns, coupons`) and `events`
  INSERT-only. §6 has the catalog query that counts them: **26 reachable where this file is applied to a
  from-scratch database, 25 on the live `nexus`** — `coupons` carries no grant there, so the live plane's grants are
  behind the file. Writes to `carts`/`users` and `CREATE TABLE` are denied by the role.
  New AI-readable tables need an explicit `GRANT` inside their migration — default privileges are **fail-closed** for
  `nexus_ai` on purpose (see ENVIRONMENT_REPORT §5.5 for the leak this rule prevents).
* **Extensions** are created by `infra/postgres/init/00_extensions.sql` on first boot *and* by V1 itself, so the
  migration is self-sufficient on a bare image.
* **Fresh-database gate** `scripts/db_gate_fresh.sh` — one command that proves the whole chain on an empty database:
  `CREATE DATABASE … TEMPLATE template0`, apply `V*.sql` + `00_roles.sql`, `python data/seed/generate.py`,
  `data/seed/load.sh` with `RESEED_DEPENDENTS=1`, run `data/seed/quality.sql` as a hard gate, drop the database.
  It exists because two defects were only reachable on that path (D33): a generated filename `load.sh` had never
  seen, and a seed directory stale enough to pass an existence probe. Refuses to run unless the target database is
  empty, and refuses the names `nexus`, `nexus_test`, `nexus_dev`, `postgres` outright; resolves the container by
  checking which candidate actually answers (`NEXUS_PG_CONTAINER` wins, then `nexus-platform-postgres`, then
  `nexus-platform-testpg` — this machine has seven containers on a Postgres image and only one of them answers on
  5433, §6). Its step 5 prints its own tally as `-> 217 quality checks passed against a from-scratch schema
  (tables=58, migrations=10)`; that is the line as measured on 2026-10-26. The whole 18-step run ends with a
  differently-phrased `RESULT: PASS — 217 quality checks on a from-scratch schema (tables=58, migrations=10), plus
  the …` — quote the one you actually ran, and note that a run on this machine on 2026-10-26 did not reach that
  ending: step 7 answered `NOT CHECKED — the shipped plane is not green (rc 1, control rc 1)` and the gate stopped
  with rc 2. Run `node scripts/check_jsonb_reads.mjs` and read its own reason lines before believing anything about
  *which* red stopped it. All three numbers move with the migration set, so read them from the gate's own summary
  line rather than from this document.
  Not wired into `make` yet (`Makefile` carries another stream's uncommitted edits).

## 6. Verification checklist for the next agent

Seven containers on this machine run a Postgres image, five carry a `nexus` name, and three are both — so neither the
name nor the image tells you which one is ours. The block below counts all three numbers instead of asking the reader
to trust this sentence. Every container in it is attributed — by the compose label
`com.docker.compose.project.config_files` for the ones a compose file created, and by five table names for the one
that has no labels at all — and every number it states was measured on 2026-10-26:

* **`nexus-platform-postgres`** — project `nexus-platform`, config file `infra/docker-compose.yml` (the file this
  repo ships), image `pgvector/pgvector:pg16`, running and healthy, publishes `127.0.0.1:5433 -> 5432`, superuser
  role `postgres`. **This is the instance the commands below target.** `infra/docker-compose.yml` declares exactly
  this `container_name`, so the compose name *is* the live name.
* **`nexus-platform-redis`** — same project and file, `redis:7.4-alpine`, `127.0.0.1:6380 -> 6379`. Our cache.
* **`nexus-redis`** — a *different product's* container: project `nexus`, config file
  `D:\内容创作平台\infra\docker-compose.yml`, image `redis:7-alpine`, on the `nexus_default` network.
  `docker exec nexus-redis redis-cli ping` answers `PONG` — which is how a checklist naming it could keep passing
  while testing the wrong stack. Its published port takes two sentences, because two fields of one `docker inspect`
  disagree about it: `HostConfig.PortBindings` — what the container was *created* to publish — says
  `0.0.0.0:56379 -> 6379`, while `NetworkSettings.Ports` — what the host is forwarding right now — says
  `{"6379/tcp":[]}` and a host-side connect to `127.0.0.1:56379` answers `ConnectionRefusedError` (measured
  2026-10-26, container `running` since 13:55Z the same day). An earlier draft of this bullet read only the second
  field and printed "no host port at all", which is a statement about the running state wearing a configuration's
  clothes; the block below prints both fields.
* **`nexus-postgres`** — zero compose labels (`docker inspect -f '{{len .Config.Labels}}'` prints `0`, and the JSON
  of the same field prints `{}`), so no compose file ever created it: this is a `docker run` container, `restart=no`,
  on the plain `bridge` network — which is why nothing inside `nexus-platform_default` can resolve it, and why
  "reachable as `postgres`" says nothing about this one. Its superuser role is `nexus`, so `psql -U postgres` gives
  `FATAL: role "postgres" does not exist`; it publishes `0.0.0.0:55100 -> 5432` — world-addressable, not loopback,
  and not the `:55433` this section used to claim. **Its name is ours from September and its contents are somebody
  else's now:** `infra/docker-compose.yml` declared `container_name: nexus-postgres` until commit `599cfce`
  (2026-09-23) renamed it to `nexus-platform-postgres`, and a foreign `docker run` took the freed name on
  2026-10-16T07:31Z. Its `nexus` database is 53 tables of another product's schema — `agents`, `api_tokens`,
  `design_nodes`, `marketplace_items`, `game_completions` — of which 48 appear in no `V*.sql` this repo ships and
  only 5 share a name with ours (`conversations`, `messages`, `moderation_cases`, `notifications`, `users`, a
  collision that says nothing about content). It holds **0** of the five table names a NEXUS schema must have, no
  migration ledger, and no `chunks` table at all — which is why the "no HNSW index on `chunks`" this bullet
  carried for one hour was vacuous: an index query over an absent table returns no rows whether or not the product
  uses vectors. It is not an empty container either: its `nexus_dbagent_scratch` is an *older* application of our
  own migrations — 57 tables, all five names present, `schema_migrations` with the three rows V1-V3, and a live
  `chunks_embedding_hnsw` — where `nexus_ai` reaches 24 tables against the `nexus` database's 0. Nobody owns this
  container according to any field `docker inspect` shows, so identify it by what its databases hold, not by its
  name or its image.

* **`nexus-platform-testpg`** — no compose labels, `Exited (137)` four weeks ago, `restart=unless-stopped`. Its
  config still maps `127.0.0.1:5433`, i.e. the live container's host port, so `docker start` on it now collides.
  Every `docker exec` against it fails with `Error response from daemon: container … is not running`; and because
  that goes to stderr, a pipeline like `psql -c "\dt" | wc -l` prints `0` — which reads as an empty schema, not as
  a dead container.

Every line of the block below that only *reads* may name any container — several must name the foreign ones,
because the contrast is the measurement. Nothing in the block changes state. State-changing recipes do have to name
ours: `docs/ENVIRONMENT_REPORT.md` §8's reset ran `docker rm -f` + `docker volume rm` against a container name that
is no longer ours, and §550 of the ledger is the unit that caught it.

```bash
docker ps --format '{{.Names}}\t{{.Ports}}'           # running containers and their host ports
docker inspect -f '{{.Name}} {{index .Config.Labels "com.docker.compose.project.config_files"}}' \
  $(docker ps --format '{{.Names}}')                   # ... and which project's file each came from
# live-world count: the three `docker ps` censuses below read this machine's container set, which other
# products change at will - one of them printed 7 in the morning and 6 in the afternoon of 2026-10-26,
# with nothing in this repo touched. Their annotations therefore name what the number counts and say it
# moves; they do not pin it. Every other integer in this block is this repo's own reading and does carry
# its value, because a carrier that goes red when the migration set grows is the point of carrying it.
docker ps -a --format '{{.Image}}' | grep -ciE 'postgres|pgvector'    # live-world count: how many
    # containers here run a Postgres image - 6 on 2026-10-26, of which one is this repo's live plane, one
    # a verification container this repo created, and four belong to other products
docker ps -a --format '{{.Names}}' | grep -c '^nexus'                 # live-world count: how many names
    # begin `nexus` - 5 on 2026-10-26, 2 of them Redis, and 3 of the 5 are not this repo's containers
docker ps -a --format '{{.Names}}\t{{.Image}}' \
  | awk '$1 ~ /^nexus/ && $2 ~ /pgvector|postgres/' | wc -l            # live-world count: how many are
    # both - 3 on 2026-10-26, i.e. this repo's two plus the foreign one wearing our September name
docker exec nexus-platform-postgres pg_isready -U postgres -d nexus
docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c "\dt" | wc -l   # 59 tables today
grep -hoiE '^create table( if not exists)? [a-zA-Z_]+' infra/db/migrations/*.sql \
  | awk '{print tolower($NF)}' | sort -u | wc -l                        # 57 of them declared by V*.sql
# The other 2 are `schema_migrations` (the infra path's ledger) + `flyway_schema_history` (the service
# boot's). Both counts move with the migration set, so match them against each other, not against this page.
docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
  "select indexname from pg_indexes where tablename='chunks' and indexdef ilike '%hnsw%'"   # chunks_embedding_hnsw
docker exec nexus-platform-redis redis-cli ping                          # PONG; 6380 belongs to this container
# the AI role's grant split, read from the catalog rather than from this document:
docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
  "with g as (select table_name, bool_or(privilege_type='SELECT') sel,
     bool_or(privilege_type in ('INSERT','UPDATE','DELETE')) wr
   from information_schema.table_privileges
   where grantee='nexus_ai' and table_schema='public' group by 1)
   select count(*) filter (where sel and not wr), count(*) filter (where wr and sel),
          count(*) filter (where wr and not sel), count(*) from g"
    # 11 read-only + 13 read-write + 1 append-only = 25 reachable on the live plane. `events` is the
    # append-only one: INSERT but no SELECT, so `INSERT ... RETURNING` is rejected there (§0). `coupons` is
    # NOT among the 25, although §0 and the vocabulary list in `infra/postgres/init/00_roles.sql` both make
    # it read-write; the same file applied to a from-scratch database gives 26, including `coupons`. The
    # live plane's grants predate that line, so `make db-migrate` (which re-applies `00_roles.sql`,
    # revoke-first and self-healing) repairs it.
# attribution: which of these databases IS a NEXUS schema? five names every one must have.
docker inspect -f '{{len .Config.Labels}}' nexus-postgres       # 0 compose labels => no compose file ever created it
docker exec -i nexus-postgres psql -AtU nexus -d nexus -c \
  "select count(*) from pg_tables where schemaname='public' and tablename in ('merchants','chunks','tenants','offerings','facts')"   # 0 of the five, on the container wearing our September name
docker exec -i nexus-postgres psql -AtU nexus -d nexus_dbagent_scratch -c \
  "select count(*) from pg_tables where schemaname='public' and tablename in ('merchants','chunks','tenants','offerings','facts')"   # 5 of the five, in that same container's older copy of our own migrations
docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
  "select count(*) from pg_tables where schemaname='public' and tablename in ('merchants','chunks','tenants','offerings','facts')"   # 5 of the five, on the live plane
docker exec -i nexus-postgres psql -AtU nexus -d nexus -c \
  "select count(*) from pg_tables where schemaname='public' and tablename='chunks'"   # 0: no `chunks` table exists there, so an index query over it measures nothing about vectors
awk 'NR==FNR{a[$0];next} {if($0 in a) s++; else f++} END{print f "|" s}' \
  <(grep -hoiE '^create table( if not exists)? [a-zA-Z_.]+' infra/db/migrations/*.sql | awk '{print tolower($NF)}' | sed 's/.*\.//' | sort -u) \
  <(docker exec -i nexus-postgres psql -AtU nexus -d nexus -c "select tablename from pg_tables where schemaname='public'")   # 48|5 — 48 names no V*.sql in this repo declares, 5 shared by coincidence
docker exec -i nexus-postgres psql -AtU nexus -d nexus_dbagent_scratch -c "select count(*) from schema_migrations"   # 3 rows (V1-V3): an application of our migrations from before V4, not the live plane
docker inspect -f '{{json .HostConfig.PortBindings}} {{json .NetworkSettings.Ports}}' nexus-redis   # 56379 in the config, [] in the live allocation — say which field you read
# from the AI service host process: the `nexus_ai` DSN §2 names reaches 127.0.0.1:5433/nexus, and the commerce
#   writes really are denied there — has_table_privilege('nexus_ai','carts','INSERT') and the same for `users` are
#   both false, and the role holds no CREATE on schema public or on the database.
```

## 7. Secrets policy actually applied here

* `.env.example` is the tracked template and holds **no** real credential: `NEXUS_JWT_SECRET=`,
  `NEXUS_LLM_API_KEY=`, `NEXUS_LLM_BASE_URL=`, model ids blank. `NEXUS_LLM_PROVIDER=mock` keeps every AI path offline
  and deterministic (D4); switching to a real provider is a local `.env` edit, never a commit.
* `.env` is git-ignored (verified with `git check-ignore`) and contains only localhost values. The dev DB passwords are
  published placeholders; a deployment injects real ones and re-runs `00_roles.sql` (idempotent, refreshes passwords).
* No payment credentials exist in the tree — `NEXUS_PAYMENT_PROVIDER=demo` and card data is never stored (§42).

## 8. What must happen before this is deployable for real

1. Three Dockerfiles (platform / ai / web) + a `--profile full` smoke test; `web` needs
   `PLATFORM_INTERNAL_URL`/`AI_INTERNAL_URL`, the other two need their DB/Redis URLs (already in compose).
2. ~~Decide the schema owner~~ — decided, and no longer open: `postgres` applies migrations and owns the schema,
   `nexus_app` holds `USAGE` with no `CREATE` and is never a migration role (D30, D32). What remains is the
   production half of that split: the deploy pipeline needs a migration credential that is *not* the runtime one,
   and `ALTER DEFAULT PRIVILEGES` (already in `00_roles.sql`) has to be re-verified against whatever role the
   managed Postgres instance makes the table owner — on a hosted instance that is often not the connecting user,
   and a default-privilege line keyed to the wrong role grants nothing, silently. The mechanics are in §5 above
   and in [ENVIRONMENT_REPORT.md](ENVIRONMENT_REPORT.md) §5 — its fifth numbered observation, the one about
   initdb-time versus migration-time SQL. The address this page carried for those two clauses, `§5.5` and `§5.3`,
   named headings that document does not have: its section 5 is a numbered list, not a list of subsections.
3. ~~Fix the §0 gaps before M3 or accept that three canonical tools are platform-routed~~ — the permission half of
   that closed while the sentence sat: measured on the live plane 2026-10-26, `nexus_ai` holds `SELECT` on
   `tenants`, `SELECT` on `user_preferences` and `INSERT` on `events` (the same list [ENVIRONMENT_REPORT.md](ENVIRONMENT_REPORT.md)
   §5 raised as its third observation). What is still true is the other half of that observation — no route
   dispatches those tools today, so they are platform-routed by absence rather than by grant.
4. TLS + Redis `requirepass`, a non-dev `NEXUS_JWT_SECRET` (RS256 in prod per D5), backups of the `nexus_pgdata`
   volume, and a `V*` migration for anything that changes the 1024-dim embedding contract (D3).
5. Playwright browser install (`npx playwright install chromium`) before `make e2e` can produce
   `tests/evidence/` screenshots — and a `tests/evidence/.gitkeep` so the folder survives the ignore rule.
