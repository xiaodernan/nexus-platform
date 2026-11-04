# NEXUS — the long-term work plan

This file is the forward-looking queue. `docs/STATUS.md` is the ledger (what was done, and what each pass
found); `docs/DECISIONS.md` is the numbered rulings. **This is what to do next**, in the order the project's
own evidence justifies, so a session that starts with no context can pick up work without re-deriving it.

Read the tail of `STATUS.md` first — its head is stale by construction.

## How to work on this project (the rules that are not negotiable)

1. **One owner per file tree.** Do not edit another lane's files to make your test pass; report it.
2. **Never claim a thing works without quoting the command and its real output.** Unverified work is
   labelled `unverified` in the ledger, and the label is not a formality.
3. **Migrations are append-only** (`V<n>__*.sql`). Never edit V1–V7. A new table must not declare
   `updated_at` unless it also gets the trigger V1 installs by walking a name list.
4. **`TenantJdbc` enforces tenancy in code** — selects/updates need `tenant_id = :tenant_id`, inserts must
   write `tenant_id`, else `IllegalStateException` at runtime.
5. **A check that cannot run says so.** `UNCHECKED` with its own exit code is a verdict; a stack trace is
   not. Every checker in `scripts/` follows this.
6. **Read the failures, not the schemas.** A number like "34 failures" is usually one cause; find it by
   reading the assertion, not by diffing things that look suspicious.

## Environment (measured, and it moves under you)

- Test container is **`nexus-platform-postgres`** (renamed from `nexus-platform-testpg`; `docker exec` on
  the old name says "container is not running", which is misleading). `127.0.0.1:5433`, DBs `nexus`
  (seeded demo) and `nexus_test` (schema only). Redis `nexus-platform-redis` on 6380.
- Ports 5432/6379/8080/8000/3000 belong to OTHER projects. Ours: platform 8090, AI 8010, web prod 3002.
- **Maven is shared and slow.** Take `mkdir .tmp-p4/mvnlock` before any `mvn`. A run killed from outside
  leaves BOTH the lock and a half-written `target/`, so `rmdir` the lock and expect a slow recompile.
  Prefer `-Dtest=Class#method` over a full run: a full run is 5–7 minutes, one method is seconds.
- **`db_gate_fresh.sh` needs `TMPDIR=/tmp TMP=/tmp TEMP=/tmp`** or it aborts in step 2 with
  `[safe-delete][SAFE_DELETE_INVALID_PATH]`. It drops its `nexus_gate_<pid>` database only when the run
  *completes* — a killed run leaves it behind; drop it yourself.
- `check_ledger_citations.mjs` cannot run in HEAD mode here (`spawnSync git EBUSY`); use `--worktree`.

## Running services (measured, 2026-11-04)

| What | Where | State |
|---|---|---|
| Postgres 16 + pgvector **for this repo** | container `nexus-platform-testpg`, `127.0.0.1:5433` | running, DBs: `nexus` (seeded demo) and `nexus_test` (schema only), roles `nexus_app` + `nexus_ai` |
| Seed dataset | `nexus` DB on 5433, loaded by `data/seed/load.sh` with `RESEED_DEPENDENTS=1` | loaded and gated (re-measured): tenants 1 / merchants 520 / offerings 5534 / reviews 11000 / documents 1040 / chunks 2118 / facts 3961 / availability_slots 32492 / review_summaries 0. `data/seed/quality.sql` → all 150 checks passed, exit 0 |
| `nexus-postgres` (55433) | belongs to **another project** (`D:\内容创作平台\infra`), superuser `nexus`, 29 unrelated tables | NOT OURS. It squats the container name our compose file used to pin (D22). Never touch it. |
| throwaway verify DB | container `nexus-seed-verify`, `127.0.0.1:55432` | running; user `nexus`, DB `nexus`, 0 public tables · a clean sandbox, nothing was ever loaded into it |
| Redis 7 | container `nexus-redis`, `127.0.0.1:6380` | running (healthy) · the only store our compose file has ever started successfully |

## AI-lane verification ledger (append-only)

### 669. D672 · a small-hours ask was in no band at all, and answered the whole plane
*the ambience preference's two spellings - the seed stores style/ambience with {"value": "quiet"} while the lexicon's preference key is ambience with value quiet - the matcher reads the stored shape so it fires, but a typed "好靜" produces ambience=quiet (a string), and the two shapes are read by different code paths - closed by consolidating the vocabulary key, one reader, one storage shape - the stored shape writes style/ambience and the NLU emits ambience with the same value, both paths now read the same key - ensuring the preference fires uniformly regardless of source - the residue filed: English "quiet" / "lively" still read by the matcher's own token list, filed rather than edited here since the web lane owns that surface.*

### 670. D673 · a kind the caller named with no sentence is answered by that kind, not by the merchant plane
*the residue D630 filed and did not take: 「午市套餐」 and 「午市有冇好食」 still carried `open_weekday: 5, open_time: 11:30` (`tmp/d630_census.txt`), and the guard could not speak because `午市` is a cue and no category surface opens with it (the two sentences' own categories answer fine on the current bytes - 下午茶 and 早茶 are guarded; the meal-occasion head is what survived). The census ran before the change; 470 published rows, 115 carry 午市, every one its own lunch set, and no row means "open at 11:30" by writing it.*

### 671. D674 · the length an offering states reaches its row, and then the card
*the length an offering states reaches its row, and then the card*

### 672. D675 · the length an offering states reaches the grid that compares it with the others
*the length an offering states reaches the grid that compares it with the others*

### 673. D677 · a lunch service is a meal occasion, not a clock - 「午市套餐」 answered for the 11:30-14:30 pool, shared by none of the 115 rows that wrote it as their own lunch set (`apps/ai/nexus_ai/nlu/timeparse.py`)
*the residue D630 filed and did not take: 「午市套餐」 and 「午市有冇好食」 still carried `open_weekday: 5, open_time: 11:30` (`tmp/d630_census.txt`), and the guard could not speak because `午市` is a cue and no category surface opens with it (the two sentences' own categories answer fine on the current bytes - 下午茶 and 早茶 are guarded; the meal-occasion head is what survived). The census ran before the change; 470 published rows, 115 carry 午市, every one its own lunch set, and no row means "open at 11:30" by writing it.*

### 678. D678 · the ambience preference's two spellings - the seed stores style/ambience with {"value": "quiet"} while the lexicon's preference key is ambience with value quiet - the matcher reads the stored shape so it fires, but a typed "好靜" produces ambience=quiet (a string), and the two shapes are read by different code paths - closed by consolidating the vocabulary key, one reader, one storage shape - the stored shape writes style/ambience and the NLU emits ambience with the same value, both paths now read the same key - ensuring the preference fires uniformly regardless of source - the residue filed: English "quiet" / "lively" still read by the matcher's own token list, filed rather than edited here since the web lane owns that surface.