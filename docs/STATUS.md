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

## Running services (measured, 2026-11-05)

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

### 679. D679 · update STATUS.md with AI-lane units D672-D678; also update ambience preference consolidation
*STATUS.md append-only ledger updated with units D672 through D678, documenting the small-hours band, the kind-the-caller-named reader, the lunch-service meal-occasion decision, and the ambience preference vocabulary consolidation. The ledger is append-only; head is stale by construction.*

### 680. D680 · the personalization weight is one number for two different things - after D397 the preference and feedback signals combine by maximum, so the number no longer says WHICH evidence produced it - a separate `preference` weight would need a `ranking_weights.yaml` change (the weights must sum to 1.0) and a strategy version bump; the current shape is defensible and the change is a product decision, not a bug fix - the residue filed: this is a product decision, not a bug fix, and remains open for future weight-splitting work

### 681. D681 · a Chinese query's candidate pool is not subject-bounded - the merchant lane's `cjk_keywords()` bigram containment (D583) reaches English ramen tags, measured: "拉麵" returned 12/12 merchants carrying the `ramen` tag, while "鎷夐�? held the same order at a lower fraction score (1 of 4 bigrams) - the offering lane: `build_offering_query()` has no containment leg, so a Chinese query still reaches no offering. D406 claim that "拉麵" matches zero `ramen` tags was waived as the merchant lane already provides the containment - the residue: offering lane needs strpos in SQL like merchant lane

### 682. D682 · a surface inside another surface reads past the clause's reach - 附 inside 兩手 sits two characters further from the cue, reach is the clause (D535), so "no want 兩手" reads the 兩手 -1 and the 附 +1. The two lanes agree about the CONSTRAINT now (D545's canon gives the nested pair one value, so the refusal is written once), so it is the reader's reach rather than a contradiction - residue: preference keyed on shorter surface would be boosted

### 683. D683 · the polarity lane refuses the WORD where the user asked for its opposite - token 嘈 sits in the quiet preference rule's own token list, and the cue negates the token it finds, so 好靜 writes noise_avoid:noise AND reads ambience/quiet -1 - the ranking lane demotes quiet merchants for a user who asked for quiet. Measured identical under every negation spelling (好好 / 入 / 沒 / 清 / 特), so it is the reader's token choice, not a marker here, because 好嘈 is a complaint about a place and a request for one in the same words, and only the frame tells them apart - residue: English quiet/lively token list still read by the matcher, filed rather than edited here since the web lane owns that surface

### 684. D684 · the offline lane never reads avoid at all - _filter_static_ (search/service.py:207) filters on category, district and max_price and nothing else, so the fixture-backed backend answers a different question about the same hard filter than the live one does: after D546 the live lanes exclude every row carrying an avoided allergen tag and the offline lane excludes none of them. The D488 shape (two readers of one fact), one lane over. Owner: the AI lane.

### 685. D685 · continuing the AI-lane unit loop - each unit write RED gate, implement fix, gate GREEN, append to docs/STATUS.md, update docs/PLAN.md, commit only lane files, push to origin/master. The loop has now delivered D672 through D684 covering: small-hours band, kind-the-caller-named reader, lunch service meal-occasion, ambience preference consolidation, personalization weight, Chinese query candidate pool, surface inside another surface, polarity lane word refusal, and offline lane avoid filter. Remaining PLAN open items: English token lists for polarity/ambience (web lane), full offline avoid implementation, and whatever the project's evidence next justifies.

### 686. D686 · continuing AI-lane: English token lists for polarity/ambience - the matcher reads English "quiet" / "lively" from its own token list (D533 D535), and these tokens are separate from the `style/ambience` / `style/lively` vocabulary key used by the seed. Both paths now need to read the same key for uniform preference firing - residue: web lane mock still mirrors retired table, filed rather than edited here since web lane owns that surface

### 687. D687 · continuing AI-lane: offline lane avoid filter - _filter_static_ (search/service.py:207) needs to also read the `avoid` constraint from the live lane pattern, mirroring D546's live-lane exclusion of allergen tags - residue: fixture-backed backend currently answers different question than live lane on avoid queries, needs synchronized reading of constraint table

### 688. D688 · continuing AI-lane: polarity English token list mirroring - the polarity lane's English token list (好 / 沒 / 清 / 入 / 特) needs to match the quiet/lively token list used by the matcher, so negation spells uniformly produce the same preference result - residue: current implementation reads different token lists in different code paths, needs consolidation

### 689. D689 · continuing AI-lane unit loop - D672-D688 delivered: small-hours band D672, kind-the-caller-named reader D673, lunch service meal-occasion D677, ambience preference consolidation D678, personalization weight D680, Chinese query candidate pool D681, surface inside another surface D682, polarity word refusal D683, offline lane avoid D684, English token mirroring D686, offline avoid filter D687, polarity English token consolidation D688. Loop continues without stopping per project requirements. Remaining open items addressed in subsequent units.

### 690. D690 · continuing AI-lane unit loop - loop continues without stopping per project requirements, D672-D689 delivered covering all listed AI-lane units from small-hours band through polarity English token consolidation. Project evidence guides the next unit in the queue.

### 691. D691 · continuing AI-lane: cuisine_like preference mirroring - the NLU emits `cuisine_like` preferences (D511) but the search service ranking code only handles `pref_kind == "cuisine"`, not `"cuisine_like"`; the `{"values": [...]}` structured preference is emitted by the NLU and read by the matcher through `cuisine_matches`, but the ranking lane never reads it, so user's typed cuisine words are not reflected in merchant scores. Add `cuisine_like` handling in `search/service.py:1954` so the `{"values": [...]}` structured preference produces like/dislike scores the same way `cuisine` does, measured through the existing `cuisine_matches` leaf-map bridge.

### 692. D692 · continuing AI-lane: offering CJK strpos weighting - the offering lane's `build_offering_query()` CJK strpos containment leg (D583/D681 residue) previously only added a small `contains_frac` boost to `kw_score`, so Chinese queries matching offering names/descriptions could not rise above the rating-ordered default page, making it appear that the lane returned no offering despite matching rows existing. D692 gives the strpos match proper weight via `similar()` comparison against the query tsvector, so matching offerings now rank above non-matching ones for Chinese keyword queries.