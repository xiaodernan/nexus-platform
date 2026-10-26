# NEXUS — Environment audit (honest, as-measured)

Measured on **2026-09-22** on the development workstation for `D:\获客平台`, by the infrastructure agent.
Every claim below was produced by the command quoted next to it; nothing is inferred from the design docs.
Companion: [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Host + toolchain (as found)

| Component | Version found | Probe |
|---|---|---|
| OS | Windows 11 build **26200.9457**, shell Git Bash `MINGW64_NT-10.0-26200 3.6.5-22c95533.x86_64` | `cmd //c ver`, `uname -sr` |
| CPU / RAM | 16 logical CPUs (Docker Desktop VM: 16 CPUs, **7.66 GiB** allocatable) | `nproc`, `docker info --format '{{.NCPU}} {{.MemTotal}}'` |
| Git | `git version 2.52.0.windows.1` | `git --version` |
| Docker Engine | **29.1.3** (`build 29.1.3`), linux containers, Docker Desktop context | `docker --version`, `docker info` |
| Docker Compose | **v2.40.3-desktop.1** | `docker compose version` |
| Node.js | **v24.15.0** | `node -v` |
| npm | **11.12.1** (workspaces available) | `npm -v` |
| Java | **Temurin 25.0.1+8 LTS** (also a JDK 17 on PATH: `C:\Program Files\Java\jdk-17`) | `java -version` |
| Maven | **3.9.15** (`C:\Users\18414\scoop\apps\maven\current`) | `mvn -v` |
| Python | **3.11.1** (`C:\Program Files\Python311`; a 3.10 install also exists) | `python --version` |
| uv | **0.11.19** | `uv --version` |
| Misc present | `k6` (load tests), `gh` (GitHub CLI), ripgrep 15.1 | `command -v k6 gh` |

## 2. Container images available offline (no pull needed)

`docker images` shows the two NEXUS data stores already cached, plus engines we may enable later:

```
pgvector/pgvector:pg16                 621MB   <- Phase-1 database (D3): PG16 + pgvector 0.8.6
redis:7.4-alpine                        57MB   <- Phase-1 cache/session store
elasticsearch:8.13.4 / docker.elastic.co/...:8.16.4, kibana:8.13.4   <- cached, NOT used in Phase 1
python:3.11-slim, mysql:8.x, mongo:7.0, rabbitmq:4.0, confluentinc/cp-kafka:7.6.0, minio, zipkin
```

Runtime facts measured inside the started container: `PostgreSQL 16.15 (Debian 16.15-1.pgdg12+2)`,
`pgvector 0.8.6`, extensions installable in-image: `vector`, `pg_trgm 1.6`, `pgcrypto 1.3`, `citext 1.6`,
`btree_gist 1.7` — all five `CREATE EXTENSION` lines of `V1__init.sql` succeeded. No PostGIS (confirmed absent from
the image family, hence the bbox+haversine design in D3).

## 3. What is NOT available (and what that forced)

Verbatim probe:

```
$ for b in psql redis-cli make cmake pnpm yarn bun gradle opensearch gcloud; do
    command -v $b >/dev/null 2>&1 && echo "$b: PRESENT" || echo "$b: absent"; done
psql: absent
redis-cli: absent
make: absent          <-- !! the Makefile therefore documents the command surface, it is not executable here
cmake: absent
pnpm: absent
yarn: absent
bun: absent
gradle: absent
opensearch: absent
gcloud: absent
```

| Missing | Consequence / decision taken |
|---|---|
| **No `psql` client on the host** | All SQL runs **inside** the container: `docker exec -i nexus-platform-postgres psql -v ON_ERROR_STOP=1 -U postgres -d nexus -f -`. That container name is a correction, not a preference: when this line was written the compose file declared `container_name: nexus-postgres` and the command was right; commit `599cfce` (2026-09-23) renamed the service to `nexus-platform-postgres`, and a foreign `docker run` took the freed name on 2026-10-16. Left untouched, the command above now opens **another product's** database with a superuser that does not exist in it — measured 2026-10-26 as `FATAL: role "postgres" does not exist`. It fails loudly, which is more than the same mis-naming did in `docs/DEPLOYMENT.md` §6, where a `| wc -l` swallowed the reason and printed a clean `0`. `make db-migrate`/`db-reset`/`db-verify` and `scripts/db_apply_migrations.sh` are built around `docker exec`, and CRLF is stripped with `sed 's/\r$//'` before piping (Windows checkout safety). |
| **No `redis-cli` on the host** | `docker exec nexus-platform-redis redis-cli ping` for checks (the bare `nexus-redis` this row used to name is a *different product's* cache and answers `PONG` just the same — see `docs/DEPLOYMENT.md` §6 for how the two are told apart). Host-side reachability was proven with a raw socket from Python instead (see §7). |
| **No GNU `make` reliably on the PATH** (two mid-session invocations did reach a GNU-make-compatible binary and executed recipes; it is absent at end of session — do not assume it exists) | The `Makefile` is still the canonical, reviewable command surface (per the M0 deliverable) but cannot be executed on this box. Mitigations applied: `SHELL := /usr/bin/env bash`, `.ONESHELL:`, no bash-4-only syntax, every recipe is a single copy-pasteable bash command, so `make x` ≡ running `x`'s body in Git Bash. Every recipe line is now counted on the machine instead of remembered in this row: `awk 'index($0,"\t")==1{c++} END{print c+0}' Makefile` prints **47** tab-led physical lines, `awk 'index($0,"\t")==1 && substr($0,length($0))=="\\"{c++} END{print c+0}' Makefile` prints **9** of them continuing onto the next, so the file is **38** logical recipe lines as measured 2026-10-26 — the **42** this row carried was the same count on 2026-09-22, and the two figures move apart because recipes have since been split across continuations, which raises the physical count while lowering the logical one. All 38 were extracted with make's own tab/continuation rules and pass **`bash -n`** after variable expansion (`.ONESHELL` semantics, re-run 2026-10-26), and the data-path bodies (`infra-up`, `db-migrate`, `seed`, `db-reset` steps, `status`, `ps`) were additionally executed verbatim (§7). To use the Makefile: `winget install GnuWin32.Make` or `scoop install make` (needs `grep`/`awk`/`sed`, all already in Git Bash). |
| **No `pnpm`** (matches D1 §"npm workspaces") | `dev-web`/`test` use `npm run` / `npx`; no `packageManager: pnpm` pin may be introduced without breaking this machine. |
| **No `gradle`** | Platform build is Maven (D1), verified `mvn 3.9.15` + Java 25. |
| **No OpenSearch/Elasticsearch service for NEXUS, and no LLM/`docker-compose full` yet** | Phase 1 search is Postgres-only (tsvector + pg_trgm + pgvector + bbox) exactly as D3 states. A foreign project's Elasticsearch 8.16.4 (`specproof-elasticsearch`) owns host `9200` and answers `401 missing authentication credentials` — NEXUS must **not** assume it; if we ever enable a search engine, it needs a dedicated container on a free port (see §4). |
| **No LLM credential anywhere in the tree** | `grep -rInE 'sk-ant-|sk-[A-Za-z0-9]{20,}|x-api-key' docs infra scripts .env.example` → no matches. `NEXUS_LLM_PROVIDER=mock` is the default (D4); `NEXUS_LLM_API_KEY` / `NEXUS_LLM_BASE_URL` ship **blank** in `.env.example`. No doc may claim a live model while provider=mock. |
| **No `docker` service or CI runner here** | Verification is local-execution only; there is no pipeline yet to hide behind. |

## 4. Port conflicts found on this host (why NEXUS is on 5433/6380)

`docker ps` before bring-up showed unrelated stacks already publishing the canonical ports:

```
careeros-postgres   pgvector/pgvector:pg16   127.0.0.1:5432->5432/tcp
specproof-redis     redis:7.4-alpine         0.0.0.0:6379->6379/tcp
specproof-elasticsearch  ...                 0.0.0.0:9200->9200/tcp
```

Decision: NEXUS binds loopback-only on **`127.0.0.1:5433->5432`** and **`127.0.0.1:6380->6379`** (overridable via
`NEXUS_PG_HOST_PORT` / `NEXUS_REDIS_HOST_PORT`), so no other project is disturbed and nothing is exposed on the LAN.
`3000/8000/8080` were verified free and keep their contract ports (API_CONTRACT §0). In-network the services are still
`postgres:5432` / `redis:6379` — verified with a psql client attached to the `nexus_default` network.

## 5. Contract observations raised back to the lead

These were **found**, not assumed, and none was silently "fixed" by granting extra privileges:

1. **Migration file location.** At session start `V1__init.sql` sat at `infra/db/V1__init.sql` while
   `docs/DECISIONS.md` line 4 promises `infra/db/migrations/V1__init.sql`; the file is now at that documented path
   (relocation happened concurrently with my work — I applied and verified from there, and created
   `infra/db/migrations/` as part of the layout). **No SQL was edited**: V1 applies cleanly on PostgreSQL 16.15 with
   `ON_ERROR_STOP=1` on an empty database (first attempt, exit 0, zero `ERROR` lines), including the HNSW index on
   `chunks.embedding vector(1024)` — so the "fix the migration if it errors" branch of my brief never fired.
   `V2__integrity.sql` (docs pass, additive constraints) also applies cleanly in order.
2. `docs/DATABASE.md` §9 flags "GAP: V1 creates no roles and no GRANT/REVOKE — the split is only a convention" and
   allows either a `V2__roles_grants.sql` or an `infra/db` bootstrap. I implemented the bootstrap
   (`infra/postgres/init/00_roles.sql`, re-applied after migrations). Both follow-ups this row asked for have since
   happened, and re-checking them is cheap: `docs/DATABASE.md` §9 no longer carries the GAP flag and names
   `infra/postgres/init/00_roles.sql` as the thing that closes it, and the schema owner has been picked —
   `postgres` applies migrations and owns the schema, `nexus_app` holds `USAGE` with no `CREATE` and is never a
   migration role (D30, D32), recorded in `docs/DEPLOYMENT.md` section 8 item 2, not in a "§6.2": this row cited
   `DEPLOYMENT.md §6.2` since 2026-09-22, and DEPLOYMENT's §6 is a single checklist with no numbered subsections,
   so the address resolved nowhere (D557 re-aims it; default privileges were made **fail-closed for `nexus_ai`**).
3. **`nexus_ai` cannot serve three canonical tools as specified.** ~~API_CONTRACT §0 grants no access to
   `tenants`, `user_preferences` or `events`~~ — **answered on the live plane 2026-10-26, and from the shipped file
   rather than by drift**: `infra/postgres/init/00_roles.sql`'s read-only vocabulary contains `tenants` and
   `user_preferences`, its append-only clause grants `INSERT ON TABLE events` plus `USAGE, SELECT` on
   `events_id_seq`, and `information_schema.table_privileges` on the live `nexus` answers exactly that
   (`tenants|SELECT`, `user_preferences|SELECT`, `events|INSERT`, and `external_principals|SELECT` besides). So the
   permission half of this observation is closed and no decision is outstanding. Two things it got right are worth
   keeping in view: `set_user_preference` stays platform-routed *by design* — D19 made `user_preferences`
   read-only for the AI role so that one actor owns one table (`/api/v1/me/preferences`) — and `record_event`'s
   `INSERT`-without-`SELECT` still rejects `INSERT … RETURNING`, which is why the event writer mints its own id.
   The live reason none of the three can serve anything today is one layer up: `GET /ai/v1/tools` reports
   `implemented=False` / `registry_status="not_built"` for all of them (`apps/ai/nexus_ai/api/routes_system.py`),
   so there is no dispatch to grant past.
4. `data/seed/generate.py` + `seed_pools.py` (data agent, in progress) emit `data/seed/seed.sql`, which `make seed`
   does **not** apply (it only walks `infra/db/seed/*.sql`, currently just the tenant). A loading hook that already
   works: `bash scripts/db_apply_migrations.sh --file data/seed/seed.sql` (verified with `--file
   infra/db/seed/00_tenant.sql`). Decide in M1 whether the dataset becomes `infra/db/seed/10_demo.sql` (then
   `make seed` covers it) or gets its own `make seed-demo` target. **How it resolved (re-checked 2026-10-26):**
   neither option, and `data/seed/seed.sql` never existed — the generator writes a numbered directory
   (`ls data/seed/out/*.sql | wc -l` → 23 today) and `data/seed/load.sh` applies it. `make seed` still walks only
   `infra/db/seed/*.sql` (`ls infra/db/seed/*.sql | wc -l` → 1, the tenant), while that target's own help line
   promised "tenant hong-kong + demo fixtures" — the same defect one size smaller, and D557 corrected the line to
   name `data/seed/load.sh`.
5. **A privilege-leak bug I introduced and then fixed (measured, not hypothetical).** The first version of
   `infra/postgres/init/00_roles.sql` contained `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT
   SELECT ON TABLES TO nexus_ai`. Because initdb scripts run **before** `V1__init.sql` creates anything, that default
   applied to all 57 tables, so on the live container `nexus_ai` could `SELECT` from `users`, `carts`, `orders`,
   `payments`, `audit_logs` and `tenants` — which API_CONTRACT §0 does not permit:
   ```
   BEFORE: nexus_ai -> users=0 carts=0 payments=0 orders=0 user_preferences=0 tenants=1 audit_logs=0   (all allowed)
   AFTER : nexus_ai -> ERROR: permission denied for table users / carts / payments / orders /
                       user_preferences / tenants / audit_logs
           nexus_ai table grants now = 19 (6 read-only + 13 read-write, exactly §0)
   ```
   Fix: default privileges for `nexus_ai` removed (fail-closed: new tables are invisible to the AI role until a
   migration grants explicitly) and the file now starts its AI section with `REVOKE ALL ON ALL TABLES … FROM nexus_ai`
   before re-applying the §0 lists, which makes it self-healing regardless of execution order. Re-verified on a fresh
   volume with the init dir mounted (§7). Lesson recorded for other agents: **initdb-time SQL and migration-time SQL see
   different schemas**; anything grant-related must be re-applied after migrations.

## 6. Resulting architecture-of-record for Phase 1

* **Containerized:** PostgreSQL 16.15 + pgvector (`nexus-platform-postgres`) and Redis 7.4
  (`nexus-platform-redis`) on named volumes `nexus_pgdata` / `nexus_redisdata`, loopback ports, healthchecks,
  `restart: unless-stopped`. This line read `nexus-postgres` / `nexus-redis` until `599cfce` renamed the services and
  other products' containers took the freed names, so the two names above are the ones `infra/docker-compose.yml`
  declares today, not the ones this file first wrote — §3 carries the rename, and `docs/DEPLOYMENT.md` §6 carries how
  a container's name is attributed at all.
* **Host processes:** Next.js (3000), FastAPI (8000), Spring Boot (8080) via `make dev-*` — their Dockerfiles do not
  exist yet, therefore the compose services are gated behind `profiles: ["full"]` so the default path is unaffected.
* **SQL path:** `docker exec … psql` (no host client). Idempotent ledger table `schema_migrations`.
* **Secrets:** none committed; `.env` is git-ignored and holds localhost-only values; `.env.example` carries every
  variable with blanks where a credential belongs. `00_roles.sql` takes passwords from env with published dev
  fallbacks so a fresh clone boots with zero setup.
* **Offline determinism:** `NEXUS_LLM_PROVIDER=mock`, `NEXUS_PAYMENT_PROVIDER=demo`, `NEXUS_SEARCH_BACKEND=postgres`.

## 7. Verification log (executed 2026-09-22, key lines kept verbatim)

```text
# bring-up (default path)
$ docker compose -f infra/docker-compose.yml --env-file .env up -d postgres redis
 Container nexus-postgres  Started      Container nexus-redis  Started
$ docker ps --filter name=nexus-
 nexus-redis      redis:7.4-alpine         Up (healthy)  127.0.0.1:6380->6379/tcp
 nexus-postgres   pgvector/pgvector:pg16   Up (healthy)  127.0.0.1:5433->5432/tcp

# initdb ran the two bootstrap scripts (first boot, fresh volume)
$ docker logs nexus-postgres | grep -E 'initdb.d|created role|ERROR'
 running /docker-entrypoint-initdb.d/00_extensions.sql   CREATE EXTENSION x5
 running /docker-entrypoint-initdb.d/00_roles.sql
 NOTICE:  created role nexus_app
 NOTICE:  created role nexus_ai
 NOTICE:  skipping SELECT grant on merchants (table not created yet)   x6   <- idempotent by design

# V1 on an EMPTY database (throwaway container, init dir NOT mounted => extensions created by V1 itself)
$ docker exec -i nexus-infra-verify psql -v ON_ERROR_STOP=1 -U postgres -d nexus -f - < infra/db/migrations/V1__init.sql
 exit=0    ERROR lines: 0     (last lines: CREATE TRIGGER / CREATE VIEW / CREATE VIEW)
 # => NO edit to V1__init.sql was required for PostgreSQL 16; the "fix the migration if it errors" branch
 #    of the task did not trigger. (The file had meanwhile moved to the contract path infra/db/migrations/.)

# full script path on that empty database (now also carries V2__integrity.sql from the docs pass)
$ bash scripts/db_apply_migrations.sh --seed
 > apply V1__init  <- V1__init.sql
 > apply V2__integrity  <- V2__integrity.sql
 > apply   <- 00_roles.sql      NOTICE: created role nexus_app / nexus_ai
 > apply   <- 00_tenant.sql     00000000-0000-0000-0000-000000000001 | hong-kong | HKD | Asia/Hong_Kong | active
 tables=57  migrations=2  tenant hong-kong=1  exit=0
$ bash scripts/db_apply_migrations.sh --seed        # re-run
 = skip  V1__init (already applied)  = skip  V2__integrity (already applied)   tables=57   <- idempotent
$ docker run … -v <repo>/infra/postgres/init:/docker-entrypoint-initdb.d:ro pgvector/pgvector:pg16   # initdb order
 … same result (migrations=2, tenant=1) and nexus_ai is denied users/carts/tenants  <- leak fix verified

# schema + data state on the LIVE container
$ docker exec -i nexus-postgres psql -v ON_ERROR_STOP=1 -U postgres -d nexus -c '\dt'
 (57 rows)
 base_tables=56 from V1 (+ schema_migrations)   views=2 (v_merchant_funnel, v_north_star)   indexes=141
 total_rows_all_tables=0        <- before seeding
 tenants=1  merchants=0  chunks=0  users=0  orders=0  events=0   <- after `make seed`

# pgvector works end-to-end
$ ... CREATE TEMP TABLE _v (id int, embedding vector(1024));  -- 4 random + 1 duplicate-direction row
 stored dim=1024
 EXPLAIN (COSTS OFF) ... ORDER BY embedding <=> $0 LIMIT 3
   ->  Index Scan using _vec_probe_hnsw on _vec_probe
         Order By: (embedding <=> $0)                       <- HNSW actually used
 id | cosine_distance        1 | 0.000000   99 | 0.000000   3 | 0.990012   (temp table dropped)
 chunks_embedding_hnsw :: CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)   pgvector 0.8.6

# role split is enforced by the database, not by convention
 nexus_app -> INSERT/UPDATE/DELETE on merchants: INSERT 0 1 / UPDATE 1 / DELETE 1
 nexus_ai  -> SELECT merchants/locations/reviews/business_hours/availability_slots: OK
 nexus_ai  -> INSERT INTO carts   -> ERROR: permission denied for table carts
 nexus_ai  -> INSERT INTO users   -> ERROR: permission denied for table users
 nexus_ai  -> CREATE TABLE        -> ERROR: permission denied for schema public
 nexus_ai  -> chunks privileges   -> DELETE,INSERT,SELECT,UPDATE
 nexus_ai  -> distinct tables it can touch at all: 19  (6 read-only + 13 read-write = the §0 split exactly)
 compose DNS+auth -> psql -h postgres -U nexus_app: "tables=59"

# Redis
$ docker exec nexus-redis redis-cli ping
 PONG
$ python -c "…socket.sendall(b'PING\r\n') against 127.0.0.1:6380"
 port 6380: host-side reply b'+PONG\r\n'        <- host can reach the published port
$ python … connect 127.0.0.1:5433
 port 5433: TCP connect OK (postgres wire protocol listener)

# profile gating
$ docker compose ... config --services                       -> redis, postgres
$ docker compose ... --profile full config --services        -> postgres redis ai platform web
$ docker compose ... --profile full up -d --no-deps platform
 failed to solve: failed to read dockerfile: open Dockerfile: no such file or directory   <- expected (see §3)

# Makefile recipes: `make` is not on the PATH at end of session (see the note in §3), so the 42 logical
# recipe lines were extracted with make's own tab/backslash-continuation rules, variables expanded,
# wrapped for .ONESHELL semantics and syntax-checked; the data-path bodies were then run verbatim.
$ <extract recipe lines from Makefile, expand $(VARS) and $$> /tmp/recipes2.sh ; bash -n /tmp/recipes2.sh
 logical recipe lines checked: 42  ->  syntax failures: 0   (bash -n exit 0)
$ bash -c 'if [ -f package.json ]; then echo "would run: npm run test --if-present"; fi'
 would run: npm run test --if-present
$ bash -c 'cd apps/web && (node -e "require(./package.json).scripts.dev" && echo "would run: npm run dev -- --port 3000")'
 'dev': 'next dev -p 3000'
 would run: npm run dev -- --port 3000
 infra-up / db-migrate / seed / db-reset / status / ps bodies: executed as their exact docker+psql commands above
```

## 8. Leaving state + reproducibility

* Left **running and healthy** on 2026-09-22: `nexus-postgres` (127.0.0.1:5433) and `nexus-redis` (127.0.0.1:6380)
  with `migrations=2`, `tenant hong-kong=1`, all other tables empty, 19 reachable tables for `nexus_ai`. Those were
  *our* container names then — `infra/docker-compose.yml` renamed them to `nexus-platform-*` one commit later
  (`599cfce`, 2026-09-23), so this sentence is a dated record and not an instruction; reading it as one is what
  made the third bullet below dangerous. The temporary verification container `nexus-infra-verify` was removed and
  appears in no `docker ps -a` on 2026-10-26. No secret or credential was committed; `.env` is git-ignored
  (`git check-ignore .env` → hit) and carries a randomly generated 64-char dev `NEXUS_JWT_SECRET`.
* **The same leaving-state sentence, re-measured 2026-10-26** — "leaving state" is the first thing a new agent
  reads as "current state", so it is restated with the commands that print it:

  ```bash
  docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
    "select count(*) from pg_tables where schemaname='public'"                    # 59 tables in the live nexus
  docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c "select count(*) from schema_migrations"   # 2 rows: V1 + V2, the infra applier's ledger
  docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c "select count(*) from flyway_schema_history" # 8 rows: V2 through V9, the service boot's ledger
  ls infra/db/migrations/V*.sql | wc -l                                            # 10 migration files on disk
  docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
    "select count(*) from pg_indexes where indexname='facts_subject_id_idx'"      # 1: V10 is applied, and recorded in NEITHER ledger
  docker exec -i nexus-platform-postgres psql -AtU postgres -d nexus -c \
    "select (select count(*) from merchants)||'/'||(select count(*) from offerings)||'/'||(select count(*) from reviews)||'/'||(select count(*) from chunks where embedding is not null)"   # 528/5546/11000/2118 seeded rows, every chunk carrying an embedding
  ```

  The `migrations=2` half has aged worst: 2 + 8 rows cover V1-V9 while the file set is 10 deep and V10's index is
  live, so the plane runs one migration *ahead of both of its own ledgers* — two appliers, two ledgers, neither
  recording what the other did (filed, not repaired here). `nexus_ai` reaches 25 tables today; the split and the
  catalog query that prints it are in `docs/DEPLOYMENT.md` §6, which is where those numbers have a reader.
* Files owned by this work stream: `infra/docker-compose.yml`, `infra/postgres/init/{00_extensions,00_roles}.sql`,
  `infra/db/seed/00_tenant.sql`, `scripts/db_apply_migrations.sh`, `Makefile`, `.env.example`, `.gitignore`,
  `docs/DEPLOYMENT.md`, this file.
* Reproduce from scratch in ~30 s: `docker compose -f infra/docker-compose.yml --env-file .env up -d postgres redis`
  → `bash scripts/db_apply_migrations.sh --seed` → `docker exec nexus-platform-redis redis-cli ping`. Add
  `--force` to that script to re-apply migrations, or `docker volume rm nexus_pgdata` (after `docker rm -f
  nexus-platform-postgres`) for a true reset — which is exactly what `make db-reset` does, step by step.
  **Both container names in that recipe are the point of this bullet:** as shipped they read `nexus-redis` and
  `nexus-postgres`, and on 2026-10-26 those names belonged to *other products'* containers — so the `ping` checked a
  cache that is not ours, and `docker rm -f nexus-postgres` was a documented, copy-pasteable instruction to destroy
  somebody else's database. A volume name does not rot the same way: `nexus_pgdata` is pinned by this repo's
  compose file (`volumes:` → `name: nexus_pgdata`), which is the difference between a name a container happens to
  wear and a name a tracked file declares. The Makefile never had this defect, and the reason is a spelling: its
  reset is `docker rm -f $(PG_CONTAINER)`, with `PG_CONTAINER ?= nexus-platform-postgres` declared at the top of
  the file, so `599cfce`'s rename reached one line and every recipe followed it. A literal name in prose and a
  variable in a recipe are not the same kind of statement — only one of them is a copy of something that already
  moved. The judging leg now reads the Makefile's own write surface the same way: it expands each recipe's
  variables from the file's bytes, classifies each line read-only or state-changing without running it, and
  requires every name a *write* resolves to be one this repo's compose file declares and every volume it
  destroys to be one its `name:` pins.
* **apps/ai venv hazard on this host (measured 2026-10-23, D515): the project must never be installed
  editable into the venv.** `site.py` reads `.pth` files with the LOCALE encoding (Python 3.11's
  `addpackage`: `io.TextIOWrapper(io.open_code(fullname), encoding="locale")`), and this repository lives
  at `D:\获客平台` - a path the GBK locale cannot decode - so the moment `uv run`/`uv sync` installs the
  project (`_editable_impl_nexus_ai.pth`), every `.venv\Scripts\python.exe` dies at startup with
  `UnicodeDecodeError: 'gbk' codec` before a single test runs. `PYTHONUTF8=1` does not help (the encoding
  is explicit). Recovery: delete the `.pth`. Prevention: `uv run --no-sync ...`, or invoke
  `.venv\Scripts\python.exe -m pytest` directly (`-m` puts the working tree on `sys.path`, so
  `nexus_ai` is imported from the source, never from a stale copy). The Makefile's `ai-embed` target is
  written in the `--no-sync` form for this reason; CI is unaffected (Linux paths are ASCII). Also note
  the repo carries no committed `apps/ai/uv.lock`, so an un-`--frozen` sync re-resolves and can churn
  the venv (that is how a stale `pydantic-core` half-install once wedged it).
