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

## The queue (re-derived 2026-10-17 from the ledger tail; the old P1-P4 block lives in the run log's dated entries)

### Open, waiting on the owning lane

- **The web surface's home page throws when every rail fails** — the data layer degrades on partial
  failure and throws on all-fail; the one-line shape is named in D318, and six of the e2e suite's ten
  reds inherit it. Owner: the web stream.
- **The e2e test markers** — the harness waits on nine data-testid names the rebuilt surface does not
  print (D328's census); the surface's owner either re-adds the markers or consents to the
  route-contract selectors the rewrite already uses (D329). Owner decision, harness lane consents.
- **The review-aspect census's threshold** — 16.7% was a dead-spelling artifact and the real coverage
  is 68.3% (D359's fix landed); the 60% threshold now sits below reality and the seed lane owns the
  calibration question.
- **The natural-language quality** — a Chinese sentence returns the honest empty state where a keyword
  returns eight cards (§12 kept, §141 unmet); owner: the AI lane's extraction and fallback.
- **The name-drop fix** — the 09-22-era probe asserted a claim the contract does not make; filed with
  the witness shape. Owner: the web stream.
- **The readability floor** — live text measures 4.477:1 against the 4.5 AA bound the visual test
  asserts. Owner: the web stream.

- **A surface inside another surface reads past the clause's reach** - "煙" inside "二手煙"
  sits two characters further from the cue, and the reach is the clause (D535), so "no want 二手煙"
  reads the 二手煙 -1 and the 煙 +1. The two lanes agree about the CONSTRAINT now (D545's canon
  gives the nested pair one value, so the refusal is written once), so it is the reader's reach
  rather than a contradiction - but a preference keyed on the shorter surface would be boosted by
  a sentence that refuses the longer one. No preference rule names 煙 or 吵 today, which is why
  the residue is unreachable in production rather than merely unmeasured.
  Owner: the AI lane.
- **The declarations are checked by name, not by sentence** - the doc gate's exemption
  tables are green as long as a judged document still puts the name in backticks, whatever
  the sentence now says about it: measured, `docs/AI.md` describes the planner
  (`orchestrator/planner.py`) in the present tense under a declaration that says it is not
  built yet (D542). Only a reader of the sentence could see the claim flip.
  Owner: the AI lane.
- **The four negations only the constraint table carries split the two lanes** - **closed by
  D579**: the four joined `NEGATION_CUES`, `_CONSTRAINT_NEGATIONS` is that list, and the two
  lanes now locate a refusal through one `negation_positions`; "海鲜 避免" writes the constraint
  and reads the cuisine -1. The half that was not a vocabulary patch is the word boundary:
  別 and 少 are one character and the tail of 特別 / 最少 / 多少, so `NEGATION_COMPOUNDS` keeps a
  cue inside a longer word from refusing anything - measured before it, "特別辣的餐廳" wrote
  `cuisine_avoid:spicy`, filtering out the spice the user asked for. Owner: the AI lane.
- **The polarity lane refuses the WORD where the user asked for its opposite** - the token
  嗜 sits in the quiet preference rule's own token list, and the cue negates the token it
  finds, so "唔好嗜" (do not be noisy) writes `noise_avoid:noise` AND reads the
  preference `ambience/quiet` **-1** - the ranking lane demotes the quiet merchants for a
  user who asked for a quiet one. Measured identical under every spelling of the negation
  (唔好 / 兇 / 無 / 没 / 沒), so it is the reader's token choice rather than a
  vocabulary hole. Owner: the AI lane.
- **The offline lane never reads `avoid` at all** - `_filter_static`
  (`search/service.py:207`) filters on category, district and max_price and nothing else, so
  the fixture-backed backend answers a different question about the same hard filter than the
  live one does: after D546 the live lanes exclude every row carrying an avoided allergen
  tag and the offline lane excludes none of them. The D488 shape (two readers of one fact),
  one lane over. Owner: the AI lane.
- **`smoking`, `noise` and `queue` name no tag the corpus writes** - the constraint lane
  reads and the canon spells them (D545), the planner now carries them (D546), and the avoid
  clause excludes nothing: measured on the live corpus, `avoid=["smoking"]`,
  `avoid=["noise"]` and `avoid=["queue"]` each removed 0 of 470 published merchants. The
  corpus DOES record a noise fact - `attributes.weak_aspects` can name `noise` and
  `quiet_ambience` is written from the same aspect - so the refusal has a row to point at;
  nothing reads it yet. Owner: the AI lane.
- **`onion`, `ginger` and `coriander` are named by the diet rule and absent from the corpus's
  allergen vocabulary** - the corpus writes gluten, soy, dairy, egg, shellfish, fish, nuts,
  chili, sulphite, mollusc, pork, garlic, sesame, coconut, peanut, herb and pepper, and none
  of the three. They therefore exclude only what their spelling matches in an offering's
  name: measured, 6, 33 and 0 of 470 published merchants. Owner: the AI lane.
- **`meat` is in no table at all** - "no meat" writes no constraint and no preference, though
  the corpus carries the vegetarian merchants the refusal points at. The cuisine bridge maps a
  word to the taxonomy's leaves (D394); "meat" has no entry to map.
  Owner: the AI lane.
### Open, waiting on the AI lane (next)

- **The `food/cuisine_like` structured preference is read by the matcher but not produced by the NLU** — the seed stores `{"values": ["cantonese","sushi"]}` under `food/cuisine_like`, and the category inference reads it, but a typed "我想食粵菜" produces a `cuisine` preference (a string value) rather than a `cuisine_like` one (an object with `values`). The two shapes now MEET at the matcher (D394 routes both through `cuisine_matches`), but they do not meet at the WRITER: a typed cuisine is not stored anywhere, so the user's own words about a cuisine are not recorded as a preference.
- **The `ambience` preference's two spellings** — the seed stores `style/ambience` with `{"value": "quiet"}` while the lexicon's preference key is `ambience` with value `quiet`. The matcher reads the stored shape, so it fires; but a typed "安靜" produces `ambience=quiet` (a string), and the two shapes are read by different code paths. Worth one vocabulary decision rather than two readers.
- **The seeded merchants carry no `vegetarian` attribute** — **closed this session by D559**: the seed writes the boolean attribute `cuisine_vegetarian` (`m["leaf"] == "vegetarian"`) and the stored-preference branch now reads it, so the declared vegetarian preference fires on the attribute the seed writes and the full-suite attribute gate went green.
- **The `personalization` weight is one number for two different things** — after D397 the preference and the feedback signals combine by maximum, so the number no longer says WHICH evidence produced it. A separate `preference` weight would need a `ranking_weights.yaml` change (the weights must sum to 1.0) and a strategy version bump; the current shape is defensible and the change is a product decision, not a bug fix.
- **The `weak_aspects` attribute is a LIST, not a boolean** — **closed by D581**: the
  preference matcher now reads the list as a set (`kind == "weakness"`), so a declared
  preference naming `noise` scores the 15 merchants weak at noise 0.200 against 0.800 for the
  rest of the live plane. Two residues were filed by that unit: the empty list is read as
  strength (352 of 470 rows carry none), and nothing PRODUCES a `weakness` preference — the
  sentence "唔好嘈" still writes `noise_avoid:noise` as a constraint, whose reader is the next
  unit's question.
- **A Chinese query's candidate pool is not subject-bounded** - **half closed by measurement
  in the 2026-10-28 session**: `cjk_keywords()`'s bigram containment in
  `apps/ai/nexus_ai/search/sql.py` DOES reach the English tags on the merchant lane - measured on
  the live plane, "拉麵" returned 西海 / 祥甬餐室 / 鼎埔小廚 / 祥軒 / 西棧 and all 12 merchants in that
  result carry the `ramen` tag, while "我想食拉麵" held the same order at a lower fraction score
  (1 of 4 bigrams). The open half is the OFFERING lane: `build_offering_query()` has no
  containment leg, so a Chinese query still reaches no offering. The D406 claim that 拉麵 matches
  zero `ramen` tags was measured against a plane the re-seed has since replaced.
- **The compare grid's row LABELS are raw attribute keys** — the rows are fact-backed (`price`, `rating`, `category`, `district`, `open_state`, `distance`) but the labels are the keys themselves; the surface that prints them is the web lane's (`packages/ui/src/trust/CompareTable.tsx`), reported and not edited here.
- **The corpus's tags are English** - the merchant lane's bigram containment closes the ask
  (see the item above, re-measured in the 2026-10-28 session); what is still open is a
  translation layer for the OFFERING rows, which carry no CJK at all and are read by a query with
  no containment leg.
- **The open state's `opens_at`/`closes_at` are TIME strings, the contract declares them datetimes** — `compute_open` produces "18:00" ✓ and `OpenState` declares `Optional[datetime]` ✓, so the card cannot pass them through ✓ (a validation error ✗) and the `closes_hhmm` the computation produces is dropped by the contract's model ✗. Which of the two shapes is right is a contract question — "closes at 18:00" is a time of day ✓, not an instant ✓, and `as_of` already carries the instant ✓ — so it is not decided in the AI lane's files.
- **Three ledger sections are invisible to the readers** — the sibling lane's D425/D426/D427 landed as `## 419 · D425 · …` (the number before a MIDDLE DOT), while the readers' pattern is `^## (\d+)\. ` (a number, a DOT, a space) ✓. So `check_ledger_sections.mjs` does not count them ✓, its duplicate-number check does not cover them ✓, and a future section could take 419/420/421 without the reader noticing ✗. Reported, not edited: those are the sibling lane's sections ✓. The format that works is `## 419. D425 · …` ✓ (as this lane's sections are written ✓).
- **The live demo corpus was never wrong** — D403's claim that "54 merchants' descriptions carry 餐庁" was itself a code-point mistake: the corpus has always carried 餐廳 (U+9910 U+5EF3), and the 54 are the CORRECT word. D414 withdrew the claim with the measurement (the corpus has 54 of U+9910 U+5EF3 and 0 of U+9910 U+5EF6). No re-seed is needed; the item is closed.
- **The live demo plane's corpus predates the seed generator** — D419 measured it: 0 of the plane's 500 published rows carry `date_occasion` (the generator learned to write it in D383), so the occasion preferences are understood and then do nothing there, and the personalization signal reads 0.5 (neutral) instead of 1.0. The re-seed is the seed lane's call — on a shared plane the load truncates the AI lane's own 968 `agent_runs` rows and the platform's demo rows, and the `nexus_ai` role cannot even read those tables to tell whether they hold anything. The recipe (measured on a throwaway database in D419): `python data/seed/generate.py --counts <n>` then the `data/seed/out/*.sql` files applied in order with `--single-transaction`. **D422 showed why it matters**: the lane's live suite was green on the stale plane and failed four times on a plane seeded from the current generator.
- **The seed's Chinese text could be checked against the canonical table** — D418 measured that 0 of the 470 published rows hold a character the canonical table changes, so the corpus is entirely in the standard forms ✓. The seed's GENERATOR is the other half: it writes the vocabulary the product's matchers read ✓ (D419's table), so both sides are checked — but nothing checks that automatically, and a generator change that dropped an attribute would take the preference with it.
- **The polarity lane reads the LIKE of an antonym as the LIKE of the value** - 嘈 is in the
  `ambience/quiet` rule's own token list, so "嘈的餐廳" (a noisy restaurant) writes
  `ambience/quiet +1` and the ranking boosts the quiet merchants for the user who asked for the
  noisy ones; "太嘈" and "特別嘈的餐廳" measured the same. D570 gave the lane the inversion for a
  REFUSAL of the opposite (唔好嘈 wants quiet, so -1 becomes +1); the mirror half - a LIKE of the
  opposite is a DISLIKE of the value - is not written, and it cannot be a bare sign flip, because
  a QUESTION about the opposite ("有冇嘈") must stay neutral-to-positive (D533). Owner: the AI
  lane.
- **`scenic_view` is nearly dead in the corpus the product is served from** - the seed derives it
  from `SCENIC_LEAVES` (the hotel leaves plus `seafood-grill`) times a 0.3 coin, and the live
  plane carries it True on 10 of 520 merchants; at the seed gate's smallest scale (60 merchants)
  it is now 0, which is why `test_the_seed_derives_preferences_from_leaves_the_taxonomy_writes.py`
  is red on a tree that touches nothing but `data/seed`. The preference the NLU emits for 海景 /
  維港 / 景觀 / 山景 / 天台 / rooftop - the archetypal Hong Kong ask - can be satisfied by 1.9% of the
  plane. Owner: the AI lane with the seed lane.
- **The vector lane retrieves nothing on the demo plane, and the run log says otherwise** - the
  plane `nexus-platform-postgres` / `nexus` serves the AI on has `chunks=2118, embedded=0`
  (measured twice this session), while this plan's own 2026-10-27 entry records "2118 of 2118
  chunks carry a vector, `hashing`, one stamp" and a 48-row non-zero `vec_score` witness. A
  re-seed after that entry truncated the chunks; the strategy string the API still answers with
  says `hybrid_v1+postgres+vector`. Either the pass runs again (`make ai-embed`) or the strategy
  string stops naming a lane that ran nothing - the honesty rule (unverifiable is rendered
  unverified) points at the second being the contract and the first being the product.
  Owner: the AI lane.

### Completed this session (AI lane)

- **D379** Pin DB seam pure guards (`db/pool`, §0/D3/§105) — 33 tests added, 608 passed
- **D380** Pin shared HTTP shapes (`contract`, API_CONTRACT §2/§7.1) — 29 tests added, 637 passed
- **D381** Fix Chinese sentence empty page (soft preference → hard filter) — 8 tests added, 645 passed
- **D382** Pin user preferences into personalization ranking — 6 tests added, 651 passed
- **D383** NLU intent preferences feed personalization ranking — seed data aligned, 651 passed
- **D384** Structured preference value matching for arrays/objects (budget, location, style, accessibility, cuisine) — 5 tests added, 657 passed
- **D385** Fix empty query `text_matched` flag and update home rails sort preference — 1 test fix
- **D386-D390** Complete preference matchers for all NLU keys (occasion, view, access, price_sense, weather, time_pref, cuisine, style) — 14 tests added, 668 passed
- **D391** Category inference from the resolved signals (`nlu/understand`) — 18 tests added, 686 passed
- **D392** The card names the preference that matched (`search/cards`) — 7 tests added, 693 passed
- **D393** A negated preference is a dislike, not a like (`nlu/polarity`) — 16 tests added, 709 passed
- **D394** The cuisine the user names and the cuisine the seed writes are two vocabularies (`nlu/lexicon`) — 5 tests added, 714 passed
- **D395** The "X-style" form is how a HK user asks for a cuisine (`nlu/lexicon`) — 14 tests added, 728 passed
- **D396** Typed vs declared preferences on the card, and a favourite pointing at an unopenable offering (`search/cards`, `data/seed/generate.py`) — 8 tests added, 736 passed
- **D397** The better evidence wins: a declared preference is not diluted by a weak history (`search/service`) — 6 tests added, 742 passed
- **D398** The live-DB proof of the Chinese-sentence chain became a gate, and the CI job that runs it (`apps/ai/tests/test_live_preferences.py` + `.github/workflows/ci.yml`)
- **D399** The product's own e2e sentence crashed the search with a 500 (`search/service` + `search/sql`) — the open-at-time filter bound a string to a `time` column
- **D400/D401** The product's own non-negotiable rules, checked on the live plane; the comparison grid had no distance row and no district row (`apps/ai/tests/test_live_ai_contract.py`, `api/routes_discover`)
- **D403** The RAG retrieval could not find a Chinese chunk, and the corpus plainly has one (`search/sql` + `api/routes_rag`) — the trigram lane
- **D405** The merchant agent handed off every question, and its grounded branch had never run (`search/tokens` + `api/routes_rag` + `api/routes_stream`) — the containment is the evidence, not the score
- **D406** The order the user's own words named was written down and never read (`search/ranking` + `search/service`) — the reader, with the sponsored slot still placed after it
- **D407** A Chinese query could not reach the merchants it names (`search/sql` + `search/tokens`) — the containment lane, on the merchant pool
- **D408** The CI's lint step named two tools the project did not have, and the type gate had never run (`apps/ai/pyproject.toml` + the findings) — the rule set is now stated in the repo and both gates are green
- **D409** The platform's Chinese word for "restaurant" was the Japanese variant, so 餐廳 matched nothing (`nlu/lexicon` + the seed + the tests) — one character, 45 lines, and the answer stops being a nail salon
- **D411** The merge gate that could not start, and the five gaps it found the moment it did (`nexus_ai/eval` + `nlu/lexicon` + `nlu/understand`) — the eval package exists, both suites hold, and the case files are written with explicit code points
- **D414** The code points were the defect, not the words: §403's finding is withdrawn and its change is reverted — the Unihan database is the oracle, and the vocabulary's characters are pinned
- **D416** The vocabulary had 19 terms with no traditional spelling, so a Hong Kong user typing them got nothing (`nlu/lexicon`) — every term now answers to both spellings, and the traditional forms were verified against the character, not against the Unihan mapping
- **D417** The vocabulary and the user wrote the same word in two spellings, and a string comparison is by code point (`nlu/canonical` + `nlu/lexicon`) — 95 characters canonicalised on BOTH sides, with a rule that rejects the glyph variants the Unihan links contain
- **D418** The query that is matched against the corpus is now the canonical form, and it can only add matches (`search/service` + `api/routes_rag`) — the measured half of D417: 470 corpus rows, 0 of them hold a changeable character
- **D419** The demo plane's corpus is older than the seed generator, so the preferences the product understands do nothing there (`apps/ai/tests/test_live_personalization_signal.py`) — the signal measures 0.5 (neutral) on the live plane and 1.0 on a plane seeded from the current generator
- **D420** The canonicalisation swallowed the locale detection: a Simplified Chinese user was answered in the Traditional locale (`nlu/lexicon` + `nlu/understand`) — the normalisation keeps the user's own spelling again, and the canonical form is used only where the vocabulary is compared
- **D421** The second turn's cues answer to one spelling only: 近一點 matched nothing while 近一点 did (`nlu/state_merger` + `nlu/canonical`) — the merge cues are a SECOND vocabulary, and the canonical table now covers every Chinese character in the product's own sources
- **D422** A merchant whose hours omit the queried weekday was shown as UNKNOWN, and the comparison table had a hole in it (`search/cards`) — "no hours at all" and "not open today" are different claims, and the live suite was calibrated against a stale corpus
- **D428** The card's fact references: the contract's `source_fact_id` was always null (`search/cards`) — the open state and the availability brief now point at the facts the card already carries
- **D429** The attributes the matchers read and the ones the seed writes were two hand-kept lists, and nothing checked they agreed (`apps/ai/tests/test_attribute_vocabulary.py`) — a source-level gate, because a live check would measure the corpus's category mix instead
- **D430** The search's ANSWER had no gate: the explicit filters, the open state, the facts and the distance were only ever checked one at a time (`apps/ai/tests/test_live_search_contract.py`) — six consumer-style checks, measured on BOTH planes
- **D431** The merchant agent's chat wrote NO run, so its turns were invisible to the conversation timeline (`api/routes_stream`) — AGENT_CONTRACT §8's first line, and the line that is easiest to skip because nothing fails when it is
- **D432** Three more surfaces wrote no run, and the recommendation handed out a run id that resolved to nothing (`api/runs` + the three routes) — one shared recorder, and a census that makes §8 a number instead of a promise
- **D433** The product's two-turn refinement had never been measured on the live plane, in either spelling (`apps/ai/tests/test_live_conversation_refinement.py`) — the test takes its words FROM the vocabulary, because a hand-typed CJK code point is not a reference
- **D434** The evaluation's own price case was written with three wrong code points and it still PASSED (`apps/ai/tests/test_vocabulary_is_the_reference.py` + `eval/data/intent_v1.jsonl`) — the product's vocabulary is the reference a repo can carry, and a case that passes for the wrong reason is worse than one that fails
- **D435** The word for "now" set NOTHING: two vocabulary tables were left out of the canonicalisation list, and the locale's markers did not know the canonical table's 96 Simplified forms (`apps/ai/nexus_ai/nlu/lexicon.py` + two test files) — one fact kept in two places drifts; the fix is derivation, not vigilance. Residual filed: 37 canonical forms have an unjoined VARIANT (Unihan names 閒 as U+9591 and U+9592) — a word-level decision, not a silent change
- **D436** The Simplified spelling of the two-turn refinement was NEVER RUN: D433's test read "the two spellings" out of a cue list that D421 canonicalised to ONE spelling (`tests/test_live_conversation_refinement.py` + `tests/test_refinement_spellings.py`) — the two spellings now come from the canonical table, the test asserts they differ, and a gate holds the property for every merge cue
- **D437** The cost ledger was an EMPTY table: the router built the row for it (`RoutedCall.as_llm_call_row`) and nothing ever called the builder (`api/runs.py`, `models/router.py`, `tests/test_live_cost_ledger.py`) — the model layer measured every call and threw the measurement away; the run row now carries the tokens and the cost, and the ledger row is written after the run (the FK teaches the order). Caveat filed: the mock provider's token counts are estimates
- **D438** The contract module modelled the error body and seven places hand-built it instead; one request shape has been dead since the first commit (`api/errors.py`, `contract.py`, `tests/test_contract_shapes_are_used.py`) — one builder from the contract's own model, `AiSearchRequest` removed, and a census that catches the next unused shape. Filed: letting the non-streaming search carry a `conversation_id` is a contract decision, not a silent change
- **D439** §8's follow-up question was computed in the user's language and delivered NOWHERE: the understand endpoint's `follow_up_question` was always null (`api/pipeline.py`, `nlu/state_merger.py`, `tests/test_follow_up_question.py`) — only the merge path ever asked for it, and the endpoint that carries the field never merges. Filed: the stream drops the question too, and that needs a frame the documented SSE list does not have
- **D440** A run said when it started and never when it finished: the timeline's documented shape promises `finished_at` (`api/runs.py`, `tests/test_live_run_timestamps.py`) — the column had no default and no caller passed one, so 446 of 446 rows carried a NULL end; the write IS the finish. Filed: `parent_run_id` is NULL in every row too (honest — the product runs one task per turn)
- **D441** The documents pointed at a layout the repository never had: `apps/ai/app/...` instead of `apps/ai/nexus_ai/...` (`apps/ai/tests/test_doc_paths_are_real.py` + 15 documents) — ten stale paths, each naming a file that exists elsewhere; the ledgers are history and were not rewritten. The rule: a missing path is only a defect when the thing it names is somewhere else
- **D442** The service-to-service door was IN the public OpenAPI document: §7.0 says it must not be (`api/routes_rag.py`, `tests/test_service_to_service_is_hidden.py`) — `include_in_schema=False`; the gate reads the paths out of the contract's §7.0 rather than a hand-kept list. **For the sibling lane:** your untracked `apps/ai/tests/test_app_surface.py` asserts the OpenAPI path set against a constant that still contains `/ai/v1/imports/extract` — one of its tests now fails, and its expectation needs that path removed (§7.0)
- **D443** The writer DROPPED three of the schema's 25 columns — `error`, `parent_run_id`, `task_id` — so every one of the 13 failed runs on the plane carried `error = NULL` (`api/runs.py`, `tests/test_run_columns_are_written.py`) — the callers fill `error` and the INSERT threw it away; the gate parses the migration and requires the writer to name EVERY column
- **D444** A FAILED merchant-agent chat wrote no run: the error frame was the only trace of a merchant turn that broke (`api/routes_stream.py`, `tests/test_failed_chat_writes_a_run.py`) — the search stream has written its failed run all along; the gate breaks the chat's retrieval on purpose. Filed: the JSON endpoints' 5xx paths write no run, because those failures ARE the database being unavailable
- **D445** The product read the Chinese numerals in ONE place — the weekdays — and not in the two a user writes most: the hour and the party size (`nlu/numerals.py`, `tests/test_chinese_numerals.py`) — 三個人 and 九點 set nothing while 星期三 worked; one shared rule, and the Chinese ONE is not read as a number where the house has already decided (「一個人」 is the solo cue, 「安靜一點」 is a degree) — caught by the product's own tests
- **D446** The Cantonese 禮拜 was never read: the time parser's cue tables were not canonicalised, so their Simplified entries were dead and the Traditional spelling they did not carry was not read at all (`nlu/timeparse.py`, `nlu/canonical.py`, `tests/test_timeparse_spellings.py`) — eight tables affected; the tables are canonicalised at import now, the text is canonicalised before it is read, and §429's census was extended to them. A census is worth exactly as much as its scope
- **D447** The census was covering less than half the vocabulary: four more tables held dead Simplified entries (`nlu/understand.py`, `nlu/polarity.py`) — no symptom today, because those tables hold both spellings; the census now covers the WHOLE NLU package, each module with the list of the tables it canonicalises at import
- **D448** The cost ledger's rows were written on their own schedule, and the foreign key rejected half of them (`api/runs.py`, `tests/test_live_cost_ledger.py`) — `llm_calls.agent_run_id` refers to `agent_runs(id)`, so a ledger row written before its run is rejected and the best-effort write drops it silently; the run and its ledger rows are now ONE write, in one order, from one recorder, and the gate walks the stream path too (D437's gate walked one path and found the ledger working; the other two were broken)
- **D449** Five tables the product carried and read by nothing — and one of them had gone out of date and was WRONG (`api/routes_discover.py`, `contract.py`, `tests/test_no_dead_constants.py`) — `_COMPARE_ATTRIBUTES` named an `open_hours` row (the grid's is `open_state`) and an `availability` row the grid does not have; the five are gone, and the gate says every module-level constant in the package is read by the package
- **D450** Five functions nothing called either — and one of them was reading state this service must never read (`nlu/state_merger.py`, `tests/test_no_dead_constants.py`) — `session_state_from_context` was a whole second way for the product to read a conversation's state, and the second way disagreed with the first (§34, D20); the gate now covers the functions as well
- **D451** A degraded answer came back with NO degraded header: the recommendation and the intent extraction said `degraded: true` and said nothing else (`api/degraded.py`, `tests/test_degraded_header.py`) — the search set the header from its own response and the others set none; the middleware set it from the BACKEND's state, which is a different signal (an answer can be degraded while the backend is fine); one builder now writes the flag in the body AND the header, and the gate requires the two to agree
- **D452** The degraded-header fix covered three of SIX endpoints: the feedback, the conversation timeline and the tool manifest still said `degraded` and nothing else (`api/routes_system.py`, `api/routes_conversations.py`, `tests/test_degraded_header.py`) — the tool manifest is permanently degraded (the dispatch registry is not built) and said so only in its body; the gate now walks all six
- **D453** The test files' Chinese was never checked: two wrong code points were living in them, one of them in a table nothing read (`tests/test_vocabulary_is_the_reference.py`, `tests/test_merge_cue_spellings.py`) — the reference was a hand-written list of twenty tables and the surface was one directory; the reference is now DERIVED from the product's own package (its data, not its prose) and the scope is every test file, and the gate found U+95A9 where U+95F9 belongs (in a dead `PAIRS` table) and U+5584 where U+5566 belongs (in a test that passed, on another cue), plus a byte order mark on `test_db_pool.py`
- **D454** Three more tables the test files defined and read by nothing — and the counting that hid a fourth (`tests/test_no_dead_constants.py`) — a sweep over the whole test directory found nothing, because another test file has a *live* `PAIRS` of its own and the dead one was hiding behind it; the rule is now per file (read by the AST, not by counting substrings), and the three are gone
- **D458** The two SSE error frames were hand-built, and they disagreed: the same failure got two codes (`api/errors.py`, `tests/test_stream_error_frames.py`) — the search stream said `ai_unavailable` when the model layer or the database was unreachable and the merchant chat said `internal` whatever broke, so a client that retries on the contract's "try again" code would not retry the chat; the frame is now built by one builder from the contract's own error body, the code follows one rule, and the gate walks both surfaces
- **D459** The COMPARISON was the seventh surface the degraded-header census never reached: its request was invalid, so it was never measured (`api/routes_discover.py`, `tests/test_degraded_header.py`) — the comparison needs at least two subjects and the census's probe sent one, so the endpoint answered 422 and the census counted a surface it had never asked; the gate now walks the application's own OpenAPI document, requires every route that answers with a `degraded` field to be covered, and measures the ROUTE's header (the backend's own signal is switched off, or it would mask a route that says nothing)
- **D460** The COMPARISON was a task that wrote no run — and the census that was supposed to say so never asked it (`api/routes_discover.py`, `tests/test_runs_census_walks_every_route.py`) — D432's ledger published a seven-endpoint census and its test file asked five; the comparison reads merchants, builds the grid and grounds every cell in a fact, and none of it was recorded, so "why did the comparison put these two side by side" had no answer; the new census walks the OpenAPI document, asks every route the way a client would, counts the ledger's DELTA per surface, and notices a 422
- **For the sibling lane:** your working tree currently edits the AI lane's `apps/ai/nexus_ai/api/runs.py`, `search/service.py` and `search/sql.py` (the unindexable `::text = ANY(...)` predicates ✓ — a good catch ✓, and the compare's 503 is real ✓), and the comment in `sql.py` is marked **D453**, which this lane already used for the vocabulary gate (§447 ✓). If you publish a ledger section numbered D453, the section reader will report the duplicate ✓ — the next free numbers on this side are **D461 / §455** ✓, and renumbering is easy (as D409 did ✓) ✓
- **D461** Three of the six names the service wrote into `agent_runs.agent` were not on the contract's roster — one of them was the ROUTER'S TASK CLASS (`api/routes_discover.py`, `tests/test_run_agent_names_are_roster_agents.py`) — `intent_extract` is §9's task class, not an agent, and the roster's planner is `user_intent` (D432's entry called it "the contract's roster name" — it was not); the gate PARSES the roster out of AGENT_CONTRACT §1 rather than copying it, the two genuinely off-roster surfaces (`merchant_agent`, `compare_entities`) are declared with their reason, and the schema's own stale copy of the column's values is reported, not edited (the migration is the platform lane's and is applied)
- **D462** The documents named ELEVEN modules that exist nowhere — and the gate that was supposed to catch it could not see a bare module name (`tests/test_doc_paths_are_real.py`, `docs/RAG.md`, `docs/TRACEABILITY.md`, `docs/AI.md`) — D441's rule was "every path that carries a directory", so a module named next to the prose was never checked; three were renames (the eval's gate entry point, the NLU's intent engine and the error envelope — the paths are in the entry above) and the rest were promises (the platform's importer, the orchestrator, the tool registry), now declared in the gate with their reason
- **D463** The user's "before" was dropped without a word — and the "after" filter was asking the database for the wrong hour (`nlu/timeparse.py`, `search/service.py`, `search/sql.py`, `tests/test_time_before_cue.py`) — `EARLY_CUES` and `LATE_CUES` were read by nobody (the function that reads the direction had its own hard-coded list of six while the table beside it held fifteen, and the two disagreed), so "before seven" was answered as if the user had not said it; the plan also passed the quality's `HHMM` where the filter's SQL wants the HOUR (1000 hours is 41 days, whose time part is four in the afternoon, so the "open late after ten" filter asked for a closing hour of 16:00); the census counted TEXT MENTIONS, so a table the canonicalisation list mentions looked alive — it now counts AST reads
- **For the sibling lane:** the AI lane's D463 changed the search's filters (a new `max_opening_hour` ✓) and the time parser's direction tables ✓ — the platform's own search does not read them ✓ (the AI service owns the search ✓), so nothing on your side has to change ✓
- **D464** The function census counted mentions, so seven functions nothing calls were hiding behind one (`search/cards.py`, `models/anthropic.py`, `api/stream.py`, `tests/test_no_dead_constants.py`) — D463 changed the constants' rule to count AST reads and left the functions' rule counting mentions; asking the AST finds seven (four private helpers, now gone, and three PUBLIC exports — a promise the platform lane may call, so they are declared in the gate rather than deleted); the census now counts reads on both sides
- **D465** Two fields promise facts and carry chunk ids — the RAG's `fact_ids` is empty because the CORPUS cannot fill it, and the chat's citations are chunk ids (`tests/test_citations_resolve.py`) — the chunk's metadata carries no fact link, the schema has no column, and 0 of the corpus's 1228 facts have a `source_uri` that matches a document's, so the empty list is the honest answer; the gate says a chunk's `fact_ids` is empty OR every id resolves to a fact row, and the chat's citations must resolve to chunks (and must not be empty)
- **For the sibling lane:** the AI lane's RAG needs the **corpus** to carry a chunk→fact link, and the importer is on your side ✓ — writing the chunk's fact ids into `chunks.metadata` (a `jsonb` column ✓, no migration needed ✓) is enough, and the AI service's retrieval will read them from there ✓. The related contract question — does a citation to the merchant's own document satisfy the trust layer's "must resolve to a fact row" (§19) ✓? — is filed ✓
- **D466** The answer to `query/understand` was a WRAPPER — the contract, the cross-lane type, the SDK and the web's own mock all say the answer IS the intent (`contract.py`, `api/routes_discover.py`, `tests/test_understand_answer_is_the_intent.py`) — a client that followed the contract read `raw_query` and got `undefined`, and read `intent` (the kind) and got an object; the response model now extends the intent and the service's three extras (`provider`, `degraded`, `follow_up_question`) ride at the root, and the gate READS `packages/types/src/intent.ts` and requires the answer to carry every field that interface declares as required
- **For the types/SDK lane:** the answer now carries `degraded` and `follow_up_question` at the root, and `packages/types/src/intent.ts` does not declare them ✓ — a TypeScript client cannot read them typed ✓ (filed ✓); the interface's `clarification_asked` is never set by the service ✓ — what it should mean on a stateless endpoint is a question for the contract's owner ✓
- **D467** Every answer's shape was written TWICE — once in the contract model and once in the route's dict — and the two disagreed (`contract.py`, `api/routes_search.py`, `api/routes_rag.py`, `api/routes_discover.py`, `api/routes_system.py`, `tests/test_answer_shapes_match_the_contract_models.py`) — the routes dumped the model and patched the dict by hand, and two of the patched fields (`intent`, `note`) were in no model at all, while the comparison and the feedback answered with a shape no model declared; the models now declare what the answers carry, the routes build the answers through the models, and the gate asks every surface and requires the answer's keys to be EXACTLY one model's fields (the models are read out of the contract module, not listed in the gate)
- **D468** The SSE frames' payloads had NO models — the JSON answers got them in the last unit, the stream did not (`contract.py`, `api/stream.py`, `api/routes_stream.py`, `tests/test_stream_frames_match_the_contract_models.py`) — the search stream's `status`/`results`/`summary`/`done` frames and the merchant chat's `status`/`summary`/`done` frames spelled their fields out in the routes, with no model and no gate; the contract gained the four frame models and both streams build through them, and the gate reads BOTH streams and requires every frame's payload to be exactly one model's fields
- **For the types lane:** the cross-lane `AiIntentEvent` says the intent frame's payload is `{intent: Intent}` (a wrapper) ✓ — the service and the SDK's own `frameToEvent` (`d as unknown as Intent`) both say the frame's payload IS the intent ✓, so a client written against the cross-lane type reads `frame.intent` and gets the kind (a string) where the type promises an object ✓ — reported, not edited ✓
- **D469** The conversation audit view is contracted field by field (§52) and had NO model (`contract.py`, `api/routes_conversations.py`, `tests/test_answer_shapes_match_the_contract_models.py`) — the route spelled the fields out in a dict, so D467 had to DECLARE the surface as one with no model (a filing that was really the defect); the contract gained `ConversationView`, the route builds through it, and the D467 gate now asks the surface and no longer carries the exception — the gate's own model selection was also too narrow (it picked the models whose NAMES end in `Response`, so `ConversationView` would have been invisible to it) and now reads every model the contract module declares
- **D470** The public surfaces' REQUEST models lived in the routes — the answers got their models in the last three units, the requests had none (`contract.py`, `api/routes_discover.py`, `api/routes_rag.py`, `api/routes_stream.py`, `api/pipeline.py`, `tests/test_request_models_live_in_the_contract.py`) — the comparison's, the stream's and the import door's requests were declared in their routes while API_CONTRACT §7 names all three, so a public request's shape was in two places and only one was checked; the three moved to the contract module (the stream's request took the query-length cap with it — a shape rule, the same cap the BFF enforces) and the gate asks the AST where every `*Request` class is declared
- **D471** The cross-lane card type promises TEN fields the contract's §2 never names — and three of its own comments cite §2 for them (`tests/test_cards_carry_the_contract_fields.py`) — the service's card carries the contract's fifteen fields plus two declared ranking internals ✓, but `packages/types/src/card.ts`'s `EntityCardBase` promises `description`/`tenant_id`/`merchant_id`/`category`/`tags`/`attributes`/`location`/`district`/`transit`/`as_of` ✓ that §2 does not name ✓, and the web's UI reads none of the ten ✓ — that file belongs to the types lane ✓, so it is reported, not edited ✓; the AI lane's part is the check ✓ — the gate reads the contract's own §2 block and requires every card to carry its fields ✓
- **For the types lane:** the cross-lane `EntityCardBase` promises ten fields the contract's §2 does not name ✓, and its own comments cite "API_CONTRACT §2" for `district`/`location`/`transit` ✓ — three citations of a section that does not contain them ✓; the service's card carries §2's fifteen ✓ plus two ranking internals the model documents ✓, and the web's UI reads none of the ten ✓ — reported, not edited ✓
- **D472** The `estimated_price` flag: the CONTRACT names it, the query has the data, and the card could never send it (`contract.py`, `search/cards.py`, `tests/test_estimated_price_flag.py`) — API_CONTRACT §2 names the flag for offering cards (`offerings.price_source = 'estimated'`), the corpus has 105 such offerings, the offering's query already selects `price_source`, and the card's `EntityFlags` had only `sponsored`/`demo`/`unverified` — so a renderer told to look for the flag was looking for a field that was never there; the model carries it now and the builder maps the row's `price_source` onto it
- **D473** The health check and the tool manifest answered with hand-built dicts — the last two surfaces the shape gate had to DECLARE as model-less (`contract.py`, `api/routes_system.py`, `tests/test_answer_shapes_match_the_contract_models.py`, `tests/test_health_and_tools.py`) — the contract gained `HealthResponse`/`DatabaseHealth`/`EmbeddingsHealth`/`ToolsManifestResponse`/`ToolManifestEntry` and the two routes build through them; the shape gate's exception list is now EMPTY and the gate asserts it stays empty, so a new exception has to be a deliberate act with a reason
- **D474** The card's NESTED objects were never checked — the root's fields were, and ten objects inside the card were not (`tests/test_card_nested_shapes.py`) — API_CONTRACT §2 spells out the price, the rating, the distance, the open state, the availability, the AI match, the actions, the facts, the image and the flags, and each was a second copy of the contract's shape that nothing compared; the gate parses the contract's own JSONC blocks (the card's inline blocks and the shared objects' blocks) and requires every nested object on a card to carry exactly those fields, with four declared exceptions (the three trust primitives, the flag D472 added, the action's payload)
- **D475** The English "before 7pm" and "after 7pm" were dropped — the cue window was one character too short, and only the early cue was read on both sides of the clock (`nlu/timeparse.py`, `tests/test_time_cue_positions.py`) — D463's gate checked each layer with the CHINESE order, the one the cue tables were written in, so the English and the Chinese said the same thing and got different answers (the English "before 7pm" was read as a plain clock time); the window is now derived from the cue tables (`max(len(cue)) + 1`) and both cues are read by one rule that looks on both sides — the gate takes its parameters from the tables, so it covers every cue in every language the tables hold
- **D476** The English "farther" TIGHTENED the search radius — and a Chinese word meant the opposite of what it said (`nlu/state_merger.py`, `tests/test_state_merger_cue_shadowing.py`) — the second-turn merge holds eleven cue tables, each with a Latin half and a CJK half, and checks its pairs in order; the match was a plain substring test, so `NEARER_CUES`'s "far" sat inside `FARTHER_CUES`'s "farther" and the English "farther" took the nearer branch (the radius was HALVED where the user asked to double it) — the CJK half was never affected, so the Chinese said "widen" and the English said "narrow"; and `貴啲` ("a bit pricier") sat in BOTH the cheaper and the pricier table, so it always tightened the budget; the longest cue now wins, a Latin cue matches on a word boundary, and the gate asks the MERGE (every cue must produce its own table's effect, in every language)
- **D477** Every ENGLISH weekday was unreadable — the word boundary was a LITERAL BACKSPACE byte — and the day after tomorrow was tomorrow (`nlu/timeparse.py`, `tests/test_weekday_tokens_are_readable.py`) — the table names `monday`/`friday`/`mon`/`tue` and fourteen more, and NOT ONE could be read: the two `\b` word boundaries in the reader's ASCII branch were written as literal backspace bytes (0x08), so the regex searched for a backspace around the name and never matched (the comment above the line says what it was meant to be); and the day-after-tomorrow branch added one day for `is_tomorrow or is_after_tomorrow`, so "the day after tomorrow" and the Chinese landed on TOMORROW — the gate takes its parameters from the table and also checks that no source file carries a control byte that is not a tab, a newline or a carriage return
- **D478** Every Latin marker was matched as a bare SUBSTRING — so "ramen" (which contains "am") was answered with the MORNING window, and "know" (which contains "now") with TODAY (`nlu/timeparse.py`, `tests/test_time_markers_are_words.py`) — the part-of-day table names `am` and `pm`, the day tables name `now`, the cue table names `past`, and every marker was tested with `t in low`, so a word that CONTAINED a marker read as the marker: the live answer for "ramen in sha tin" carried a 07:00–11:30 window the user never said (3 items instead of 9), and "know" was read as today; the Chinese half was never affected (Chinese has no word inside a word), so the same request in two languages got two answers — now ONE matcher (`_marker_positions`/`_marker_in`) serves every marker read: a Latin marker is a WORD (nothing may touch its left, only a plural may follow) and a CJK marker matches on its own spelling; the literals that sat beside the tables are gone (the tables are the only source), the tables name the words the looser match used to find (`midnight`, `overnight`, `luncheon`), and the gate takes its parameters from the tables
- **D479** The first turn had its own copy of the matching rule — so a BOOKSHOP was a RESERVATION, an ORDER was a BOOKING, and nine of the fifteen compare cues could never compare (`nlu/matching.py`, `nlu/understand.py`, `nlu/lexicon.py`, `tests/test_first_turn_cues_are_words.py`) — three readers read cues out of a text (the time parser, the state merger, the first turn) and each had its own copy of the rule, the first turn's being the loosest (any substring will do): "bookshop in sha tin" was answered with the intent `reserve`, "planets cafe" with `plan_experience`, the Chinese for "order" with `reserve` (the one-character cue U+8A02 sits inside the purchase cue and the reserve table is checked first), and the table's "book a table" cue was spelled with a character the product never writes (the contract's own eval case was passing only by the bare cue) — now ONE matcher serves all three readers, the fourth copy of the vocabulary (the hard-coded list in `_looks_like_discovery`) is gone, the tables no longer shadow each other, and the gate takes its parameters from the tables
- **D480** The first turn's REMAINING readers still matched their tables as bare SUBSTRINGS — so "know" made the query URGENT and "underground" made it a PRICE search (`nlu/understand.py`, `nlu/lexicon.py`, `tests/test_first_turn_readers_are_words.py`) — D479 gave the intent tables the one matcher, and the very next census found SEVEN more readers with the same loose match (the urgency, the budget words, the sort rules, the preferences, the price words, the nearby terms, the constraint negations): "know a good cafe" was answered with the urgency `now` (the token "now" inside "know"), "underground coffee" with the sort `price_low` (the token "under"), "review a cafe" with the preference `view=scenic` (the token "view"), and the word U+6700 U+53D7 U+6B61 U+8FCE stood in both the rating row and the trending row of the sort rules — now every one of those readers reads through the ONE matcher, and the gate takes its parameters from the tables
- **D481** The lexin's OWN readers read their names as bare SUBSTRINGS — so "spaghetti" was a SPA, and the live search answered with BEAUTY SALONS (`nlu/lexicon.py`, `tests/test_lexicon_readers_are_words.py`) — D480 gave the first turn's readers the one matcher, and the lexin's own readers (the category names, the district names, the cuisine terms) still tested their tables with `in low`: "spaghetti dinner in sha tin" was answered with the category `beauty` (the category "spa" inside "spaghetti") and the LIVE search answered with two beauty salons where the same query answered with nine cafés, and "barbecue" was the category `bar` — now all three readers read through the ONE matcher (the rightmost match still decides, so the CJK head-noun rule is unchanged), and the gate takes its parameters from the tables
- **D482** The trust layer typed a price as a plain NUMBER — the keyword's window was six characters, and the keyword list stood inside the reader (`trust/verification.py`, `search/tokens.py`, `tests/test_trust_claim_kinds.py`) — the kind decides the grounding tolerance (§4), so a money claim typed as a number is grounded with the loose number tolerance and a price can be grounded by a rating fact; the window was shorter than most English clauses ("the price is 128" → the window was "ce is 128" → NUMBER), the English "star" was not in the rating list at all, the keyword list was a second copy of the vocabulary, and the keywords were read as bare substrings ("priceless" → money) — now the window reaches the word that types the claim (the polarity reader's own reach: sixteen for Latin, six for CJK), the keyword lists are TABLES with "star" among them, the Latin keywords are read by the ONE matcher, and the RAG's containment test reads words too ("spa" no longer matches "spaghetti", "tea" no longer matches "steakhouse", a plural still matches)
- **D483** The one unknown the product asks NOTHING about: the INTENT (`nlu/state_merger.py`, `tests/test_follow_up_question_covers_every_unknown.py`) — §8 promises "ask about the single most important missing thing", and the intent's unknowns were read from a list of five that did not include "intent": a query the product cannot classify carried `unknowns: ["intent"]` and NO question at all (the user is told the product does not know, and then it asks nothing) — the bank also stood INSIDE the reader (a second copy of the vocabulary) and its zh-HK section was written in the SIMPLIFIED script (a copy-paste of the zh-CN section, with one Traditional exception), so a Hong Kong user was asked 请问几位？ beside 預算大概幾多？ — now the intent joins the follow-up order, the bank is a TABLE, the zh-HK section is in the product's canonical spelling (the zh-CN section keeps its Simplified one), the intent's question is the product's own wording (the platform's search label), and the table is named in the vocabulary gate's BY_DESIGN list
- **D484** The follow-up question ignored the product's DECLARED priority — "book a table" was asked whether the user wants a place or a product, and the PARTY SIZE was never asked (`nlu/state_merger.py`, `nlu/understand.py`, `tests/test_follow_up_question_follows_the_priority.py`) — §8 promises "ask about the single most important missing thing" and the product keeps a list of that order (the intent, the party size, the time, the location, the category), but the reader took whichever unknown came first in the LIST — the order the producer happened to append them — so "book a table" (the unknowns ['category', 'location', 'party_size', 'time']) was asked "Looking for a place or a product?" and the party size (the unknown the contract's own example names) was never asked; two promises nobody kept went with it: the "budget" question (the producer never reports the budget — a budget is optional) and the "compare_targets" unknown (a compare turn needs two entities to BE a compare turn) — now the reader takes the first unknown by the declared order, and the gate CENSUSES the machinery in BOTH directions (what the producer can produce, what the reader can answer — the two sets must be the same set)
- **D485** The canonical table was missing NINE Simplified forms the product already knew — so a Simplified Chinese user asking for noodles got NOTHING (`nlu/canonical.py`, `nlu/lexicon.py`, `tests/test_canonical_covers_every_pair.py`) — the canonical table maps the Simplified spelling to the product's canonical one and the lexicon keeps its own pair list, and nine of those pairs were not in the table, so a query written in those Simplified forms was compared against the table's canonical spelling and never met it: the Simplified 粉面 (noodle soup) → the intent `unknown` where the Traditional 粉麵 → `discover_merchant` + the category `restaurant`, and the Simplified 划位 (book a table) → `unknown` where the Traditional 劃位 → `reserve` — the locale detection had it right (the Simplified text was voted zh-CN) and then the cues never matched — now the table carries every pair the lexicon knows (the code points come from the lexicon's own list, and Unihan's sources are the authority), and the gate is the census D435's note asked for and nobody ran
- **D486** The constraint table was a SUBSET of the product's own vocabulary — a user who said "I don't like spicy" got NO constraint, and the table's last value was a WRONG CHARACTER (`nlu/lexicon.py`, `tests/test_constraint_table_is_the_vocabulary.py`) — the polarity table (the one that flips a preference's sign) names the "don't like" forms (the Cantonese 唔鍾意 / 唔鍾 and the Chinese 不喜歡) and the constraint table did not, so "唔鍾意辣" produced no constraint in the first turn OR the merge; and the table's last value was U+9EA9, which Unihan defines as "bran" and which appears nowhere else in the product — the character it stood for is the ginger U+8591, which no product source holds, so "no ginger" was no constraint in either language — the code points come from the polarity table and from Unihan, and the gate holds the table to its promises (every "don't like" form is a negation of EVERY rule, every negation and every value produces its constraint, and the same turn reads the same in the first turn and the merge)
- **D487** The urgency was TWO vocabularies — a follow-up that said "next week" was URGENT on the first turn and had NO urgency in the merge (`nlu/lexicon.py`, `nlu/state_merger.py`, `tests/test_urgency_is_one_vocabulary.py`) — the first turn reads the urgency from the lexin's URGENCY_NOW/URGENCY_FLEXIBLE and the merge read it from two tables of its own, and the copies were subsets that differed in BOTH directions: "asap", "next week", "I am free" and "at the end of the month" were read by the first turn and not by the merge, while the merge's own "whatever" word the first turn did not know — now the merge reads the lexin's tables (one vocabulary, one place), the lexin's tables gain the words the merge knew, the merge's copies go, and the gate asks the two readers the same question and compares the answers
- **D488** The merge added the SAME constraint TWICE, in two spellings — a second reader of the vocabulary the first turn reads (`nlu/state_merger.py`, `tests/test_the_two_readers_agree.py`) — the census that followed D487 asked the two readers the same question about every word of the tables they share and found twelve divergences, all the same shape: "唔食豬" (I don't eat pork) gave the first turn [('diet_avoid', 'pork')] and the merge [('diet_avoid', 'pork'), ('diet_avoid', '豬')] — the merge read the constraints with its own hand-written regexes (a second reader, and a subset) AND the residual absorb read the lexin's table, so the constraint was added once by each; now the merge's own rules go (the one reader stays — the residual absorb, which reads the whole table), the "spicy is fine" relaxation stays (it DROPS a constraint, and no table holds it), and the vocabulary gate caught the loss — the product's only copy of the Cantonese particle U+5605 stood in that regex, so the particle joins the gate's DECLARED list (the tables hold the words, the particle is the grammar between them) — the gate asks both readers the same question and compares the answers field by field
- **D489** The merge CHANGED the state it was given — though the module promises it is PURE (`nlu/state_merger.py`, `tests/test_the_merge_is_pure.py`) — the docstring says "Merging is *pure and ordered* so it unit-tests without a model", and the state was copied with `dict(state)` — a SHALLOW copy — so the nested lists were the CALLER'S and the residual absorb appends to them: a caller that keeps the state to merge the next turn found the turn's preferences already in it, and the second turn's answer carried the first turn's preference — now the merge works on a deep copy, and the gate holds the promise (the merge leaves the state untouched, the merge is deterministic, the merge still READS the state, and a caller can merge twice onto the same state) — and this was found by D488's census: the answers came back GROWING
- **D492** The urgency and the TIME PARSER disagreed about "next week" — a Cantonese user who said 下星期 got NO urgency (`nlu/lexicon.py`, `tests/test_the_next_week_words_are_one_vocabulary.py`) — the time parser holds the next-week words (下週, 下周, 來週, next week, 下星期, 下禮拜) and the urgency holds the "flexible" words (得閒, 得閑, 有空, 隨時, anytime, next week, 下週, 下周, 來週, 月底, 無所謂), and they mean the same thing in TWO modules — two words (下星期 U+4E0B U+661F U+671F and 下禮拜 U+4E0B U+79AE U+62DC) were next-week words the time parser knew and the urgency did not, so a user who said "next week" in Cantonese was heard by the time parser and NOT by the urgency (the urgency read 'normal') — now the urgency's table gains the words the time parser knows (the code points come from the time parser's own table), the comparison is made in the CANONICAL spelling (both tables are canonicalised at import, so the Traditional 來週 and the Simplified 来週 are one word and the gap was two words and not three), and the gate holds the two tables to each other
- **D495** The constraint table's negations were a SUBSET of the product's own vocabulary — "I don't want spicy" and "I hate spicy" gave NO constraint (`nlu/lexicon.py`, `tests/test_the_negations_are_the_products_own.py`) — the polarity module (the one that flips a preference's sign) holds the product's vocabulary of "the negations it understands" (twenty-eight words) and the constraint table held its own list (seventeen words), and fifteen of the product's were missing from it: 唔好 (I don't want), 唔想要/不想要, 討厭/讨厌 (I hate), 冇 (no/without), 唔係/不是 (is not), 不好, don't/dont/do not, hate/dislike — so a user who said "I don't want spicy" got NO constraint at all: the product read the word and then did nothing with it — now the constraint table's negations ARE the polarity module's vocabulary (the derivation — one fact, one place) plus the four words the table alone used, the lexicon's own derived NEGATION_CUES goes (it was read by no production code, only by a test that re-derived it), and the gate holds the two lists to each other (every negation the product knows is a negation of every rule, and produces that rule's constraint in the first turn AND the merge) — and the discipline note is the sharpest yet: D486 fixed FOUR of the twenty-eight words and its lesson said "the copy must be the whole fact" — so a fix that takes a SUBSET of the missing words is the same defect it was fixing
- **D496** The trust layer's TOOL-NAME list was a SUBSET of the canonical set — a merchant document naming `summarize_reviews` was NOT flagged (`tools/names.py` (new), `trust/injection.py`, `api/routes_system.py`, `tests/test_the_tool_names_are_one_list.py`) — AGENT_CONTRACT §3 names twenty-four canonical tools and two readers need that list: the manifest at `GET /ai/v1/tools` and the trust layer's tool-name scanner (the guard behind "tool names come only from the registry, never from content") — both held a hand-written copy and the scanner's copy was missing EIGHT of them (search_services, search_reviews, search_location, get_business_hours, analyze_reviews, get_user_preferences, summarize_reviews, compare_entities), so a merchant's document naming one of them was not flagged at all and the promise the scanner exists to keep was not kept for eight of the twenty-four tools — now the names are ONE list (`nexus_ai/tools/names.py`), the manifest's list IS the canonical list, the scanner's tokens are the canonical set plus the two tools §4 names as never in a default grant (a superset is fine; a subset is a hole in the guard), and the gate READS THE CONTRACT (§3) — the canonical list is the contract's list, the manifest advertises exactly it, the scanner knows every name, and every name is actually flagged when it appears in content
- **D497** The trust layer's §4 promises were never implemented — conflicts were silently picked, low-confidence claims were rendered, and the `trust_signals` table was inaccessible (`contract.py`, `search/cards.py`, `tests/test_a_disputed_fact_is_flagged.py`) — AGENT_CONTRACT §4 (non-negotiable) makes two promises the product never implemented: (1) conflicts create a `trust_signals` row rather than silently picking — the product picked silently, the `trust_signals` table exists but the AI role cannot even read it, and the contract's §0 grant set does not name it; (2) confidence < 0.6 → phrase as uncertain, < 0.4 → omit and offer handoff — the machinery (`copy_confidence_hint`) exists and is called by nothing. The fix: the card gains `conflicting_fact: bool` (the flag §2 should name, filed), the card builder calls the trust layer's own resolver (`resolve_conflicts`) and flags any attribute whose facts disagree, the shown value is the one the §4 hierarchy picks (merchant > observed > imported...), agreeing facts carry no flag. The gate holds the promise (two prices → flag, hierarchy wins, agreeing facts unflagged, resolver decides).
- **D498** The contract's `verified_visit` flag on review cards was missing from the model (`contract.py`, `tests/test_card_nested_shapes.py`) — AGENT_CONTRACT §2 names the `verified_visit` flag on review cards ("the reviewer transacted") but the `EntityFlags` model was missing it, and the gate that checks the card's nested objects against the contract did not expect it — now the `EntityFlags` model gains `verified_visit: bool = False` (derived from `reviews.verified_purchase` OR `reviews.verified_reservation`), and the gate's declared extras for the `flags` object includes `verified_visit`
- **D499** The `copy_confidence_hint` function was never called but the contract promises confidence handling (`contract.py`) — AGENT_CONTRACT §4 promises: confidence < 0.6 → phrase as uncertain, < 0.4 → omit and offer handoff, never upgrade confidence. The trust layer had a `copy_confidence_hint` function that implemented this but was never called in production (only by tests). The logic moves into the `Fact` model as a `confidence_hint` property: confidence < 0.4 → "omit_and_offer_handoff", < 0.6 → "phrase_as_uncertain", ≥ 0.6 → None. Now every `Fact` serialized to the card carries its `confidence_hint`, and the renderer can use it to phrase uncertain values or omit low-confidence ones
- **D500** `from nexus_ai.trust import *` RAISED — the package's `__all__` named two attributes it did not have (`trust/__init__.py`, `trust/facts.py`, `tests/test_every_package_all_is_honest.py`) — `AttributeError: module 'nexus_ai.trust' has no attribute 'copy_confidence_hint'`, broken since the package landed: the `__all__` named `copy_confidence_hint` (D499 moved the rule into the `Fact.confidence_hint` property and the import list stopped naming it, but the `__all__` did not) and `select_display_facts` (never imported into the package at all, though its own module defines it) — a name in `__all__` is a promise ("from this package import * gives you this"), and a promise that RAISES is worse than no promise — now the `__all__` names only what it has, the standalone `copy_confidence_hint` is deleted (the rule lives on the model; a second copy is a second thing that can drift), and the gate walks EVERY module of the AI service (seventy-two) and exercises the star import — **and this unit is a correction**: §492 (D499) said "The standalone function is removed" and it was not, so the general form gains: a unit's ledger entry is a claim about the tree and the tree is the witness — a change that says "X is gone" must be MEASURED, not assumed; and a public surface is tested by USING it, not by naming it
- **D501** An UNKNOWN fact source was LAUNDERED into a real one — the product invented the provenance of a number it did not vouch for (`trust/facts.py`, `tests/test_an_unknown_source_is_never_laundered.py`) — AGENT_CONTRACT §4 says "resolving an unknown source to a known one is forbidden, because that launders where the number came from", and DECISIONS D25 ruling 3 named this exact behaviour "provenance laundering, the opposite of §109" — **and the clamping was still there**, in two paths: `source = str(r.get("source") or "inferred")` (a MISSING source) and `source=cast(FactSource, source if source in SOURCE_RANK else "inferred")` (an UNKNOWN one), so a row whose source the product does not know (a partner feed, a scrape, a typo, a casing slip) was relabelled `inferred` — a REAL provenance (rank 1, above `demo`'s 0) with `inferred`'s confidence cap; the row never claimed it, the product invented it, and the invented one is better-provenanced than the bucket the contract reserves for data whose origin is not vouchable. D25's ruling 3 gave the answer and the product did not take it: `demo` is a first-class source ranked BELOW `inferred` on purpose ("so synthetic data states where it came from and never outranks a real observation"). Now a missing or unknown source resolves to `demo`, never to a source the row did not claim, and the confidence is capped from the RESOLVED source
- **D502** The §18/§19 grounding boundary was enforced on ONE of the THREE card surfaces — the consumer's search route shipped cards without it (`api/pipeline.py`, `api/routes_discover.py`, `tests/test_every_card_surface_enforces_the_grounding.py`) — AGENT_CONTRACT §4 (non-negotiable) says "if `fact_id` is missing, the UI must not render that bullet", the product has a guard for it (`drop_ungrounded_reasons`), and the RECOMMEND route called it on every card — the SEARCH route did not and the STREAM route did not, so the boundary the contract calls non-negotiable was enforced on the surface the recommendation product uses and not on the surface the CONSUMER uses (and `/ai/v1/search` is both the main consumer surface and the §105 fallback the stream degrades to). The live corpus shows no difference (the rules path never emits an ungrounded reason) — which is exactly why the guard belongs in the shared place: it is there for the producer that does not exist yet. Now the guard moves INTO `run_search` (the one function all three surfaces call), the recommend route's own copy goes, and the gate INJECTS the ungrounded reason and asks every surface what it does with the result
- **D503** The trust layer held a SECOND copy of the §4 renderer rule — and it was the copy the contract FORBIDS (`trust/verification.py`, `trust/facts.py`, `trust/__init__.py`, `tests/test_the_trust_surface_is_used.py`) — AGENT_CONTRACT §4 says "if `fact_id` is missing, the UI must not render that bullet" and the product's guard (`drop_ungrounded_reasons`) keeps that rule, but the trust layer held a second implementation (`verify_bullets`) that implemented it the OTHER way: a bullet with no `fact_id` SURVIVED if its claims happened to ground — and the TEST asserted the wrong copy, so the test was green while the product kept a different rule (the D488 lesson exactly). Two more copies went with it: `pick_authoritative` (a second copy of the §4 source hierarchy — the product's `FactBundle.pick_all` is the picker, and the two agreed on 108 measured cases) and `select_display_facts` (a second copy of the display selection). All three were read by the tests and by NO production code — and the D464 census could not see them, because it counts a read in the TESTS as a read. The gate now holds the trust layer's public surface to the product (every export is called by the product or declared, with the D464 census's own declared list reused), pins the §4 rule to one implementation, and checks the three copies are gone from the package AND the modules
- **D504** The dead-constant census counted a TEST's read as a read — so a rule the contract FORBIDS survived on the strength of the test that asserted it (`tests/test_no_dead_constants.py`, `tests/test_the_trust_surface_is_used.py`) — D464's census asks "is this name read?" and counts a read in the package OR in the tests, so a name only a test reads survives it — and D503 showed what that costs: the trust layer kept a second copy of the §4 renderer rule (the copy the contract forbids) and the test asserted it, so the census saw a use and the copy stayed. The census now asks TWO questions (is the name read at all, and is the name read by the PRODUCT), and every name the product does not read is now DECLARED one by one with the reason (fourteen: the CI's frame check, the task class's metadata, the scanner's convenience predicates, the demo-mode check, the provider factory's accessors, the platform door's client and resetters, the SQL's helpers, the naming convention, the database requirement, the freshness trigger) — so the product's dead surface is a list, not a gap
- **D505** The search's `filters.category` did not speak the product's OWN category vocabulary — "escape room" as a query found 1 item, as a filter found 0 (`search/service.py`, `tests/test_the_filter_speaks_the_category_vocabulary.py`) — the intent's category goes through the lexin's ONE reader (`match_category`), but the CALLER's `filters.category` passed the raw string through, so the same word was two different filters and one matched nothing (measured on the live corpus: 18 merchants, "escape room" filter → 0 items, same word as query → 1 item). The fix: the filter goes through the SAME reader. The gate holds the two to the same vocabulary (196 passed, proved to fail by removing the reader).
- **D508** The search's `filters.district` did not speak the product's OWN district vocabulary — "中環" as a filter found 0 items, as a query found 1 (`search/service.py`, `tests/test_the_filter_speaks_the_district_vocabulary.py`) — the intent's district goes through the lexin's ONE reader (`match_district`), but the CALLER's `filters.district` passed the raw string through, so the same word was two different filters and one matched nothing (measured on the live corpus: 18 merchants, "中環" filter → 0 items, same word as query → 1 item). The fix: the filter goes through the SAME reader. The gate holds the two to the same vocabulary (88 passed, proved to fail by removing the reader).
- **D506** A read by ids compared its uuid columns as TEXT - nine indexed lookups became sequential scans and the cold `/ai/v1/compare` answered 503 `canceling statement due to statement timeout` (`apps/ai/nexus_ai/search/sql.py`, `apps/ai/tests/test_uuid_id_bindings.py`, `infra/db/migrations/V10__facts_subject_id_index.sql`, `docs/DATABASE.md` §5) - `col::text = ANY($n::text[])` is type-legal and answers correctly, but a predicate over a CAST column is not servable by a btree over the COLUMN, so every by-ids read walked its table page by page; the fix binds `uuid[]` (asyncpg encodes a list of `str` for a `uuid[]`, so the builders keep passing strings) and V10 adds `facts_subject_id_idx`, because both `facts` indexes that name `subject_id` LEAD with `subject_type` - the one thing a by-ids page cannot name, since it mixes merchant cards and offering cards. The gate charges the CLASS (no id column anywhere in the package is compared as text), pins each builder's bind shape, and measures the plan and the endpoint against the live container; its arm puts the old spelling back and demands exactly eight charged sites. **And the lesson about the tree**: the code landed without a ledger row - the casts went into `a0ba536`, whose subject is D463 and a time-parsing unit, and the gate, the migration and the §5 row were swept into `fad4330` by the sibling's commit of the shared tree - so a fix can be TRUE of HEAD and ABSENT from the ledger at the same time, and §498 pays that debt
- **D507** The semantic embedding provider was DEAD ON ARRIVAL and the search pipeline had never asked it for a vector (`models/embeddings.py`, `api/pipeline.py`, `tests/test_embeddings.py`, `tests/test_the_semantic_lane_reaches_its_provider.py`) - `f80fadd` rewrote `HttpEmbedding.embed` into a body that raises on its first reachable line (`Dict`, `model_key` and `items` are never defined, a `by_model` grouping is built and never iterated, responses are zipped onto a differently-ordered input list, and the annotation no longer matches `EmbeddingAdapter`) while the test file's own docstring and `# pragma: no cover` declared the network path untestable, so nothing ever called it; and `api/pipeline.py`, created by `954decb`, gated the query-vector call on `embedding_provider == "hashing"` for the whole of its life, so the offline adapter was asked on every query and the provider AGENT_CONTRACT §6 names for paraphrase recall never was (the RAG route never carried that guard - two call sites answering the same question differently). Now one request per call, every row placed by the endpoint's own `index`, and a refusal wherever placement cannot be trusted - a short answer, an index outside the inputs sent, the same index arriving twice, a wrong length, any row left unset - because the old silent `[0.0] * dim` is not a missing score but a row that cosine can never retrieve again; the pipeline asks every provider and a provider failure still floors to the keyword lane. 25 + 6 cases, 6 arms and an 11-red reverse control all MATCHED, ruff 3 -> 0 and mypy 4 -> 0, suite 2621 passed / 98 skipped. **And the live reading that decides what "fixed" means here**: against the container the lane is taken (`vector_lane=True`) and 0 of 5 rows carry a vector score, because `chunks` holds 2118 rows with 0 embeddings - the repair makes retrieval reachable and it retrieves nothing until the corpus is embedded, which is filed as the next unit; `/ai/v1/health` also answers with the CONFIGURED provider (`routes_system.py:85`) rather than the one the factory built, reported and not fixed here
- **The numbering: the D-numbers 428-454, 458-505, 508, and 506-507, the sections 422-448, 452-497, 498-499, 505, and 506, are this lane's** — the sibling lane worked in parallel and took **D455-D457 / §449-§451** and then **D490-D491 / §484-§485** and **D493 / §487** and **D493 / §487** (their commits landed on top of this lane's D489 ✓), so this lane's next unit is **D509 / §501** ✓. If the next unit collides, renumber it (as D409 did, and D414 recorded, and as D492 did when the sibling took §485 mid-unit ✓) — the readers cannot see the sibling's sections, so only the two lanes can keep the numbering straight. **Note: the sibling commits `docs/STATUS.md` wholesale ✓, so an uncommitted ledger entry can be swept into their commit ✓ — write the entry last ✓ and commit it at once ✓.**
- **Fresh gate** re-certified through step 6 on the live plane: 217 quality checks, none red; step 7 is the sandbox's node-spawn refusal

All ledger checks PASS. Contract drift: 117 parsed / 109 served / no gap.

### Standing invariants (re-run this session, on this plane)

```
node scripts/check_contract_drift.mjs            # 117 parsed / 109 served / no gap bucket
node scripts/check_ledger_citations.mjs --worktree   # 0 offenders
node scripts/check_ledger_sections.mjs               # PASS (disk-only draft printed and allowed)
node scripts/check_ledger_numbers.mjs --census       # PASS, fences balanced
node scripts/check_ledger_eols.mjs                   # PASS — no section mixes line endings (D360)
node scripts/check_console_i18n.mjs && node scripts/check_console_a11y.mjs   # PASS
node scripts/check_reader_reachability.mjs           # 14 of 14 readers invoked
node scripts/check_status_citations.mjs              # PASS
cd apps/web && npx tsc --noEmit && npx vitest run    # clean / 136
cd apps/ai && ./.venv/Scripts/python.exe -m pytest -q   # 830 passed with the live DB / 804 passed, 26 skipped without it
cd apps/ai && ./.venv/Scripts/python.exe -m ruff check .   # All checks passed! (D408's rule set, stated in pyproject.toml)
cd apps/ai && ./.venv/Scripts/python.exe -m mypy nexus_ai  # Success: no issues found in 51 source files
cd apps/ai && ./.venv/Scripts/python.exe -m nexus_ai.eval.cli --suite intent_v1,safety_injection_v1 --fail-on-gate   # RESULT: PASS - 2 suite(s), 0 failing (D410)
cd services/platform && mvn -o test                  # 251 passed (D295's whole measurement)
```

### Blocked on the other stream

- **The fresh gate's full re-certification** — step 14's accessibility falsifier crashes on an
  unimported removal call in the other lane's working-copy edit (D331 routed, D332 corrected the
  misdiagnosis); steps 15-18 are measured by hand past it (D330), and the gate completes the moment
  the edit lands or is dropped.
- **The committed-plane test count** — the web's eleven-file suite and the AI's three-hundred-forty-one
  live in the working copy; a clean checkout collects zero of either until the owners land.

## What this plan is not

It is not a burndown. Every unit that closes a residue also reports the narrower residue it found, which is
why the ledger grows while the defects shrink. The measure of progress is not "tasks remaining" but **how
many claims in this repo are backed by a command someone actually ran** — that number only goes up.

## Run log (dated, so the queue above is not read as a snapshot)

### 2026-09-29 11:40 — state taken, one red closed, one red blocked by the environment

```
node scripts/check_contract_drift.mjs             114 parsed / 106 served / 0 CLIENT-ONLY
node scripts/check_jsonb_reads.mjs                 17 triples declared, 0 undeclared
node scripts/check_ledger_citations.mjs --worktree RESULT: UNCHECKED — `git show` cannot spawn here (EBUSY)
node scripts/check_comment_citations.mjs           RESULT: NOT RUN — its step 8 had no report (same cause)
mvn -o test -Dtest='MerchantWorkspaceTest#myWorkspacesPrintTheirGrants'
                                                   Errors: 1 — CannotGetJdbcConnectionException,
                                                   127.0.0.1:5433 refused. The DB is down, so this is
                                                   NOT the earlier "Expected size: 1 but was: 0".
```

**The UNCHECKED pair is correct behaviour, not a regression.** The citation checker now reads HEAD even
under `--worktree` (for newness only), and a HEAD it cannot read is refused as UNCHECKED — that is the
verdict the tool owes when it cannot run, and it is the reason it no longer crashes the way it used to.
Both tools are saying "this sandbox cannot spawn git", not "the text is wrong".

**Closed:** `apps/web` `tsc --noEmit` was red on `src/lib/format.test.ts` —
`EXPECTED['zh-HK'][0]` is `string[] | undefined` under `noUncheckedIndexedAccess`. Fixed with a typed
`at(locale, day)` accessor that throws naming the locale and day instead of eight non-null assertions:
the compiler's objection stays (a `Record` lookup can miss) and a miss becomes a loud failure rather than a
`toBe(undefined)` that passes until someone looks.

```
cd apps/web && npx tsc --noEmit                  clean
cd apps/web && npx vitest run                    136 passed
cd apps/web && npx eslint src --max-warnings=0   clean
```

**Blocked:** every DB-backed verification. `docker ps` → "failed to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine"; the engine cannot be started from this sandbox
(`docker desktop start` needs `wsl.exe`, which the sandbox program blacklist refuses). Re-take the P1
measurement once the container `nexus-platform-postgres` is up — including whether the
"Expected size: 1 but was: 0" failure of 2026-09-28 survives, because the run above could not reach the
database and therefore could not reproduce or refute it.

### 2026-09-29 11:52 — the AI lane's gate, run for the first time in this log

```
cd apps/ai && ./.venv/Scripts/python.exe -m pytest -q
  80 passed, 4 skipped, 1 warning in 5.62s
```

Green, and worth recording because no previous entry in this log had run it. The four skips are
`test_integration.py`'s live-DB tests, and they **do** run in CI (`ci.yml:134` points the AI job at
`postgresql://nexus_ai:…@127.0.0.1:5433/nexus_test`) — so the local skips are the DB being unavailable
here, not a suite that never runs.

**Changed:** `apps/ai/pyproject.toml` gains `addopts = "-rs"`. A skip without its reason is a number:
"4 skipped" reads as "four tests not worth running" rather than "four tests this machine could not run",
and the reason was only visible under `-rs`. Same rule as the checkers in `scripts/` — a reader that cannot
run says so, in its own words, without being asked. Verified by re-running: the default output now prints
all four reasons.

Also run this session, for the record:

```
node scripts/check_console_a11y.mjs    RESULT: PASS — landmark, name, ring and every printed ratio
                                       (tightest light --nexus-ink-faint on #ffffff = 4.80:1)
node scripts/check_console_i18n.mjs    RESULT: PASS — 0 CJK offenders, every operator surface noindex
node scripts/check_falsifier_registry.mjs   NOT CHECKED — no --db given (needs a loaded seed)
node scripts/check_ledger_sections.mjs      NOT CHECKED — git show EBUSY
node scripts/check_status_citations.mjs     NOT CHECKED — git show EBUSY
```

The three NOT CHECKED verdicts are the sandbox, not the text: this machine cannot spawn `git` from Node,
and those tools refuse to claim a verdict they could not reach. CI, where `git show` works, is where they
are meant to run.

### 2026-09-29 11:58 — the three packages, whose gates nothing in this log had run

The root `package.json` scripts cover the web app only (`typecheck:web`, `test:web`, `lint:web`), so the
workspace packages are gated by their own scripts and by CI — nothing I had run. All three, run here:

```
cd packages/types && npx tsc --noEmit    clean
cd packages/sdk   && npx tsc --noEmit    clean
cd packages/ui    && npx tsc --noEmit    clean

cd packages/types && npm test            31/31 pass  (build -> gen:schemas -> conformance -> test:unit)
cd packages/sdk   && npm test            43/43 pass  (pretest -> test)

cd packages/types && npm run conformance
  conformance: 7 schemas, 28 enum bindings, 50 fixture cases (30 negative), 21 custom rules,
               432 checks in 285ms
  conformance OK — TS enums, JSON Schemas and fixtures agree.
```

`@nexus/types`' `test` is the strongest single gate in the repo by check count (432), and it chains
`gen:schemas` before `conformance` — so a generator that stopped agreeing with the committed schemas would
fail there rather than silently drift.

**Checked rather than assumed:** `npm test` runs `gen:schemas`, which rewrites files, and
`git status packages/types` showed eleven modified paths including generated ones — which would have meant
the committed generated output was stale. It is not: `src/schemas/entity_card.json` has mtime
`09-23 01:05`, six days before this run, and its diff is a substantive edit (`oneOf` → `anyOf`, with a
reason: a lowercase uuid matches the slug pattern too, so an exclusive union would reject exactly the ids
the field exists to carry) — i.e. another lane's uncommitted work, not a regeneration. The generator did
not touch a single file, so what is committed matches what it produces.

### 2026-09-29 12:05 — P1 CLOSED: the platform suite is green, and the red was never the code

The database came back (`docker ps` → `nexus-platform-postgres`, `nexus-platform-redis`), so the measurement
that had been blocked all morning could finally be taken:

```
mvn -o test -Dtest='MerchantWorkspaceTest#myWorkspacesPrintTheirGrants'
  Tests run: 1, Failures: 0, Errors: 0 — BUILD SUCCESS (22.77s)

mvn -o test
  Tests run: 218, Failures: 0, Errors: 0, Skipped: 0 — BUILD SUCCESS (3m28s)
```

**The diagnosis in P1 was right and the conclusion is now measured.** The 34 failures of 2026-09-27 — and
the `Expected size: 1 but was: 0` I chased through five links of the `/me` chain — were the **test database**,
not the code. Every link I read (the fixture's `own()`, `/me`'s SQL, the shared permissions reader, the call
site, `Req.userId`) was correct, which is exactly why reading could not find it: there was nothing wrong to
find. `nexus_test` had diverged and was then re-provisioned (60 tables now, one more than the 59 I measured
on 09-28), and the suite passes against it unchanged.

That is the second time this session the answer was "the environment, not the text" — the other being the
citation checkers' UNCHECKED verdicts. It is worth stating as a rule, because both times the code was
read carefully and read clean:

> **Before diagnosing a red, confirm the thing the red is measured against.** A shared test database and a
> sandbox that cannot spawn `git` are both part of the measurement instrument, and an instrument that
> drifted looks exactly like a defect.

Two corrections to my own earlier notes, both caught by measuring rather than by reasoning:

- My `information_schema.tables` query counted **0 tables in every database**, including `nexus` (which has
  61). `information_schema` is scoped to the current database, so querying it from `postgres` and filtering
  by `datname` can only ever return zero. Re-run per database: `nexus` 61, `nexus_test` 60.
- Five `nexus_gate_*` databases were left behind by earlier killed gate runs. Dropped, `0 remaining` — the
  hazard this plan already documents, now cleaned up rather than only described.

### 2026-09-30 13:30 — the falsifier gets the schedule it was missing, and a correction to my own reading

The queue's P2 was closed by other lanes while this plan sat: D179 refused to fabricate an `import_job`
marker and built `MerchantImportDoorTest` as a witness instead; the string-valued jsonb residue was
repaired to `TOTAL string-valued jsonb cells = 0`; the vendor exclusion went from a 10-name hand list to a
21-directory rule. What remained was one residue **about my own artifact**, in §186's own words:

> nothing runs `scripts/verify_jsonb_binding.py` on a schedule (it is not in `data/seed/falsifiers.tsv`)

Two things were wrong with that script, and the first is a correction to what I wrote in §85:

1. **It measured the wrong plane.** The script now writes the payload on **both** — bare `asyncpg.connect`
   and the same connection with `nexus_ai.db.pool._init_connection` registered, which is what the service
   actually hands every request — and *the verdict reads the service plane*. My original probe used the
   bare driver and concluded "CORRECT". That was true of the driver and not of the service, which is the
   difference the 20 stale rows were the fingerprint of. The lesson is the same one this ledger keeps
   relearning: a measurement is only as good as the plane it is taken on, and "the same library" is not
   "the same code path".
2. **It could not run anywhere but this machine.** `HOST/PORT/APP/DEMO` were hard-coded to
   `nexus_app`/`nexus_dev_app_only`, so a scheduled run would have failed to connect and looked like a
   driver problem. It now reads `NEXUS_TEST_DATABASE_URL` — the variable the AI suite and CI already use —
   with `NEXUS_DEMO_DATABASE_URL` for the residue census, and reports the census as *unavailable* (not as
   zero rows) when it is unset, because CI does not seed `nexus`.

Wired as a step in the `ai` job, run through `uv` from `apps/ai` so the `nexus_ai.db.pool` import resolves —
a root-level run would measure only the bare driver, which is the mistake the script exists to stop.

```
cd apps/ai && NEXUS_TEST_DATABASE_URL=… ./.venv/Scripts/python.exe ../../scripts/verify_jsonb_binding.py
  plane    stored jsonb_typeof   ->>query                 dict instead
  default  object                'sha tin restaurant'     rejected by asyncpy (expected str, got dict)
  service  object                'sha tin restaurant'     rejected by asyncpy (expected str, got dict)
  verdict on the service plane    CORRECT — one encoding, keys readable

  LIVE RESIDUE (demo DB)
    events.properties / context                  4 each   newest 2026-09-27 15:34Z
    agent_runs.tool_calls / retrieval / plan      4 each   newest 2026-09-27 15:34Z
    agent_runs.tool_calls (NOT string)            8        newest 2026-09-28 13:56Z
  exit 0

python -c "yaml.safe_load(open('.github/workflows/ci.yml'))"   → ai job parses, 8 steps
```

The 8 object-valued rows dated after the 20 stale ones are the writer being fixed, measured rather than
asserted — the residue is historical and cannot grow.

### 2026-09-30 13:35 — the drift reader's blind spot: 8 citations it refused instead of judging

The queue moved while this plan sat — P3's first item (the §28 SEO quality gate) turned out to be
**already witnessed**: `SeoReadTest.assertGate(...)` drives seven arms of it (`unreviewed_ai`,
`enough_listings`, `below_quality_bar` including the score-vs-review ordering, a null score not being a
failure, the listing bar deciding alone), and `seo_pages` is empty in the seed because D64 keeps it so. So
the queue is re-derived from the ledger tail rather than from this file's P3 list.

The live frontier (§206 / D201) is the citation-drift reader, and running it exposed a blind spot:

```
node scripts/check_line_cite_drift.mjs        before → after
  NOT-AT-HEAD — 12 site(s)                      4 site(s)
  judged by content                             139 → 147
  RESULT: REPORT — 125/147 citations still name the line they were written against
```

Twelve citations were classified `NOT-AT-HEAD` ("names no file at HEAD") and **left out of the judged
population** — printed honestly, concluded wrongly. All twelve name files that exist at HEAD with the cited
line inside them: `apps/ai/nexus_ai/search/sql.py` is 520 lines and the citation asks for `:137`. The
verdict was true of `HEAD:search/sql.py` and false of the citation, because the reader only ever asked
`git show HEAD:<what the ledger wrote>`.

**Fixed:** the reader now indexes every path at HEAD by every suffix it has, and resolves a citation
written as a path tail when exactly one file matches. Two or more matches are **not guessed**: they become
`AMBIGUOUS` and stay counted, so unjudged citations remain visible instead of being spent on a coin flip.
Eight of the twelve now judge (139 → 147).

**The remaining four are the reader being right, and are worth the separate verdict they now carry.** All
four cite files that exist in the working copy and are **not tracked at HEAD** —
`services/platform/src/main/java/com/nexus/commerce/CartService.java`,
`.../merchant/MerchantContentController.java`, `apps/ai/nexus_ai/api/runs.py` (checked with
`git ls-files --error-unmatch`). So the ledger cites **uncommitted code**, which resolves on this machine
and not from a clean checkout — the same objection D113 made to a witness kept outside the repo. The reader
now says exactly that:

```
docs/DECISIONS.md:4906 -> apps/ai/nexus_ai/api/runs.py:144 is not tracked at HEAD — the file exists in
                          the working copy only, so a clean checkout cannot resolve this citation
```

Reported rather than repaired: the fix is to commit those files, which belongs to the lanes that own them,
and "your citation points at code you have not committed" is the kind of finding this ledger exists to make
visible rather than to paper over.

### 2026-09-30 13:45 — re-aiming can launder a wrong citation into a green one

`--reaim` exists and is the cheap way to clear MOVED, so it was the obvious next step. It derived two rows;
I applied **one** and deliberately left the other.

```
node scripts/check_line_cite_drift.mjs --reaim
  reaim  docs/STATUS.md:6678   data/seed/falsifier_plants.py  1292 -> 1286
  reaim  docs/DECISIONS.md:5253  data/seed/quality.sql        2390 -> 2381
  RESULT: REAIM — 2 derived row(s)
after applying the second only:
  RESULT: REAIM — 1 derived row(s)
```

**The one I applied is sound.** `docs/DECISIONS.md:5253`'s sentence is "`data/seed/quality.sql:2390` keeps a
degenerate timestamp column when its value falls between the window", and line **2381** is exactly
`AND extract(epoch FROM (c.val)::timestamptz) BETWEEN w.lower AND w.upper;`. Content match and meaning
agree, so the number is now 2381.

**The one I left is a wrong target, not a stale number, and the tool cannot tell the difference.** The
sentence reads "(data/seed/falsifier_plants.py:1292). Among the eleven is `orphan: favorites.offering`" —
and:

- `orphan: favorites.offering` **does not occur anywhere in that file**. The marker list carries
  `orphan: favorites.collection` (:238), `orphan: favorites.guide` (:241) and the `orphan: facts.*` trio
  (:228); the offering favourite appears only in the D200 staged text under `.scratch/`, as a *data* type,
  never as a plant marker.
- The derived target, line **1286**, is `if len(hit) == 1:` — inside the loop that *validates* markers
  against the registry, three lines above `failed.append(f"{label}: {len(hit)} assertions match the marker
  …")`. It has nothing to do with which eleven markers exist.

Applying it would take a citation that is visibly stale and make it **invisibly wrong**: the drift reader
would report it EXACT from then on, because EXACT only asks whether the text the citation was written
against is still at the line. That is a laundering operation, and it is worse than leaving the number
stale — a stale number is a question someone will ask again, an EXACT row is an answer nobody will.

This is the reader's own declared limit ("it cannot check that the line says what the sentence claims")
biting on a case where the limit is the whole problem. The residue it leaves is the same one task #126
names, one step further out: not just *does the ledger's number match the code*, but *does the ledger's
citation point at something that could support its sentence*. Neither reader asks that yet.

### 2026-09-30 13:50 — task #126: the ledger's numbers get a reader, and the reader's first bug was its own

The citation reader judges a `file:line` by asking whether the text it was written against is still there.
Task #126 asks for the same reader aimed at **figures instead of positions**. A census first, because that
is this project's method and because the size of the problem is the thing to measure:

```
grep -ohE "[0-9]+ (quality checks|checks|plants|cases|arms|sites|citations|rows|assertions|steps|files)" \
  docs/STATUS.md docs/DECISIONS.md | sort | uniq -c | sort -rn | head
     63 216 assertions
     34 216 quality checks
     23 216 checks
```

**`216` is written 120 times and linked to nothing.** Add one check to the gate and 120 sentences go stale
with nothing reddening — the same failure this repository has already met in three other shapes.

`scripts/check_ledger_numbers.mjs` is the census half:

```
node scripts/check_ledger_numbers.mjs --top 5
  claims read              967 over docs/DECISIONS.md, docs/STATUS.md
  nouns known              11

  rows             newest      4  docs/STATUS.md:9832
  files            newest    587  docs/STATUS.md:10743
  arms             newest      6  docs/STATUS.md:10752
  checks           newest      8  docs/STATUS.md:10599
  assertions       newest    216  docs/STATUS.md:8434
                   values 216×63 · 214×18 · 213×1 · 22×1 · 20×1 · 12×1 · … 3 more
                   answered by the gate’s own printout

RESULT: UNCHECKED — no expectation given, so no claim was judged.   exit 2
```

**It refuses to pass a verdict without a source for the number**, which is the whole point: "I have no idea
what the right number is" and "the number is right" must not print the same way. `--expect "assertions=216"`
judges the newest claim for that noun and nothing else.

**Its first bug was its own, and the first run found it.** `newest` was "the last occurrence in reading
order", and because `DECISIONS.md` was read second, the newest claim about `checks` came back as **8**
(`docs/DECISIONS.md:9730`) — a number in a sentence about something else. Newest now means the latest
**section**, with `STATUS.md` read last because it is the ledger of record for where the build stands. The
same first run also cost a rewrite of the flag handling: `cli_args.mjs` returns `{ok, value, flag}` and
refuses a value flag given twice, so `--expect` is comma-separated rather than repeatable — one dialect, as
D158 intends.

**What it cannot do**, stated because a census that hides its blind spots is the thing this ledger keeps
catching: it reads numbers, not meanings, so `checks` still picks up an incidental "8 checks" in a sentence
about arms, and `rows` mixes "4 rows" (a probe result) with "22,592 rows" (a corpus size). Only the noun
`assertions` is unambiguous today, and that is the one worth wiring to a gate run first.

**Judgement pending**: the authoritative count comes from `scripts/db_gate_fresh.sh`, which is running now.
Until it prints, the 216 above is the ledger's own claim and not a verified number.

### 2026-09-30 14:05 — #126's first verdict: the ledger is one behind, and the gate's step 7 is the sandbox

The authoritative number came from a real gate run (15m39s, `TMPDIR=/tmp`):

```
scripts/db_gate_fresh.sh
  5/12  data/seed/quality.sql (the hard gate)
        -> 217 quality checks passed against a from-scratch schema (tables=58, migrations=8)
  6/12  seed_truncate_probe.sh          RESULT: PASS
  7/12  check_jsonb_reads.mjs           RESULT: NOT CHECKED — the shipped plane is not green (rc null, control rc null)
  EXIT=2
```

**The ledger is stale by one.** Its newest claim about `assertions` is **216** (`docs/STATUS.md:8434`), and the
gate now files **217** — a check was added and the 120 sentences that say 216 did not move. The new reader
catches exactly this, and both directions were run:

```
node scripts/check_ledger_numbers.mjs --expect "assertions=216"   → MATCHED     exit 0   (the ledger agrees with itself)
node scripts/check_ledger_numbers.mjs --expect "assertions=217"   → MISMATCHED  exit 1   (the ledger disagrees with the gate)
```

That is the whole point of the tool: `216` is not a number the ledger can check on its own, and neither can
anyone reading it. The residue is a **one-line correction in the newest section** plus the question of
whether the older sections should be left dated (they should — this ledger is append-only and a 215 written
when 215 was true is not wrong).

**Step 7's red is the sandbox, and the tool now says so.** `falsify_quality_seam.mjs` spawns a child node
process for both planes; `spawnSync` returned `status: null` and the verdict read only
`the shipped plane is not green (rc null, control rc null)` — which looks like a reader that failed. It was
a process that was never started:

```
before:  RESULT: NOT CHECKED — the shipped plane is not green (rc null, control rc null)
after:   RESULT: NOT CHECKED — the shipped plane is not green (rc null — the child could not be started:
                             EBUSY, control rc null — the child could not be started: EBUSY)
```

`EBUSY`, the same restriction that makes `spawnSync git` fail here. So steps 7-12 of the gate cannot run in
this sandbox at all, and the message now distinguishes "the reader said nothing" from "the reader never
started" — the same distinction `UNCHECKED` carries everywhere else. In CI, where child processes spawn,
step 7 is the step it was written to be.

### 2026-09-30 14:25 — #126 closed the loop: the number is now a claim, and the reader agrees

The unit is finished end to end, which is the part worth recording: a reader was built, it found the ledger
wrong, the ledger was fixed in the way an append-only ledger allows, and the reader now agrees.

```
node scripts/check_ledger_numbers.mjs --expect "assertions=217"
  assertions: newest 217 (docs/STATUS.md:…) vs expected 217 — MATCHED
RESULT: MATCHED — all 1 newest claim(s) agree with the value passed in      exit 0

node scripts/check_line_cite_drift.mjs
  RESULT: REPORT — 125/147 citations still name the line they were written against   (no new MOVED)
```

**Four of the tool's own bugs were found by running it, not by reading it** — which is the same lesson this
session has now produced four times, aimed at my own work:

1. `newest` meant "last occurrence in reading order", so with `DECISIONS.md` read second the newest claim
   about `checks` came back as **8** (`docs/DECISIONS.md:9730`). Newest now means the latest **section**.
2. `parseFlags` returns `{ok, value, flag}` and refuses a value flag given twice, so `--expect` had to become
   comma-separated. Reading `cli_args.mjs`'s header instead of its return statement cost a rewrite.
3. The section written to record that the gate now files 217 was itself read as claiming 216, because it
   *quotes* 216 in an evidence block. A number inside a fence is now **evidence, not an assertion**.
4. Fence pairing across a whole file is off by one from the first unbalanced section — and this ledger has
   **thirteen** of them (`docs/STATUS.md` carries 265 fence lines, an odd number). Fences are now paired
   **per section**, and a section whose count is odd is skipped and **reported** rather than guessed at.
   That is a documentation defect this tool surfaced by needing to be correct about it.

The last fix is why the number is now stated in prose: `**The gate now files 217 assertions**` sits in §207
as a sentence, because a claim that exists only inside a code fence is a claim no reader can judge. §154's
`216 assertions` stays exactly as written — it was true when written, and rewriting it would destroy the
only evidence of when the count changed.

Remaining, and named rather than left implied: the 13 fence-unbalanced sections are a documentation queue
(somebody's missing or extra closing fence); `checks` and `rows` remain meaning-ambiguous nouns that the
reader reports but cannot judge; and the `--expect` value has no automatic source yet — the number still has
to be carried from a gate run by hand, which is the next thing to wire.

### 2026-09-30 14:30 — P1 done: thirteen sections of the ledger were missing their closing fence

The numbers reader surfaced this by refusing to guess: it skips a section whose fence count is odd, and
reported thirteen of them. Diagnosed rather than assumed — each of the thirteen has **exactly one** fence
line, an opening one, and the evidence block runs on into the next section because nothing closes it:

```
docs/STATUS.md   before: 10883 lines, fence parity 1 (odd), 13 unbalanced sections
                 after:  10896 lines, fence parity 0,      0 unbalanced sections
diff: 13 inserted lines, every one a bare ``` ; nothing else changed
```

**Why this was safe to do, and checked rather than hoped:** `check_line_cite_drift.mjs` reads `HEAD` for
both sides of its comparison, so a working-tree edit to `STATUS.md` cannot move any of its verdicts. What it
*can* break is a **citation that names a STATUS.md line**, because inserting lines shifts them — and there
were **11 such citations** (`grep -rohE "STATUS\.md:[0-9]+"`). Every one of them sits after the last
insertion, so all eleven move by exactly +13, and all eleven were re-aimed in the same pass:

```
STATUS.md:8421 ×4 -> 8434      STATUS.md:9819 -> 9832     STATUS.md:6665 -> 6678
STATUS.md:4634    -> 4647      STATUS.md:10739 -> 10752   STATUS.md:10730 -> 10743
STATUS.md:10600   -> 10613     STATUS.md:10586 -> 10599
```

Verified after the fact rather than declared: line **8434** still holds `so no gate number moved: 216
assertions and 359 registry rows before and after.` — the citation still points at the sentence it names.

**What this did and did not buy.** It fixed a real markdown defect (thirteen blocks whose code fences
swallowed the text after them) and made those sections parseable. It did **not** add many numeric claims to
the census: 560 -> 562, because the sections from that era spell their numbers as words — §61 says "the
schema has **25**, and the seeded dataset writes **five** of them". A digits-only reader cannot see those,
which is a limit of the reader and not of the ledger, and it is now stated instead of being left to look
like coverage that was never there.

### 2026-10-01 14:55 — P2 verified end to end: the gate now measures the number and judges the ledger with it

```
=== 5/12  data/seed/quality.sql (the hard gate)
    -> 217 quality checks passed against a from-scratch schema (tables=58, migrations=8)
    RESULT: MATCHED — all 1 newest claim(s) agree with the value passed in
      Scoped, deliberately: this says the newest sentence carries the number it was told to expect.
      It does not say the number is right — only the artefact that produced it can say that.
```

The claim written as unverified in the previous entry is now measured. The gate's own count is the
expectation, the ledger's newest claim is the defendant, and the step passes — with the number no longer
carried across by hand, which is how 216 came to be written 120 times.

The gate's only remaining red is step 7, and it is the sandbox rather than the tree: `EBUSY` on spawning a
child process, printed with that reason since this session's fix (`falsify_quality_seam.mjs` used to say only
`rc null`). Steps 7-12 cannot run on this machine at all; in CI they are the steps they were written to be.

### 2026-10-01 15:10 — P3: the reader learns the numbers these ledgers write as words

Census before code, as usual — and the census said yes:

```
two arms 30 · two rows 29 · two files 26 · three rows 22 · eleven steps 10 · seven steps 8
twenty-seven files 2 · forty-four citations 2 · fifty-eight tables 2 · twenty assertions 2
```

§61 says "the schema has **25**, and the seeded dataset writes **five** of them" — a claim about this
repository, written in words, invisible to a digits-only reader. Compounds are handled in both spellings
(`twenty-seven`, `twenty seven`); a form the map does not know is **not counted rather than guessed at**.

```
claims read   562 -> 623      (the net within parseable, non-fenced prose)
node scripts/check_ledger_numbers.mjs --expect "assertions=217"
  RESULT: MATCHED      exit 0        ← the wider net did not disturb the gate's own judgement
```

That last line is the one that mattered to check: the gate's new step-5 check calls
`--expect "assertions=$CHECKS"`, and a broader pattern that pulled a word-number into the newest section for
`assertions` would have turned it AMBIGUOUS and stopped the gate. Measured, not assumed.

Still open on this plane: the 4 `NOT-AT-HEAD` citations into uncommitted code, the 1 remaining MOVED, and
the reader one step further out — *does this citation point at something that could support its sentence*,
which neither the position reader nor this one asks.

### 2026-10-01 15:12 — P1b done: DECISIONS.md had the same defect, found by the mode built to catch it

`--census` exited 1 on its first run, naming ten sections of `docs/DECISIONS.md` with an odd fence count —
the same defect P1 fixed in `STATUS.md`, in the ledger I had not checked. `DECISIONS.md`'s *overall* parity is
even (144 fence lines), which is exactly why the whole-file check I used for P1 could not see it: **balanced
in total, unbalanced in ten places**, and every section after the first one renders wrong.

Fixed with one script rather than two edits, because the fence fix and the citation re-aim have to be
computed from the same insertion points — doing them in two passes is how a tree ends up half-shifted:

```
docs/DECISIONS.md  11357 -> 11367 lines (+10, one closing fence per odd section)
citations naming a DECISIONS.md line, re-aimed by the number of insertions before each:
  STATUS.md:6528 -> 6538      DECISIONS.md:9087 -> 9097      DECISIONS.md:9688 -> 9698
  PLAN.md:9720 x2 -> 9730     STATUS.md:9720 -> 9730         DECISIONS.md:9342 -> 9352
  check_ledger_numbers.mjs:9720 x2 -> 9730
```

Verified afterwards, not declared:

```
node scripts/check_ledger_numbers.mjs --census
  RESULT: PASS — 632 numeric claim(s) read, every section's fences balanced, 11 noun(s) seen   exit 0
node scripts/check_ledger_numbers.mjs --expect "assertions=217"                                exit 0
sed -n '9730p' docs/DECISIONS.md
  **The question, asked with numbers instead of adjectives.** Step 8 checks that a cited file has the …
```

The spot-check is the one that matters: the re-aimed line is the sentence the citation was naming, so the
+10 is right and not merely arithmetic that happened to run. Claims read rose 623 -> 632 as the ten
previously-skipped sections became parseable.

Remaining on this line: the CI step that runs `--census` (the mode exists and is verified; the wiring is
not), and the two readers' blind spots — `MOVED` by 1, `NOT-AT-HEAD` by 4 into uncommitted code, and the
question neither asks: whether a citation points at something that could support its sentence.

### 2026-10-01 15:16 — P2 closed: the census is in CI, and it fails on the defect it was written to catch

```
.github/workflows/ci.yml   contract-drift job, 12 steps, mine is step 6:
  - Ledger numbers are a census that can run, and the prose is still parseable
      node scripts/check_ledger_numbers.mjs --census | tee ledger-numbers.txt
local exit code of exactly that command: rc=0
python -c "yaml.safe_load(ci.yml)" → parses
```

It runs the **census** half, not the judged half, and the reason is stated in the step's own comment rather
than left to be inferred: judging a number needs the count a gate run produces, and that path is step 5 of
`db_gate_fresh.sh`. What a census knows on its own is still worth failing on — that the reader can read the
ledgers, and that no section has slipped back into an odd number of fences. The second is not hypothetical:
it is exactly how the ten unbalanced sections of `DECISIONS.md` were found, *after* a whole-file parity check
had declared `STATUS.md` fixed. `exit 1` means the defect is back; `exit 2` means the census could not run,
which is not the same as a clean ledger.

That closes the ledger-auditability line this session has been on. What remains is named and not implied:
the 4 `NOT-AT-HEAD` citations into uncommitted code (a commit decision for their owners), the 1 remaining
`MOVED`, and the reader neither of the two existing ones is — *does this citation point at something that
could support its sentence*, which is a question about meaning rather than position or figure.

### 2026-10-01 15:20 — the third reader: a census of citations whose sentence shares no identifier

The two existing readers answer checkable questions (does the file/line exist; is the text still there).
Neither asks whether the line is *about* what the sentence says — the limit §206 states, and the one this
session hit twice in an hour: a citation to `falsifier_plants.py:1292` whose sentence names a marker that file
does not contain, and a `--reaim` that would have moved it to the marker-*validation* loop, laundering a
visibly stale citation into an invisibly green one.

`scripts/check_citation_supports_sentence.mjs` does not read prose. It takes the **identifiers** in the
sentence a citation sits in (backticked spans, `snake_case`, `camelCase`, dotted names) and asks whether the
cited line's neighbourhood mentions **any** of them:

```
node scripts/check_citation_supports_sentence.mjs --limit 6
  citations seen           159 over docs/STATUS.md, docs/DECISIONS.md
  judged                   159
  window                   ±3 line(s) around the cited line
  sharing nothing          62 of 159
    docs/DECISIONS.md:4909 -> …/growth/EventRepository.java:39   (31 identifiers, none in the neighbourhood)
    docs/DECISIONS.md:5170 -> docs/DATABASE.md:88                (28 identifiers, none in the neighbourhood)
    docs/DECISIONS.md:11192 -> scripts/falsify_quality_seam.mjs:396
    …
RESULT: CENSUS — nothing was judged, deliberately.        exit 0
```

**It exits 0 whatever it finds, and that is the design.** Zero shared identifiers is a question, not a
defect: a sentence may cite a line for its position in a narrative, or for a value the neighbourhood does not
spell. One shared identifier is not proof either — the same "consistent with, not proof of" standard the jsonb
site census already uses. What the list is for is the case measured on 2026-09-30.

**Its precision is low and that is stated rather than dressed up.** The identifier extractor keeps a trailing
hyphen (`agent_runs.plan-`), and a sentence carrying two citations is judged twice against both. So 62 is an
upper bound on "worth a human's minute", not a defect count. The honest next step is to tighten the extractor
and to require the citation to be *the* subject of the sentence rather than one of several, and that is a
queue item, not a claim of this unit.

### 2026-10-01 15:25 — the third reader's numbers do NOT add up yet, and that is where this unit stops

Tightening the extractor was the named next step, and it produced a result I cannot stand behind:

```
first run of check_citation_supports_sentence.mjs    citations seen 159   judged 159   sharing nothing 62
after the extractor/attribution patch                citations seen 418   judged  95   skipped 263  sharing nothing 43
```

**Same code, two consecutive runs: identical (418 / 95 / 263).** So the tool is deterministic, and this is not
flakiness. **`git show` works 20 of 20 times** in a direct probe, so the 263 "not at HEAD" rows are genuine
paths that do not resolve at HEAD, not sandbox failures. And the two patches I made — trimming punctuation in
`identifiers()`, and attributing identifiers to the nearest clause in `clauseFor()` — change *which
identifiers* are compared, not *how many citations are counted*. The citation count should not have moved, and
it moved by 2.6x.

I checked the obvious suspect and it was wrong: I first blamed the module-level `g`-flagged `CITE` regex having
its `lastIndex` consumed by the new `clauseFor` call, replaced it with a fresh-regex factory, and the numbers
did not budge. The diagnosis is recorded here as a wrong hypothesis rather than quietly deleted.

**So this unit stops short of a claim.** What is verified: the reader runs, is deterministic, and its
`git show` layer is reliable. What is not: which change moved 159 to 418, and therefore whether "43 of 95" or
"62 of 159" describes anything real. The next step is to recover the first version's logic and diff the two
citation walks line by line — not to report a number. This is the same rule the whole session has been run
under: a figure nobody can explain is worse than no figure, because it looks like coverage.

### 2026-10-01 15:33 — the delta explained at last: the FIRST number was the wrong one

The step was to explain why the same tool reported 159 citations and then 418. An independent count settles
which one is real:

```
grep -ohE "[A-Za-z0-9_./-]+\.(java|py|ts|…|md|txt):[0-9]+" docs/STATUS.md docs/DECISIONS.md | wc -l
  470          (STATUS.md 215 + DECISIONS.md 255)

check_citation_supports_sentence.mjs   418
the first run of the same tool         159     ← refuted
```

So the number I was worried about was **159**: the first version undercounted by a factor of three, and 418 is
much closer to the independent 470. The tightening patches did not inflate anything — they were shipped
alongside a number that had been wrong from the start, and the "2.6x jump" I could not explain was the
**first measurement being bad**, not the second one being loose.

**This is the case for the census-first habit stated as a result rather than a slogan.** A reader built to ask
a weak question was believed for one run because it printed a tidy pair of equal numbers (`citations seen 159,
judged 159`), and equal numbers read as consistency. They were consistent with each other and wrong about the
ledger.

Two things remain, both now precisely stated rather than vague:

- **418 vs 470**: the tool still misses 52 citations the independent scan sees. That is a bounded, concrete
  gap to close, and it is the honest next step — not a claim that the census is complete.
- The identifier proxy's precision (43 of 95 sharing nothing) is **unjudged** until 418 and 470 agree, because
  a citation the walk never reaches cannot be counted as judged or as clean.

### 2026-10-01 15:35 — the 52-citation gap is in the walk, not the pattern, and is still open

Measured instead of reasoned, after two rounds of theory that both went nowhere:

```
node -e "…the tool's own regex, over the same two files…"   → 470 matches, 108 distinct paths
grep -ohE "…same extension list…" | wc -l                    → 470
check_citation_supports_sentence.mjs                         → 418
```

**The pattern matches 470.** So the tool loses 52 between matching and counting, and the counting loop is
correct on inspection — `citations += 1` runs for every match, before the `git show` that can throw:

```js
for (const m of line.matchAll(citePattern())) {
  const [, path, numStr] = m;
  citations += 1;
  …
  try { target = git('show', `HEAD:${path}`); } catch { unresolved += 1; return; }
```

The `return` in the catch exits the line's callback and so skips any *later* matches on that line, but every
match up to and including the failing one has already been counted, so that cannot lose 52 by itself. The two
remaining candidates — a `citePattern()` that differs from the one-liner's pattern in a way I have not read
closely, or the `catch { return }` skipping later matches on multi-citation lines — are both cheap to settle
by printing the per-line match count beside the counted total.

**Where this stops, and why.** The unit's *number* is now qualified in the way the whole session has insisted
on: 470 is the count an independent tool gives, 418 is what this reader reaches, 159 was simply wrong. The
identifier result (43 of 95) remains **unjudged** until those agree, because a citation the walk never reaches
is neither judged nor clean. Two theories have already been written into this log as wrong; a third would be
the same mistake with a different noun.

### 2026-10-01 15:37 — the 52 were a `return` where a `continue` was meant, and the census is now whole

The discriminator settled it in one run — the same pattern, scanned directly, beside the walk's own total:

```
  citations seen                        418   ← the walk
  the same pattern, scanned directly    470   ← 52 match(es) the walk did not count
```

So the pattern was never the problem, and the walk lost them in its control flow. Both `return`s inside the
per-line callback were meant to be `continue`s:

```js
for (const m of line.matchAll(citePattern())) {      // per MATCH
  …
  try { target = git('show', `HEAD:${path}`); }
  catch { unresolved += 1; return; }                 // ← ended the LINE, dropping every later citation on it
  …
  if (wanted.length === 0) return;                   // ← same, for sentences with nothing mechanical in them
```

`forEach` runs per **line** and the loop runs per **match**, so `return` leaves the line while `continue`
leaves the match. Fixed in both places:

```
  citations seen                        470
  the same pattern, scanned directly    470      ← they agree
  judged                                 95
  skipped: target not at HEAD           311      (was 263: the 48 recovered citations all point at files
                                                  that are not at HEAD, which is why a `git show` failure was
                                                  the trigger for losing them in the first place)
  sharing nothing                    43 of 95
```

**What this buys, stated precisely:** the identifier result is now reported over a **complete** population.
Before the fix, 52 citations were never reached, and a citation the walk never reaches is neither judged nor
clean — so "43 of 95" would have been a fraction of an unknown whole. The count is now corroborated three ways
that were built independently: the walk, a direct scan of the same pattern, and `grep -ohE … | wc -l`.

The lesson this unit cost, and it is worth more than the fix: **a reader that loses part of its population to
its own control flow reports a smaller number, not a wrong one.** 159 was obviously wrong once something else
was counted. 418 was wrong by 11% and looked exactly like a clean result — equal to nothing, suspicious of
nothing, and printed beside a second number (95) that also looked fine. Only an outside count could see it.

### 2026-10-01 15:40 — auditing the other two readers for the same bug: one is clean, one does not reconcile

The `return`-for-`continue` bug is a *class*, not an incident, so the same discriminator was run against the
other two citation readers. Their numbers, read off their own output:

```
check_line_cite_drift.mjs
  EXACT 85 · MOVED 26 · NOT-UNIQUE 5 · GONE 18 · NO-BASE 13 · UNPATHED 262 · NOT-AT-HEAD 4 · AMBIGUOUS 0
  sum of printed classes     413
  "judged by content"        147
  content classes (EXACT+MOVED+NOT-UNIQUE+GONE)  134
```

**No silent loss of the kind just fixed.** The 3x gap that looked like the same bug is `UNPATHED 262` —
citations written as a bare basename, which this reader *prints and counts* as a refusal rather than dropping.
That is why the audit was even possible: a reader that names its refusals can be checked by arithmetic, and
one that drops matches cannot. The class exists because of a decision this session already leaned on twice.

**But two of its own numbers do not reconcile, and that is the next unit.**

- **147 vs 134**: `judged by content` is 13 more than the content-judged classes sum to. Either one class is
  counted twice or the label covers a class it does not name.
- **413 vs 470**: the class sum is 57 short of the independent count. Part of that is real and expected — this
  reader reads the ledgers at **HEAD**, and the working copy is ahead by this session's sections — but 57 is
  more than those sections carry, so part of it is not explained.

Neither number is reported as a defect. Both are *unreconciled*, which is a different thing and the reason
they are written here instead of being rounded into a sentence about the reader being fine.

### 2026-10-02 15:20 — my own plane cleaned (D94), and a third tool taught the null-vs-undefined difference

The project moved a long way while this plan sat: the ledger is at §209+/D205+, the working copy is level with
HEAD (479 citation-shaped tokens on both), and **`check_ledger_numbers.mjs` is now gate step 17** — the commit
for D205 records it as "step 17 all three newest claims MATCHED". Two things on that plane were still mine to
fix.

**1. My scripts were violating D94.** The rule is: *a comment that shows the grammar writes digits as `NN`.*
My probe illustrated itself with live citations, and `docs/DATABASE.md:88` — an empty line — became a claim
the ledger's own readers had to resolve. Four sites, all now `:NN`:

```
scripts/check_citation_supports_sentence.mjs   `docs/DATABASE.md:NN`, `.github/workflows/ci.yml:NN`
                                               `falsifier_plants.py:NN`
scripts/check_ledger_numbers.mjs               `docs/DECISIONS.md:NN`  (twice)
```

Verified: no digit-shaped illustrative citation remains in either script. The remaining
`docs/DATABASE.md:88` row is cited by `docs/DECISIONS.md:5170` — a sentence *about* two citations, in another
lane's section, which the gate's own note already assigns to its owner rather than editing in place.

**2. The comment plane's verdict was misleading, and the reason was a null.** `check_comment_citations.mjs`
spawns the ledger checker as a child, and this sandbox refuses node-spawning-node. Its catch did
`code = err.status ?? 1` — and **`execFileSync` sets `status` to `null` on a spawn failure, not `undefined`** —
so the null became a `1` and the verdict read `step 8 produced no report (exit 1)`, a sentence about a reader
that ran and found something. My first guard tested `err.status === undefined` and therefore never fired:

```
before:  RESULT: NOT RUN — step 8 produced no report (exit 1). …
after:   RESULT: NOT RUN — step 8 produced no report (exit 1), and it was never started: EBUSY. …
```

That is the third tool in this repository to learn the same distinction — `falsify_quality_seam.mjs`
(`rc null` for both planes), the gate's own step 7, and now this one — and each time it arrived through a
*different* JavaScript subtlety: `status: null` vs `status: undefined`, `??` turning one into a plausible
number, and a `return` in a per-line callback where a `continue` belonged. The class is one sentence long:

> **A process that never started and a process that ran and found nothing must not print the same line.**

### 2026-10-02 15:25 — the two unreconciled numbers reconcile: the label was wrong, and fixing it broke the reader first

**The measurement, not the theory.** `check_line_cite_drift.mjs:280` computes `judged` as
`JUDGED.reduce(...)`, and line 180 declares what `JUDGED` is:

```js
const JUDGED = ['EXACT', 'MOVED', 'NOT-UNIQUE', 'GONE', 'NO-BASE'];
```

Today's counts: EXACT 117 · MOVED 10 · NOT-UNIQUE 2 · GONE 17 · **NO-BASE 1** · UNPATHED 262 · NOT-AT-HEAD 4.
The content classes sum to **146**, and `judged by content:` prints **147**. **Confirmed on two points**: when
NO-BASE was 13 the excess was 13; now that it is 1 the excess is 1. So the excess *is* NO-BASE, and the label
`judged by content` is false for it — NO-BASE means the citation has **no blame author**, i.e. reached and
refused, never content-judged.

**Checked who parses the line before touching it.** `falsify_line_cite_drift.mjs:70` reads it with the exact
regex `^judged by content: (\d+)$`. Renaming the label would have stopped the arm harness dead, so the fix is
**additive**: the parsed line keeps its shape and a second line names the members.

```
judged by content: 147
  judged classes: EXACT + MOVED + NOT-UNIQUE + GONE + NO-BASE — NO-BASE has no blame author, so it is
                  reached rather than judged
RESULT: REPORT — 117/147 citations still name the line they were written against (strict=none)   rc=0
harness regex parses: 147
```

**And the first version of that clarification took the reader down.** `JUDGED` is scoped to `census()`, and the
new line printed it from outside — `ReferenceError`, exit 1, **no RESULT line at all**. Caught by running the
reader immediately after the edit rather than by reading the diff; fixed by returning `judgedClasses: JUDGED`
from `census()` and printing `r.judgedClasses`. A reader that dies to add a clarifying sentence is worse than
the unclear sentence it was clarifying.

**Verified to the limit of this machine.** Reader: healthy, rc 0, parsed line unchanged, harness regex still
matches. Harness end to end: **cannot run here** — `spawnSync git EBUSY`, the sandbox refusing to spawn git,
which is the fourth appearance of that class this session and the reason its arms are labelled unverified
rather than passed.

### 2026-10-03 12:50 — the spawn class gets one helper, and a fourth JS subtlety behind it

`scripts/spawn_guard.mjs` now carries the vocabulary STATUS §224 asked for: `spawnReason`, `isSpawnFailure`,
`guard` (for `execFileSync`) and **`spawnResult`** (for `spawnSync`). Four of the six tools that died without
a verdict now refuse with a reason and exit 2 — and the newest one names which git call failed:

```
falsify_plane_reads    RESULT: NOT CHECKED — this harness commits to real throwaway repositories, and
                       git init -q could not be started: EBUSY.
                         No arm below was run. A refusal is not a failure, and the two must not share a
                         verdict line.                                                            exit 2
```

**A fourth JavaScript subtlety behind the same class, found by the helper failing.** My first `guard()` only
caught exceptions — and `execFileSync` throws on a spawn failure while **`spawnSync` does not**: it returns an
object with `error` set and `status` null. So `falsify_plane_reads.mjs` still crashed, on
`Cannot read properties of undefined (reading 'trim')`, three lines *below* the guard I had just added. The
same event, two reporting conventions, and a helper that covers one of them is a helper that half works.

```
refusing with a reason (exit 2)  falsify_quality_seam · check_comment_citations · falsify_line_cite_drift ·
                                 falsify_plane_reads
still dying with no verdict      citation_blank_census · citation_blank_sites · falsify_ledger_sections ·
                                 falsify_ledger_text        ← each needs guard() + spawnResult() per site
```

Unchanged and re-verified: `check_ledger_numbers.mjs --census` PASS (733 claims, fences balanced) and
`check_line_cite_drift.mjs` REPORT 127/147.

### 2026-10-06 — basename resolution: attempted twice, abandoned, and the tool was left the way it was

The sentence-support census sees 499 citations and judges 100. Of the 324 it skips, about 262 are written as
a **bare basename** — `sql.py:137` — and those files *are* committed; the gate's own step 8 resolves them and
names AMBIGUOUS when two files share a name. So the largest coverage gap in a reader I own had an obvious
source to copy, and it was worth two attempts:

```
1  walkFiles(ROOT, LEDGER_EXT) at import time       → rc=124, the run exceeded four minutes (it walks
                                                      node_modules)
2  `git ls-files`, lazily, only when a citation
   needs it — the right source in principle, since
   the tracked set is exactly what `git show HEAD:`
   can serve                                        → rc=124, it hangs too
```

**Both were reverted rather than left in the tree.** A reader that hangs is worse than a reader with a
smaller population, and twice-attempted is the point at which the next move is a measurement, not a third
guess at what the sandbox will tolerate. Verified healthy after the revert, with the discriminator intact:

```
citations seen 499 · the same pattern, scanned directly 499 · judged 100 · skipped 324
sharing nothing  42 of 100                                                          rc=0
```

**Also measured and deliberately unexplained:** `scripts/falsify_console_a11y.mjs` exits **127 with zero
bytes of output**, and there is no `process.exit(127)` anywhere in the file — so the 127 is not a decision
the script made. This log already carries two hypotheses that measurement refuted; a third would be the same
mistake with a different noun, so this is recorded as a fact and left for whoever can observe the process.

### 2026-10-06 (late) — D233 landed, the 127 refuted by re-measurement, the re-aim applied, and the third citation reader finally gets a surface

The queue was taken from the ledger tail, not from this file's P-list. In order:

```
git commit (staged D233 append)      4b26e53  — STATUS +59 (§236) / DECISIONS +31 (D233),
                                               verified pure addition, 0 lone LF on the blobs
node scripts/falsify_console_a11y.mjs  13 arms · 13 held · rc 0   ← the 127 of this morning's entry
                                               did NOT reproduce; recorded as an environment
                                               transient, not a property of the shipped bytes
docs/PLAN.md:87                      DATABASE.md:171 -> :162, applied on this plane and verified
                                               at HEAD (162 = the §30 data guard, 171 = agent_runs'
                                               fallback list; the dirty disk copy holds it at :172)
```

Standing invariants re-run on the post-commit plane: contract drift 106 served / 0 CLIENT-ONLY; jsonb reads
0 undeclared; console i18n PASS; console a11y PASS (tightest 4.80:1); ledger citations --worktree 0 strict
offenders; line drift EXACT 130 / MOVED 0 / judged 147; numbers census PASS (770 claims after this unit's
appends). One red, and it is the census's own rule firing at its author:

```
node scripts/check_reader_reachability.mjs
  invoked by 12 of 13 (unreached: 1)
  - check_citation_supports_sentence.mjs is invoked by no surface ...
```

The unit that closed it: the reader was filed first (`e756d52`), then invoked from gate step 14 — D195's
step for exactly this class — as a reporting invocation with its exit-0-by-design limit spelled in the
gate's comment. Step 14's header names it; no new step label, so D219's derived total is untouched. The
five inserted lines sit below every line the ledgers cite (highest cited 441, insertion at 489+), and the
readers that read the gate's shape were re-run to prove nothing moved: step 8 --worktree 0 strict, drift
EXACT 130 / MOVED 0 — byte-identical to the readings D233 quoted. Reachability now 13 of 13. Landed as
`e512c11` (gate + STATUS §238 + DECISIONS D236).

The new refusal the unit surfaced, reported rather than fixed: `falsify_reader_reachability.mjs` exits 2 —
"the shipped ci is not LF here". `git ls-files --eol` settles it: ci.yml is `i/lf w/crlf`, and with
`core.autocrlf=true` and no `.gitattributes` pin for the path, CRLF on disk is what a normal checkout
produces. The LF precondition held at D195 only because that lane hand-wrote the file; a clean clone
refuses too. Remedy belongs to the surface's owner (pin the path like `*.sh`, or make the precondition
EOL-agnostic). Until then the fresh-gate run stops at step 14 on this plane for a reason no reader wrote.

Open next, named not implied: the LF-pin decision (D236's second ruling); the 42-of-100 census rows that
share nothing (a human's reading list, not a defect count); and the gate's steps 1-13, which need the
Docker plane to be measured at all.
Docker plane re-measured while this entry was being closed: `docker ps` shows `careeros-*`, `specproof-*`,
`nexus-postgres` and `nexus-redis` up — but the plan's own environment section names the test plane
`nexus-platform-postgres` on 127.0.0.1:5433, and no such container exists; `nexus-postgres` maps 5432 to
host 55433, which is not our port map. So the DB-backed steps (1-6, 11, 13) are blocked on this machine
until the plane is provisioned or the plan's environment section is corrected to name whatever now runs.
Same class as the 2026-09-29 entry: the instrument moved, and the text that describes it did not.
2026-10-06 深夜（账本 lane）— D235 落地 + 本机首次完整 fresh gate

falsify_reader_reachability.mjs 的 LF 前置按 D235 改为加载时归一化：三个面 CRLF->LF 后喂给 LF 拼写的锚，
运行打印被归一化的面名（本次点名 ci）——平面事实，不是对字节的裁决；臂计数改为 readdirSync(scripts/)
 派生（今日 13 个 check_*.mjs，D195 时代手打 10）。改后复跑：15 arms · 15 held · 0 missed，exit 0。
gate step 14 块（gate 原样五条管道调用 + set -euo pipefail）整块复跑 RC=0：i18n、a11y、两 falsifier、
reachability 全 PASS——D236 平面上到不了的步骤，本机现在可达且绿。

DB 平面按 infra/docker-compose.yml 自己记载的路径供给：compose 项目 nexus-platform，
nexus-platform-postgres@127.0.0.1:5433、nexus-platform-redis@6380，docker ps 双 healthy。
供给前先清理 4 个此前中断运行残留的 nexus_gate_* 库（nexus_lead_check 归属未证实，不动）。

本机首次完整 fresh gate（nexus_gate_53_1791285528，19:19 起）：步骤 1-7 首次执行、首次全绿——
template0 建 58 表 / 8 迁移；生成器 FK 自检 PASS；种子装载；quality.sql 217 checks PASS 且
newest-claim MATCHED；truncate probe 两半 PASS；check_jsonb_reads falsifier 38/38 held。
步骤 8 跑 falsify_ledger_text.mjs：56 arms · 54 held · 2 MISSED -> RESULT: FAIL，GATE_RC=1。

根因（HEAD 平面实锤）：该 falsifier 两条 gate 接线臂手打锚 step "8/12 与 step "13/13，而 gate 自 D219
起全部标题为 /18（HEAD blob 锚在其 L432/L454，gate blob 恰含各一个 step "8/18 与 step "13/18）。
此前 DB 步骤从未在本机跑过，step 8 从未到达，故缺陷潜伏至今。D196 类：手打总体常数，长在治理手打常数的仪器里。该文件现载 owner lane 的 D198 WIP（其 silent-child 守卫在同次运行中全 held），
不碰，只路由：修法为锚派生——step "8/ 与 step "13/ 与总数无关，且 "13/ 不会误中 "13a/（标签拼写含字母）。
step 8 自身的 check_ledger_citations census 位于 falsifier 调用之后，本次未运行；gate 的 RC 是 falsifier 的。

落账：STATUS §239 + DECISIONS D235；提交仅含 falsify_reader_reachability.mjs 与两账本。账本追加零孤立 LF。
收尾：§239 的标题首版写成 "## §238 —"（reader 的检索形状是 "## NNN. "），check_status_citations 按 HEAD
平面报出全树唯一 BAD（PLAN.md:1084 的 STATUS §238）。修正提交 09338c0 后 RC=0：PASS — every spelled
`STATUS §NN` citation resolves to a heading at HEAD。本 session 落地：5fc5b12（D235 主单元：falsifier
归一化 + 派生计数 + 首次完整 gate 证据 + STATUS §239 + DECISIONS D235）+ 09338c0（标题形状修正）。
check_ledger_citations --worktree RC=0；check_comment_citations PASS（92 citations / 31 files）。
D236 收尾单元：fork 修复 + 重瞄准 + 剩余步骤独立复跑（§240）

根因：e512c11 追加 §237/D234 时未做全账本查重——另一 lane 的同号章节早已在（HEAD 与磁盘同 fork，
非漂移而是双重落地）。check_ledger_sections 以 "two sections answer one citation" 拒绝整个 run。
修法：后落地的重复（本 lane 的）重编号——my §237→§238（the third citation reader）、my §238→§239
（D235 landed）、my D234→D236（standing-refusal 裁决）；连带引用同步：STATUS×1、DECISIONS×2、
falsify_reader_reachability 注释×1（D234's→D236's）、PLAN×6。
重瞄准：D235 编辑使 falsifier last-wins 注释块 +11 行，step 16 报 MOVED 1/147；目标文本先验证后改，
strict 复跑 RC=0 clean on 147 judged。
独立复跑（详见 §240）：step 9 PASS（92 citations/31 files）；step 13 三腿（HEAD worktree）47 个
committed-plane offender=已提交账本句子引用仅存在于工作区的文件（未提交文件 owner lane 落地后自解）
+ falsify_plane_reads 提交版注释引 falsify_ledger_text 第 858 行 vs HEAD 737 行（owner lane WIP 所致）；
step 11 需 --db（设计使然）；step 17 无期望 UNCHECKED（设计使然）。
教训入 §240：追加不查全账本编号 = fork；编号是内容的一部分。
== D237 unit, 2026-10-06: 42/100 sharing-nothing 清单落地 ==
- check_citation_supports_sentence.mjs 增 --list 开关：每行打印 clause、被引行、所在章节；--limit 不约束 --list；--list=x 拒绝 RC=2
- 默认面前后字节同一（Compare-Object 0 diff）：501 seen / 102 judged / 324 skipped / 44 sharing nothing
- 44 行首读（模式派生，不手数）：3 空行被引（D160 领地）、8 md、27 scripts/；直方图 mjs23/md8/sh6/py4/ts2/yml1
- 电池：sections PASS（disk-only §241）、ledger_citations --worktree RC=0（新章节 0 offender）、comment 92/31、drift strict PASS（EXACT 130/147，MOVED 0）、reachability PASS（13 readers）
- 落账：STATUS §241 + DECISIONS D237，提交 ed1da22（3 files, +67/−4；DECISIONS 的 −1 为 EOF 换行哨兵假象，已核旧末行完好、内容零丢失）
== D238 unit, 2026-10-06: 44 行 sharing-nothing 逐行判定，揪出 D227 修坏的 §200 引用 ==
- 44 行全部定谳（七类 30+4+3+4+1+1+1=44）：真主语 30（行在散文里说出句子所描述之物，标识符代理看不见）/ 自指 4（引账本机器自己的行：DECISIONS
5170×2、5230、9498，D94 的 header 示例故事在 5230 端闭环）/ 照片 3（引死跑的输出，磨损记录不修：STATUS 4887、5936、10839）/ 双平面
4（仅在另一 lane 未提交面为真：body_blocks 266、three-attempts 10672、PLAN 行 12237）/ worn 1（DECISIONS 10679：D217
十行合规重瞄时为真，其后 gate 13→18 步长，首腿现坐 424 而 cite 说 391，drift step-16 类，路由）/ landed false 1（本单元头条）/ 空行
1（D160 领地，STATUS 9016）
- 头号发现：§200 的 expectCrash 双向执法谓词范围引用（STATUS 10410）被 D227（2268dd7）按形状修坏——真值链 3b4b422:331-333 ✔ →
af9bf2c:456-458 ✔ → 2268dd7:581-583 ✘（任何平面从未为真）；HEAD 谓词在 456-458（D194 裁决 DECISIONS 11042 同 claim
引用仍真，本单元读真），磁盘在 466（904 行 D198 WIP）；581-583 各平面都是 --roots 拒绝臂（声明无死）。修复路由：D198 落地后重瞄回
456-458，先断言旧行单次出现（D217 纪律），因目标文件今日 HEAD-dirty，不许把数字钉在移动平面上
- D238 裁决三条：census 保持 exit-0（问题清单不是缺陷计数，双向弱点均按设计成立——30 真行证明武装代理会冤枉真引用，1 假行证明只有人读能抓到）；修正走追加或路由、不在读判单元内改写；修复单元必做同 claim 兄弟行交叉核对（DECISIONS 11042 仍真即为机检线索，升格为必做步骤）
- 本章节零 cite-shaped token（裸行号 + at 形态）：census 前后字节同一 501 seen / 102 judged / 44 sharing nothing
- 电池：ledger --worktree 0 strict offender（547 shaped；1 uncommitted target=已提交 §204 引 falsify_ledger_text.mjs:858 vs HEAD 737 行，owner lane D198 WIP，counted-not-judged）；sections PASS（disk-only 242/D238 各 1）；status_citations PASS 44/44；comment 92 tokens/31 files；reachability 15 臂 15 held
- drift 两面：gate step 16 原样 --strict MOVED,NOT-UNIQUE RC=0（MOVED 0 / NOT-UNIQUE 0 / judged
147）；加宽探针面 --strict MOVED,NOT-UNIQUE,GONE RC=1——GONE 16/147（EXACT 130
不变：check_jsonb_reads:311、check_ledger_citations:12/66、run_platform_dev.sh:20、verify_consumer_slice.py:77
等 docstring 被重写），预存于本 HEAD、gate strict 按设计不含 GONE（文本已亡，无号可 re-aim），且 drift 读者本身是另一 lane 脏 WIP（+84
行未提交）→ 路由为候选读判单元，不执法不阻塞
- 落账：STATUS §242（§242 起 12348，全文收束于 12401）+ DECISIONS D238（12072 起），提交仅含两账本，零孤立 LF，结尾以句点收束无尾随换行
== D238 落地被扫走 + D240 恢复单元, 2026-10-07 ==
- D238 单元收尾：44 行七类判定（30 真主语/4 自指/3 照片/4 双平面/1 worn/1 landed-false/1 空行）+ §200 引用被 D227 修坏的发现（:581-583 任何平面从未为真，真值 456-458）已全部写入 §242/D238 并暂存
- 本 lane 两次 git commit 静默 exit 1（同窗口另一 lane 正在提交；hook 单独跑 Git bash RC=0 passed）——按 D240 纪律：并发窗口内的静默失败=竞争直到证伪，不是 hook 裁决
- 36adb08（他 lane D233 提交）把暂存的两账本整体扫走：STATUS 单 hunk @12343 +55=§242、DECISIONS 单 hunk @12067 +27=D238，diff 无他们 D233 任何字节（其裁决早已在账本），提交信息只描述 D233 单元 → 归属丢失、字节无损；f213481（D239）随后落地（DECISIONS@12099、STATUS §243@12403 且仅标题行——他 lane WIP 半成品）
- 他 lane 提交信息自述在含我们字节的树上复跑 step 8/9/drift 全绿（130 EXACT clean）——等同替本单元跑了电池
- 电池复跑（干净树 f213481）：census 501/102/44 原样 RC=0；ledger --worktree RC=0（0 offender，547 shaped，1 uncommitted target=§204 引 falsify_ledger_text.mjs:858 vs HEAD 737 行，owner lane，counted-not-judged）；sections PASS 211/222；status_citations PASS 45/45
- 观察只报告（他 lane 领地）：①D233（DECISIONS :11976）与 D239（:12099）标题逐字相同；②f213481 信息称 STATUS "+5=空行+四内容行"，实际 hunk=1 标题行+3 空行——幻影计数恰是 D239 自己裁决的类；③他们 D239/§243 追加为 LF 行尾 → 两账本 w/mixed（STATUS 尾 3、DECISIONS 尾 14 孤立 LF），其字节不动
- 恢复：§244 landing note + D240 裁决（归属靠附注恢复、历史永不重写、静默失败=竞争）——编号链 §242(我)/§243(他)/§244(我)、D238(我)/D239(他)/D240(我) 无 fork；追加块纯 CRLF 零孤立 LF 句点结尾
- 教训：两 lane 共享暂存区，add 与 commit 之间不留窗口——被扫走后按 D240 文档化恢复即成本全部

### 2026-10-07 — the correction that matters: EBUSY was a missing `stdio`, not the sandbox

Everything this line of work concluded about "this machine cannot spawn children" was wrong, and the evidence
is four lines long:

```
execFileSync git, default stdio              FAIL    6ms  code=EBUSY status=null
execFileSync git, stdio ignore/pipe/ignore   OK   1081ms
spawnSync    git, default stdio              FAIL    3ms  code=EBUSY status=undefined
spawnSync    git, stdio ignore/pipe/ignore   OK    451ms
spawnSync    node -> node, stdio ignore/pipe/pipe   status=0  error=none  out="child ran"
```

A child that **inherits** this process's handles fails in ~3 ms; the same child with an explicit `stdio` runs.
And the proof that the harnesses were never unrunnable: `scripts/falsify_quality_seam.mjs`, one of the six
tools §224 listed, now reports

```
RESULT: PASS — 38 of 38 arms held; the seam reaches the site census and the gate step that runs it
```

**What survives from §224:** the class is real — a process that never started must not print the same line as
one that ran and found nothing — and the tools that died silently still needed the guard. **What does not
survive:** the cause. It was an option, not an environment, and every "the gate's steps 7-12 cannot run here"
conclusion was drawn from that wrong cause.

Two of my own errors are recorded rather than tidied away. The first: a working basename index was reverted
because `timeout 240` was shorter than the tool's 4m07s baseline — a slow tool and a hanging tool are
indistinguishable to `timeout`, and only a stopwatch tells them apart. The second: I renumbered the new
section to §240 from a scan and created a duplicate; the ledger already held §240, and the correction belongs
at §253.

**Next, in order:**
1. Add `stdio: ['ignore','pipe','pipe']` to the remaining spawn sites — the five harnesses §224 named and the
   gate's own step spawns — then re-run each and record which arms actually hold on this plane.
2. Re-run `check_citation_supports_sentence.mjs` to completion (it needs >4 minutes) and read the basename
   resolution numbers it was never allowed to print.
3. Re-check whether `falsify_console_a11y.mjs`'s unexplained exit 127 survives the `stdio` fix.


### 2026-10-11 02:00 - the session's three units, taken in order from the ledger tail

Baseline first: readers green (the third census 599 seen / 102 judged / 33 sharing nothing / 316 basenames
resolved / 0 ambiguous / 35 skipped not-at-HEAD; step 8 zero strict offenders over 645 shaped; step 9
92/31; step 10 with the one disk-only draft printed; step 15 12/12; step 16 strict clean on 157 judged,
EXACT 140; step 17 MATCHED). Six nexus_gate_* databases left by killed gate runs were dropped before any
of it.

1. D290 (2247478) - the full fresh gate ran all eighteen steps for the first time on this machine,
   GATE_EXIT=0: 217 quality checks on 58 tables and 9 migrations with the newest-claim MATCHED, step 8's
   falsifier 58 of 58 (the hand-written anchors that stopped the D235-era run are derived now), the
   comment plane 57/57 and 92/31, console i18n and a11y and reachability 15/15 each, the drift harness
   MATCHED with strict clean on 157 judged, the numbers reader MATCHED on all three newest claims,
   self-total 18. The committed-plane legs printed their designed contrast (knob leg 95 files / 0
   offenders against the in-worktree leg's 37). Landing miss recorded under the recovery doctrine: the
   disk STATUS append was skipped, the sections reader reddened within the minute, and the append was
   completed after with the draft bytes untouched.
2. D293 (45f3846) - the platform build compiles on the working tree (the payment service has arrived,
   untracked, in the commerce package), which spends D286's wait: a new door class drives the six
   never-named write routes, 7 tests, and the merchant package re-ran 48 of 48. Two findings: the
   offerings PATCH validates a carried name and then drops it (200, row unchanged - filed for the
   surface's owner with the one-line fix named, not fixed across the ownership line), and the console
   inbox test's contains("never") stale since the accept route's own landing rewrote the payload sentence
   - re-aimed to the clause that still defines the state. Concurrent window: the other lane landed D291
   (the export door) and D292 (its own EOL repair - the ledgers went CRLF and back to LF inside an hour);
   this unit yielded the taken numbers and landed as D293.
3. D294 (4dc3881) - D287's named repair spent: the test database's ledger now records the data-backfill
   migration (before: validator red naming V9 with the catalog identical across 1097 objects; after: both
   halves green at the same 1097; a workspace test green on the repaired database). The standing
   "recorded, not validated" item is closed.

Next, in order: the full platform suite measured whole - DONE in the same session, 251 tests, 0
failures, 0 errors, 0 skipped, in 1:33, landed as D295 (cbd287d), the first whole-suite green since the
build unblocked. Then D296 (0a80d54): the third reader's 33 sharing-nothing rows judged in D238's seven
classes (16 true subjects / 9 self-references / 2 photographs / 3 worn / 1 two-plane / 1 landed-false / 1
blank), routing one stale position to the drift discipline. Then D297 (349829f): that routed re-aim was
REFUSED by its own anti-laundering check - the D91-era "only place that puts a non-null deadline on a
grant" claim was falsified three days after it landed by D126's legal-write arm (the plants file's
grant-expiry update), and neither landing nor any reader since had noticed; the correction is the append,
both dated rows stand, and the pre-verification has now refused a would-be-green twice. The gate re-certified the whole wave end to end (D301, 0fe146a): second complete 18/18 pass, step 17
MATCHED x3 through the widened grammar, AI suite re-measured unchanged (80 offline; live 2/4 on nexus_test
matching the both-planes verdict's predicted failures).
The standing items re-measured on the wave's plane (D302, ad5c612): all four hold - slug route
absent, amenity gap now three planes named (seed writes, web projection reads none by its own
test's word, Java no dictionary), sort-filter both ends unchanged, open-now ruling stands, and the
four AI entrypoints re-resolve to the same map.
The web/packages plane re-measured whole (D303, dca5486): all four gates green (types
432-conformance chain, sdk 43, ui tsc, web tsc+eslint+vitest 136), with the finding that the web's
entire eleven-file test suite lives on the other stream's uncommitted side - a clean checkout
collects zero web tests, the AI suite's shape on a second surface.
The e2e harness executed for the first time in the repository's history (D304, 3a356920): 20
passed / 4 skipped / 0 failed in 1.0m against a live working-copy stack - platform 8090 (dev
profile, flyway off against the paper-lagged demo ledger), AI 8010 mock, web 3002 from a fresh
build; two harness drifts fixed in this lane's files (the contract spec's hardcoded web root, and
its healthz route moved to the documented one); three boot findings recorded (empty password fails
closed per D7, the flyway paper lag dies on table ownership at boot, the dev profile's declared
secret).
The stack was left up for the next unit.
A ledger recovery note: the committed S297 vanished from the disk STATUS between the landing's
untouched assertion and the next reader run, mechanism unidentified, and was appended back
byte-exact with the draft island untouched - recorded as a fact, like the console a11y 127, for
whoever can observe the process.
The e2e suite's first full census (D318, 5d45d0d): 70 placements, 42 reachable (webkit CDN
blocked), two runs a day apart at 17/18 failures in stable families; the isolation test's own bug
fixed (user payload carries no merchant_id - derived from /me now, server isolation proven by
hand: foreign 403 / own 200); the home 500 diagnosed to the line (4 sort-rejected rails +
unauthenticated favourites = all-fail throw where the data layer owns a degrade path; routed to
the web surface's owner); September-era request bodies, the 4.477 AA reading, and the webkit
download filed.
The e2e stack (8090/8010/3002) is still detached-alive.
The placeholder-citation class fired at committed ledger prose and is routed (D319, cbf86e0): the
applier unit's example citations spelled with real line numbers redden step 8 (4 offenders, FILE
NOT FOUND), the remedy is the owning lane's two-character NN re-spell, and D319's own readers row
states the four instead of quoting a stale zero.
Open next: the AI test tree's designed guards (other stream's surface), the name-drop fix (filed, owner's), the NN re-spell - LANDED by the applier lane (step 8 clean again), and the hundred-summation gap - DONE as D300.
The September request bodies are LANDED too (D326, 20e7cab): the import body's merchant id, the
chat's conversation_id, the campaign draft's merchant_id, and the §52 probe rewritten on current
truth (self-serve onboarding is the design; the grants refusal moved to a cross-workspace offering
write, 403); the import wait uses the payload's own vocabulary (succeeded); the silent service
deaths traced to the docker engine going down (redis reset + hikari failure in the same second),
the restart recipe recorded (SPRING_ spellings, dev profile, NEXUS_DB_PASSWORD), and the e2e stack
is detached-alive again on 8090/8010/3002.
The KB journey's SSE family is fixed too (D327, fc2d25d): the chat route answers the D13 stream and the harness now parses frames, taking the answer from the summary frame; the conversations read's tightened merchant_id scope pinned.
The STATUS.md writer watcher (38 samples over 13+ minutes, one hash) shows no ambient writer - the three disk-miss episodes all cluster at landing moments, so the measurement task narrows to watching across a landing.
The test-marker census (D328, 714ae24): the harness waits on 9 testids across 20 occurrences and
the rebuilt web surface carries zero - the timeouts that survived the September fixes decompose
along this line, and both remedies existed; the route-contract one is TAKEN (D329, c0fa1f5): all
20 locators rewritten to hooks the surface prints (data-card-type, aria-labelledby sections,
aria-pressed compare, dict-text degraded row), two journeys green (§105 outage badge witnessed),
and the last reds decomposed to their floors: 3 home-entry tests (the all-rails throw, web owner)
and 2 NL-quality tests - the honest empty state answers natural phrasing with 0 while keywords
return 8, a §12-kept/§141-unmet finding routed to the AI lane - and the diagnosis landed (D361, the search cannot match Chinese AT ALL: exact merchant names, category words, any CJK query returns zero - the config allowlist knows simple/english with no Chinese tokenization - while §111 makes Chinese the primary language; remedy shapes with trade-offs filed for the AI/DB lanes.
The post-fix whole number is in (D330, cf76eb6): 29 passed / 3 skipped / 10 failed, down from 18, and all ten map one-to-one onto filed findings with owners - 6 home-throw, 2 NL-quality, 2 AA - no new unattributed failure.
The gate re-certification after the next 18 commits HALTED with both blockers bounded (D331,
dac927a): 13 steps green, then 13c's worktree leg reddening on 7 cites the knob leg resolves (a
source-index leg asymmetry in my harness - next unit: build the worktree index the way the knob
leg does), and falsify_console_a11y crashing on rmSync-without-import at its line 171 in the other
lane's WIP edit (routed; steps 15-18 blocked while it stands); the partial run still certified the
hard gate, falsifier arms, readers, drift (116/108 clean), console promises, AI live 2/4 steady.
CORRECTION (D332, 9c8d699): the 13c seven-offender FAIL is the DESIGNED contrast recorded at every
certification since the committed-plane legs landed (knob drive resolves over the main tree where
untracked files live; worktree drive over clean HEAD where they are absent by construction) -
D331's leg-asymmetry work item is withdrawn before anyone spends a unit on it; the halt's cause
count is ONE, the rmSync crash, and the lesson is the series' own: a red the ledger has already
explained is not a new red.
A correction to the S297-era vanish framing: S315 showed the same reader-fail-then-present
sequence and the section was already on disk when recovery ran - a concurrent-writer race on the
shared disk file, not a permanent vanish; S297's episode remains the confirmed instance, this one
is the same-class observation that turns the question into a measurement task (who writes
STATUS.md, and when).
The other stream's AI test wave (22 commits, offline suite 80 to 341) verified independently
(D358, 19719ba): the live tests they skipped taken on the healthy fleet (2/4, same mechanisms),
the e2e whole number reproduced across a restart cycle (29/3/10 same families), and their filed
data-quality failure (review-aspect census 216/217) confirmed by a second gate on a second day.
That second gate's blocking failure DECOMPOSED (D359, a47b6fb): the review-aspect check was dead
on arrival - its keyword table spelled the Chinese keywords as unicode escapes inside ordinary
strings, which postgres does not decode, so the census saw only its seven ASCII words (16.7%)
while the real coverage is 68.3 percent (7509/11000, proven both spellings on the same 11000
reviews); the 15 keywords re-spelled as real UTF-8 and the fixed quality.sql runs 217/0/exit0 end
to end on the kept gate database - step 5 green again, the instrument unblocked and VERIFIED IN THE GATE'S OWN FLOW (the wave's S551/D558 landed my note after their resolver-pinning S365 took the number): a fresh from-scratch run filed 217/217 with the review-aspect row green; the halt at step 14's crash unchanged (routed), 15-18 hand-driven green the same hour, and 10 accumulated gate databases (including the other stream's nexus_gate_fix* debug DBs showing their parallel iteration on the same spelling) dropped. The allergens read the new AI code makes is declared and answered (D368, a1bcf85): the triple in the read_cat VALUES list, the reachable answer row with the generator's construction line as the site, the jsonb census green at 18 triples declared, and the seven moved generate.py answer sites re-aimed in the same unit. The ledgers' line
endings got their own census and reader (D360, 7dd07d5): both ledgers are CRLF bodies with this
lane's LF appends as whole uniform sections, ZERO sections mix spellings (the earlier mixed
phrasing corrected by its own measurement), the reader enforces no-mixing from gate step 10
(reachability 14/14), and it self-falsifies on a planted mixed section The other stream's double-landing fork (S540 twice, their D546 section landed twice) repaired by renumbering the later copy to S552 with the attribution note S553 (D560, landed) - their S544 claimed the duplicate stayed invisible because no reader counts duplicates, but the sections reader has counted and failed on duplicates since the D236 fork discipline; their S548 routed without touching The mixed bytes also defeat the drift reader's blame walk - three re-aim rows it could not derive on the working copy derived cleanly on a clean checkout of HEAD and applied (D366, the strict census clean with EXACT 158 of 158) The Makefile's three dev targets were rewritten to the measured boot recipe (D364, dc7544d): ports D9-pinned (3002/8010/8090), the datasource password, the flyway disable, the dev profile, the AI's database url, and the quiet flag dropped - each target verified by killing the services and booting through it, health-checked Open next: the AI test
tree's designed guards (other stream's surface), the name-drop fix (filed, owner's), and the
hundred-summation gap - DONE as D300 (ae54282): seven hundred-compound claims were mis-valued in
both
directions (the standing 216 read as sixteen, 147 as forty-seven, 444 as forty-four); the grammar gained
the measured compound shape, the parser became a refusing fold, all seven read their true values through
the shipped grammar, and two bugs in the new code itself (an alternation-precedence whitespace bind, a
template escape collapse) were caught by the line-by-line population diff before landing. The nouns item is DONE (D299, 14561af): the numbers
reader's grammar now sees the hyphenated modifier its ledgers write in (148-claim census, population
914 to 989, the gate's three nouns untouched, the arms verdict an honest two-value refusal, one false
parse corrected as a bonus). The sibling-claim sweep is DONE (D298, a5232d4): of D126's eleven
legal-write arms, exactly one ever collided with a standing writer-claim - the corrected grant-expiry one;
the other three census candidates stand in context, and the method (writer-claim census before a landing
that adds writers) is now recorded for the seed lane.


The wave's live verification completed on the demo plane too (D363, three-plane whole: 341 offline / 2-and-2 fixture / 4-for-4 demo DB); the Chinese-search diagnosis was that the intent layer is clean but the SQL text filter excluded every row (D365); the remedies were assessed (D366) and the root cause was found: a soft preference (`occasion=date`) was being rendered as a hard JSONB attribute filter, deleting every row before ranking ran (D381). Fixed in `plan_from_intent` — preferences no longer reach the WHERE clause; the sentence "帮我找一个适合情侣约会的地方" now answers 5 items instead of 0 on the live nexus DB (470 published merchants).

**Full AI suite: 651 passed, 4 skipped (offline).** Contract drift: 117 parsed / 109 served / no gap. Ledger checks: sections PASS, citations 0 offenders (worktree), STATUS citations PASS, EOLs PASS. The 18-step fresh gate re-run initiated (Docker engine re-started); steps 1-3 green (create gate DB, apply 9 migrations, generate synthetic data with FK integrity); running step 4 (seed load) now.

User preferences are now read into the personalization ranking signal (D382): added `SearchBackend.user_preferences` seam, implemented in `PostgresBackend` via `SQL.user_preferences_for`; the search pipeline reads declared prefs for the user, matches against merchant `attributes` JSONB using `{key}_{kind}` / `{kind}_{key}` convention, and writes the averaged weight into `personalization[sid]` which the ranking lane consumes directly (bypassing `min_signals` for explicit intent). Pinned by `tests/test_preferences_ranking.py` (6 passed).

Next: complete the fresh gate re-certification (steps 4-18); the web stream's home-page all-fail throw (D318), e2e test markers (D328), review-aspect threshold calibration (D359), name-drop fix (D329), readability floor (D328); standardize preference attribute naming in seed data (currently `key_kind` convention may not match seeded attributes).

---

The wave's live verification completed on the demo plane too (D363, three-plane whole: 341 offline / 2-and-2 fixture / 4-for-4 demo), with a D240 attribution note for the S359 sweep my D361 restructure staged - their own S359 independently walked the same reservation-block arithmetic, the two lanes converging on the same open questions from different sides. And the ledgers' line endings got their own census and reader (D360, 7dd07d5): both ledgers are CRLF bodies with this lane's LF appends as whole uniform sections, ZERO sections mix spellings, the reader enforces no-mixing from gate step 10 (reachability 14/14), and it self-falsifies on a planted mixed section.
### 2026-10-24 — D528-D532, one shape five times over: the corpus and the reader spelling one fact differently

Baseline unchanged: the ten readers are where D520 left them. Five units this session, each one the
same question asked of a different plane: *what does the corpus write, does the reader read it, and is
the answer finer than the caller's own?*

1. D528 (168c7f2) - `_absorb`'s preference merge silently dropped a later turn's answer whenever an
   earlier turn had already touched the key, so "I wanted Japanese, actually no" kept the LIKE. The
   turn's value now replaces the state's for that key outright, compared on (value, polarity).
2. D529 (c9c326e) - the intent path's cuisine non-match answered 1.0 (the maximum) for a DISLIKE,
   and the aggregator is a max: one typed refusal flattened all 442 non-Japanese merchants to 1.0.
   Both directions now answer the neutral 0.5.
3. D530 (402ac27) - the typed preference derived `open_late_time_pref`/`time_pref_open_late`, which
   no corpus writes: 0 of 470 merchants answered. An alias table maps the (kind, key) to the
   attribute the corpus actually writes (`opens_late`).
4. D531 (95023f8) - a preference DECLARED in the NLU's own spelling (`ambience/quiet`, boolean)
   had no stored branch at all: all 470 merchants read None, while the same fact typed into the
   query box worked. Branches added, each attribute witnessing the other.
5. D532 (5c51097) - the seed derived `solo_occasion`/`scenic_view` from tuples in which 0 of the
   terms is a leaf `CAT_TREE` writes, so D528's occasion matcher weighted a flag that was always
   False (0 of 60 merchants). The leaf sets moved into `seed_pools.py` beside the tree they name,
   the tops read off the tree instead of retyped; after: solo 27/60, scenic 2, date 34, group 25,
   family 28, business 30.

**Queue spent:** the D526 item on the seed's dead occasion/style/view vocabulary - the AI lane's
half (spicy) landed in D526; the seed lane's half (what solo and scenic MEAN) lands in D532, with
`OUTDOOR_LEAVES = ()` recording that the taxonomy carries no outdoor leaf rather than leaving the
fallback to look like a fact about the data.

**The shape of the residue:** five units, five spellings of one fact that two planes could not
agree on. The gates that caught them all read a writer against a reader with `ast` and hold the
two planes to each other. The next lane's question is the same one asked of the remaining
un-covered pure functions the AST scan named (`nlu/understand.py::_fill_*`,
`api/routes_rag.py::_extract_proposals`, `api/routes_discover.py::_compare_fact_ids`,
`api/sse.py::json_compact`).

### 2026-10-24 (later) — D533: a question is not a refusal, and a refusal governs only its own clause

1. D533 (6b2ecfa) - the product names 有無 / 有无 / 有冇 as QUESTIONS in `ASK_MERCHANT_CUES` and 冇 as
   a REFUSAL in `NEGATION_CUES`; the reader that runs on the sentence had to pick one and picked the
   refusal, so "有冇辣" demoted the spicy merchants the user asked about, in the preference lane and
   the constraint lane alike. The same unit closes the other half of the rule the module's docstring
   already claimed: a cue that merely sat later in the turn governed it ("想找個安靜的咖啡店，唔好辣"
   read quiet as -1). A cue under the 有 governs nothing; a cue governs a token it is attached to,
   with a clause boundary ending the clause. The old attachment test was
   `_LOCAL_FILLER.match(between)` - a `*` quantifier matches the empty string, so any gap of three
   characters or fewer read as filler and the boundary was never enforced at all. The particle
   vocabulary stays in the product and stays load-bearing (the vocabulary gate derives its reference
   from the package's own string constants, and dropping the particles reddened it).

**Queue spent:** nothing was queued; the normalizer's comma erasure is filed above as the residue
this unit measured and could not fix without touching the normalizer's contract.

### 2026-10-24 (later still) — D534 and D535: the refusals the product could not read, and the clause they live in

1. D534 (032aa0c) - 無 / 沒有 / 没有 were not in the refusal table, so "無素食" read as a
   LIKE of vegetarian and the ranking lane boosted it (the D522 shape again). Adding them
   was only safe after D533: 無 sits inside 無障礙 and 貴都無所謂, and 有無 / 有没有 is the
   product's own question form, so a naive entry would refuse the wheelchair users, the
   premium diner who says price is no object, and every "is there any X?" question. 没有
   is spelled out beside 沒有 because the canonical table has no 没 -> 沒 entry.
2. D535 (a3ba887) - D533 enforced the boundary the punctuation marks; the conjunction and
   the verb survived it. "cheap and no curry" read the cheap as refused (the refusal is
   the curry's), and "I do not want spicy food" read as a LIKE of the very thing refused
   (the verb "want" between cue and value broke the attachment). A conjunction now ends a
   clause; one verb may bridge a refusal to its object. The degree adverb 咁 joins the
   particle vocabulary, which the vocabulary gate holds the package to.

**Queue spent:** nothing queued; the two residues above (the constraint lane's ASCII-only
value list and its eight-character window) are measured and filed.

### 2026-10-24 (later still, the third) — D536: the constraint lane reads the clause, not eight characters

1. D536 (86b6929) - the lane that writes the §7.1 constraints read an eight-character window
   past the negation, measured from the end of the cue AFTER its trailing space was stripped -
   so a value had seven characters of room and the lane could not read the product's own
   vocabulary. Measured: "no cilantro" (the value is eight characters), "no coriander" (nine,
   and in `CONSTRAINT_CANON` and in no rule), "唔要咖喱" / "唔要咖哩" (in the canon and in no
   rule) and "don't want spicy" (the value sits ten past the cue) all wrote NOTHING, while the
   preference lane read every one of those refusals. A sixteen-character window was measured
   and rejected: it reads "no rush want spicy" as a refusal of the spicy, because both clauses'
   words sit inside it. The clause is the unit of governance (D535), so the value is now read
   the way the polarity lane reads a token - `polarity._attached` is promoted to
   `clause_attached` and both lanes read governance through the one reader. Every gap the
   clause rule accepts fits inside the old window, so nothing the old rule read is lost; what
   it gains is every surface form the canon names.

**Queue spent:** the two items above - the constraint lane's ASCII-only value list (咖喱 /
咖哩 / coriander are in the rules now) and its eight-character window (the clause rule
replaces it). The four residues above are what this unit measured and could not fix.

### 2026-10-24 (later still, the fourth) — D537: a cue with an object of its own does not reach back

1. D537 (2a5d9e3) - D533's after-case read a cue backwards whenever it touched the token
   before it, and an empty gap is the most attached gap there is: measured, "I want spicy
   no cilantro" answered spicy **-1**, "辣，唔要咖喱" answered 辣 -1, "quiet, no noisy
   please" answered quiet -1 - a dislike of the very thing asked for, which the ranking lane
   then ranked on. A cue governs a preceding token only when it governs nothing after it;
   the Cantonese sentence-final particles (辣唔好呀) join the filler vocabulary beside 咁 so
   the rule does not read a refusal with a particle hanging off it as a LIKE.

**Queue spent:** nothing queued; the after-case residue above is narrowed to the constraint
lane's backward direction and the after-case's non-final clauses, both of which now wait on
the clause boundary surviving normalisation.

### 2026-10-24 (later still, the fifth) — D538: one locator, one reach, both lanes - and the clause boundary survives

1. D538 (6b83c73) - since D536 the two lanes shared `clause_attached` and still disagreed,
   because the polarity lane kept two private rules: a REACH (a fixed character count, fewer for
   a CJK token than a Latin one, while the constraint lane read the whole clause) and a LOCATOR
   (`str.find`, so a cue inside a word was a cue here and not there). Measured at HEAD, three
   bilingual refusals wrote the filter and read the opposite in the ranking - "without 海鮮"
   wrote `diet_avoid:seafood` and answered 海鮮 +1, "without any 奶" wrote `diet_avoid:dairy`
   and answered +1, "avoid 二手煙" wrote `smoking_avoid:smoking` and answered +1: the seafood was
   excluded from the results and boosted in their order, in one turn, from six words. The
   positions now come from the ONE matcher and the reach is the clause. The same unit gave the
   clause a shape the normalizer can no longer erase: the comma used to arrive as a space, so
   "想食辣，咖喱唔好" answered -1 for the 咖喱; `normalize_query` now writes the ideographic space
   (CLAUSE_SEPARATOR) where the clause punctuation was, and a line break becomes one too. It is
   whitespace, so every `\s*` in the field rules still reads across it, and it is not ASCII
   whitespace, so the fold cannot flatten it back into one. Three readers read it: the clause
   boundary, the filler (a gap holding one is two clauses, not particles), and the clause-final
   tail - which is what lets "想食辣，唔好嘈，要安靜" refuse the 嘈 and ask for the 安靜. The one
   place the separator is not a boundary is directly under a cue ("唔好，辣" refuses the 辣):
   that is `forward_gap`, forward direction only. The ONE matcher learned the same lesson - a
   space inside a cue reads as any whitespace, so "make a, table" is still a booking.

**Queue spent:** the normalizer-erases-the-clause-boundary item (the separator is the boundary,
   and the census of every punctuation the normalizer rewrites holds it open), and the
   after-case's half of the constraint-lane item ("安靜的不好，要嘈" refuses the 安靜 now - the
   clause-final tail is the cue's clause, not the turn). The constraint lane's backward direction
   is what remains of that item. Three residues measured and filed: the backward direction
   itself, the pause rule reading across a want verb ("唔好，要辣" refuses the 辣 the next clause
   asks for, in both lanes), and `_has_constraint`'s eight-character window ("no cilantro"
   writes the constraint and answers the intent `unknown`).


### 2026-10-24 (later still, the sixth) — D539: the constraint lane reads a refusal written the Cantonese way round

1. D539 (832e7a0) - a Cantonese refusal puts the value first ("咖喱唔要" refuses the curry) and
   the polarity lane has read a cue AFTER its token since D533, but the lane that writes the §7.1
   constraints read forward only: measured at HEAD, 490 of 490 backward shapes over the rules'
   own surfaces and seven negations wrote nothing while the preference lane read a dislike for
   every one whose cue it carries - the search filtered nothing and the ranking demoted the
   curry, a refusal the product half-read in the language most of its users type. The backward
   arm is the mirror of three rules the polarity lane already reads, and it is NOT `forward_gap`
   run backwards: the gap keeps EVERY separator in it (there the comma really did end the value's
   clause - "辣，唔好" leaves the 辣 alone), the cue must be final in its own clause (a cue with
   an object of its own keeps that object, D537), and the existential question is exempt from
   both orders ("有冇咖喱" and the topic-fronted "咖喱有冇" - the 有 sits directly under the cue
   either way). `_clause_final` is promoted to `clause_final`, the way D536 gave both lanes
   `clause_attached`. 356 of the 490 read now; the 134 that do not are two correct silences (the
   cue is not a word, or the cue still has a verb after it). One pin moves: D538's "想食辣，咖喱唔好"
   wrote NOTHING, which held the 辣 out of the filter by refusing the curry nowhere; the sentence
   now writes exactly the curry's constraint.

**Queue spent:** the constraint lane's backward direction (the whole item - the arm, the cue
   clause-final, the existential exemption from both orders). Two residues sharpened by this
   unit's measurements: the pause rule reading across a want verb ("咖喱唔好，想食辣" now writes
   `cuisine_avoid:spicy` on top of the curry) and `_has_constraint`'s window (the backward shapes
   with no category of their own inherit it - "peanut hate" writes the constraint and answers
   `unknown`).


### 2026-10-24 (later still, the seventh) — D540: a verb after the comma opens the next clause

1. D540 (61de385) - D538 read the separator directly under a cue as the cue's own punctuation, so
   "唔好，辣" refuses the 辣 - right when the cue's OBJECT follows the comma, wrong when a VERB
   does: measured at HEAD, "唔好，要辣" answered 辣 -1 and wrote `cuisine_avoid:spicy`,
   "辣嘅唔好，要咖喱" answered the 咖喱 -1 and wrote `cuisine_avoid:curry`, and "咖喱唔好，想食辣"
   wrote `cuisine_avoid:spicy` on top of the curry - the thing the next clause asks for, refused,
   in both lanes (the D522 shape, from one character of punctuation). A bare noun after the comma
   is the pause; a verb opens the next clause's request. `forward_gap` keeps the separator in the
   gap when one was stripped and what follows opens with a verb, so `clause_attached` reads the
   boundary it has spelled since D535. The control is the other half: with no comma there is no
   separator to read and the verb is the clause's own bridge, so "唔好食辣" and "don't want spicy"
   refuse exactly as before.

**Queue spent:** the pause-rule item (the comma before a verb now ends the cue's clause; the one
   before a bare noun is still a pause). One residue filed: a surface inside another surface
   ("煙" inside "二手煙") can sit past the clause's reach and read +1 while the longer form is
   refused - the two lanes agree about it, so it is the reach, not a contradiction.

### 2026-10-24 (later still, the eighth) — D541: the intent kind answers its question with the ONE reader

1. D541 (f293d31) - the module asked two questions about a refusal - what the search plan
   filters for (`_fill_constraints`) and whether the turn is a discovery at all
   (`_has_constraint`) - and D536 moved the first to the clause rule while leaving the second on
   D536's own eight-character window, so the two answers about one sentence could disagree:
   measured at HEAD, "no cilantro", "no coriander" and "peanut hate" wrote their constraint
   and came back with the intent `unknown` - the refusal was read and the answer was "I do not
   know what you are looking for". The window was also a substring test, so a cue inside a word
   counted ("no" in "snow peanut", the D480 shape). `constraint_hits` is now the ONE reader
   both questions are answered by: the lane appends what it returns, and the intent kind asks it
   whether anything came back. The reader itself - the clause rule of D536/D539 and the ONE
   matcher of D480 - is unchanged; what changes is that the second question stops carrying its
   own copy.

**Queue spent:** the `_has_constraint` window item. Two residues filed, both measured through
   the real path (the text is canonicalised before it is read, so a raw-text probe lies): the
   four negations only the constraint table carries (不吃 / 別 / 避免 / 少) are absent from the
   polarity table, and the shared reader now measures the disagreement inside one sentence
   ("海鲜 避免" writes the constraint and the +1 preference, "海鲜 avoid" writes the constraint
   and -1); and a cue with a verb of its own after it ("花生 少吃", "peanut 別吃") is not
   clause-final, so the eat-less spelling reads nothing at all.
### 2026-10-24 (later still, the ninth) — D542: the doc gate's exemptions were claims nobody checked

1. D542 (d6c7654) - the unit was found written in the working tree when this session opened,
   uncommitted, and it was finished and verified here. D462's gate consults its exemption
   table before it looks for the name, so a declared name that becomes real stays invisible
   to the rule written to catch it: `embed.py` sat in `DECLARED_PROMISES` as the platform's
   importer while `apps/ai/nexus_ai/rag/embed.py` had been in the repository since D510/D515
   and `docs/RAG.md` names it as the lane's own Embed and Store stage. Three clauses now
   hold each declaration to what it claims: a declared name may not be a file the
   repository has, a declaration no judged document cites is deleted, and a borrowed name
   must resolve to a file the interpreter produces outside the repository root. `site.py`,
   which `docs/ENVIRONMENT_REPORT.md` names to explain the locale hazard, moves to a
   `DECLARED_EXTERNAL` table carrying the import name the sentence means.

**Queue spent:** nothing queued. One residue filed: the gates read names, not sentences -
   `docs/AI.md` describes the planner in the present tense under a declaration that says it
   is not built yet, and the row stays green because the name is still cited.
### 2026-10-24 (later still, the tenth) — D543: the eat-less refusal puts the verb after the cue

1. D543 (c5f9ba9) - D537's rule (a cue reaches back only when it governs nothing after it) is
   right for a NOUN and wrong for a VERB: the eat-less refusal puts the value first and the
   verb after the cue - "花生少吃", "peanut 別吃", "gluten 避免吃" - and the verb's object is
   the value. Measured at HEAD, every one of these wrote nothing and answered `unknown`. The
   tail after the cue may now be ONE bridge verb, with the clause's own particles hanging off
   it: the cue governs the verb and the verb's object is the token the backward arm found. A
   noun after the cue is still the cue's own object, a verb with an object of its own is the
   forward refusal of that object, and the boundary, the separator and the existential
   exemption keep their teeth. Both lanes read the one rule, so "辣唔好食" answers -1 and
   writes `cuisine_avoid:spicy` with one voice.

**Queue spent:** the eat-less item (filed by D541's residue). One residue re-measured, not
   moved: the D493 debt is readable at the new shape too - "海鲜 少吃" writes
   `diet_avoid:seafood` and the polarity lane still boosts the seafood, because 少 is not in
   `NEGATION_CUES`; the new door pins the four words at this shape.
### 2026-10-24 (later still, the eleventh) — D544: a degree adverb does not end the refusal's clause

1. D544 (bc1d0a3) - the gap rule reads anything up to three characters as the refusal's own,
   which is why "not so spicy" and "唔好咁辣" worked; the English degree words are longer
   than that: measured at HEAD, "not very spicy" (the gap "very", four characters)
   answered spicy +1 and wrote no constraint, and "not really like spicy" read the same -
   the D522 shape from one adverb. A degree word modifies the value; it opens no clause of
   its own. The gap between a cue and the thing it governs may now be a degree adverb, or a
   degree adverb in front of the ONE bridge verb. A word that is neither still separates
   them, so D536's "no rush want spicy" stays unread, and the seam door takes the new table
   up by itself because it derives its gap population from the tables `clause_attached`
   reads.

**Queue spent:** the degree-adverb item. One residue re-measured at the new shape: the
   reach ("煙" inside "二手煙" sits two characters further from the cue) now shows through
   the degree gap as well - "唔好 very 二手煙" writes `smoking_avoid:二手煙` and the 煙
   reads +1, with CONSTRAINT_CANON spelling the two apart, so the new door charges the
   polarity lane only where the constraint lane's own reading wrote the canon.
### 2026-10-24 (later still, the twelfth) — D545: the canon names every spelling the rules carry

1. D545 (4029d5a) - a surface CONSTRAINT_CANON did not name fell back to itself, so one refusal
   read as two values depending on the language the user typed: "唔好嘈" wrote noise_avoid:嘈
   while "no noise" wrote noise_avoid:noise, and "no 二手煙" wrote BOTH
   smoking_avoid:smoking (from the 煙 inside the word) and smoking_avoid:二手煙 - the dedup
   compared two different strings. The Simplified spelling was worse than uncanonicalised: 姜
   sat in no table at all, so "不要姜" wrote nothing. The canon now names every surface the
   rules carry, 姜 joins the diet rule beside 薑, and every value it names is ASCII - the
   corpus writes its tags in English, so a value in another script is one the avoid clause can
   never match.

**Queue spent:** the CONSTRAINT_CANON item (the noise / queue / ginger / 二手煙 spellings, filed
   from the residues) and with it the 姜 half of the canonical-map hole - the SURFACE is in the
   rule and the canon now; the 没 -> 沒 map entry stays filed. One residue re-measured: the reach
   ("煙" inside "二手煙") is now reachable by the agreement rows through the shared canon, so
   the seam door's and the D544 door's rows skip a nested surface - the contradiction the seam
   door exists for cannot involve one, because no preference rule names 煙 or 吵.
### 2026-10-24 (later still, the thirteenth) — D546: every refusal the lane reads reaches the filter

1. D546 (0c0ed2a) - `plan_from_intent` mapped three keys into `plan.avoid` out of the five the
   refusal lane writes, so a sentence the lane read arrived at the plan with its refusal
   already dropped: "唔食花生" wrote `diet_avoid:peanut` and the plan carried `avoid == []`,
   and so did "no gluten", "唔好嘈" and "唔想排隊". The key set is now derived from the
   lexicon's own `CONSTRAINT_RULES` rather than hand-copied out of it, the value goes through
   the one canon reader, and `plan.avoid` is deduped where it is assembled (measured: the same
   refusal under two spellings left `['peanut', 'peanut']`, cleaned up downstream and so
   invisible). The keys that did reach the filter were read by a clause that never looked at
   the column the corpus writes the fact in: an ingredient is recorded per offering, in
   `offerings.attributes->'allergens'`, and `avoid=["gluten"]` excluded 0 of 470 published
   merchants and 0 of 4,707 active offerings while 269 merchants and 1,380 offerings carry the
   tag. Both lanes now read that column beside the tags they already read, through the same
   bound term set. The gate derives its population from the corpus and was proved to fail four
   ways (the three-key tuple back -> 39 red, either allergen leg deleted -> 1 red, the canon
   call dropped -> 29 red).

**Queue spent:** the planner-drops-the-constraints item. Three residues filed: the offline
   lane never reads `avoid` at all (`_filter_static` filters on category, district and
   max_price and nothing else, so the fixture-backed backend answers a different question
   about the same filter than the live one - the D488 shape one lane over); `smoking`,
   `noise` and `queue` name no tag the corpus writes, though the corpus DOES record a noise
   fact in `attributes.weak_aspects` and `quiet_ambience`; and `onion` / `ginger` /
   `coriander` are named by the diet rule and absent from the corpus's allergen vocabulary.
### 2026-10-24 (later still, the fourteenth) — D547: the negation the product did not know, in either spelling

1. D547 (ec3c69a) - 没 / 沒 was in no table at all. Measured at D546, "没食辣", "沒食辣",
   "没吃辣", "沒吃辣", "我没吃辣" and "我沒吃辣" all wrote no constraint, read the cuisine +1 - a
   LIKE of the very thing the user refused - and answered the intent `unknown`, while every
   other spelling of the same refusal (唔食 / 不吃 / 不想吃 / 不要吃 / 讨厌 / 冇食 / 無食) wrote
   it in both lanes. One canon entry (没 -> 沒) and one cue (the bare 没) reach three readers:
   the canon unifies the two scripts for every table canonicalised at import, the cue is
   derived into the constraint table's own negations so ONE entry serves both lanes, and the
   locale markers gain the pair for free because they are derived from the canon - "没有素食"
   was answered in zh-HK for a Simplified user before this. D534's gate is re-pointed at the
   canonical form of its population: the hand-spelled 没有 row it carried was standing in for
   the canon entry that now exists. Proved to fail twice (canon entry deleted -> 11 red, bare
   cue deleted -> 21 red).

**Queue spent:** the 没 -> 沒 canon item (filed by D545). Two residues filed: the polarity lane
   reads a refusal of the WORD where the user asked for its opposite - "唔好嘈" / "没嘈" write
   `noise_avoid:noise` and read `ambience/quiet` -1, so the ranking lane demotes the quiet
   merchants for a user who asked for a quiet one, and the shape is the same in every spelling
   of the negation; and 不吃 is the remaining word of the D493 family the polarity table lacks.

### 2026-10-24 (later still, the fifteenth) — D548: the outdoor vocabulary names the word a user actually types

1. D548 (82b9e16) - the `style/outdoor` row answered 戶外 / 户外 / outdoor /
   露輪 / 露台 / "al fresco" / 焕烤 / 烤焕 and nothing else, so the
   seven sentences a Hong Kong user actually types for an open-air place - 露天咖啡店,
   露天座位, 露天, 露天座, 露天餐廳,
   露天座位的餐廳, 室外咖啡店 - wrote no preference
   at all while 戶外咖啡店 wrote `style/outdoor +1`. The corpus carries the
   fact the row points at (94 of 470 published merchants write `outdoor_seating: true`), so the
   hole cost a fifth of the corpus its ranking signal. The row also named neither half of the
   standard-written pair the INDOOR row already carries (室內 / 室内): 室外 was
   missing too. Two tokens in the row the reader already walks, 露天 and 室外; the
   gate measures the words in the row, the seven sentences reading the preference, the indoor
   neighbour keeping its own row, and - on the live plane - the preference scoring the
   merchants that carry the fact above the ones that do not. Proved to fail twice
   (露天 deleted -> 7 red, 室外 deleted -> 2 red).

**Queue spent:** the 露天 / 室外 vocabulary item (filed by D416's half-fixed
   pair, carried since). One residue filed: `outdoor_style` is written on 0 of this plane's
   merchants while `outdoor_seating` is written on 94, so the full-weight half of the ranking
   matcher is unmeasurable on this plane and lives only in the fixtures until the plane is
   re-seeded.

### 2026-10-24 (later still, the sixteenth) — D549: the fixture lane answers the same avoid question the live lane answers

1. D549 (00fe33f) - `_filter_static` read `category`, `district` and `max_price` and never
   `avoid`, so the fixture backend and the live backend answered different questions about the
   same hard filter. Measured at HEAD on the live plane: `avoid=["seafood"]` dropped 30 of the
   470 published merchants live and 0 in a fixture, gluten 269 and 0, peanut 22 and 0, dairy
   245 and 0 - every word the corpus carries, answered "no" by the fixture lane. The live
   clause is four legs and the lane decides only where the last two look: the merchant lane
   reads the merchant's OWN offerings, the offering lane its own name and allergens. The
   fixture lane now mirrors all four, expands the terms through the live lane's own reader
   (`sql._avoid_terms` -> `categories.avoid_terms`), and `merchant_candidates` hands the
   filter the backend's offerings so the EXISTS leg has something to read. The gate measures
   the predicate against the live SQL over 20 words on both lanes - zero disagreements - and
   proves to fail six times (the call dropped -> 5 red, tag leg -> 3, category leg -> 1,
   allergen leg -> 3, merchant-lane offering loop -> 3, offering-lane own words -> 2).

**Queue spent:** the `_filter_static` never reads `avoid` item (filed by D546). One residue
   filed, in the same function and the same family: the `category` leg compares the caller's
   bucket to `category_primary` with `=`, and the corpus writes taxonomy leaf NAMES there (66
   distinct values, none a coarse bucket) - measured, `filters={"category": "restaurant"}`
   keeps 184 merchants live and 0 in the fixture lane, because the live lane resolves the
   bucket into slugs through `categories.resolve` and the fixture lane does not. The 57 fixture
   rows in the suite all write the coarse bucket themselves, so the lane is self-consistent on
   fixtures and wrong on live-shaped rows.

### 2026-10-25 (the first) — D550: the gate stops forbidding the embedding pass, and a kind becomes a claim

1. D550 (716e3df) - the chunks row asserted the seed's precondition on every plane it graded, so the
   embedding pass D508 shipped was refused by the gate it was meant to satisfy: on a canary plane that
   ran `python -m nexus_ai.rag.embed` over a fresh seed, 215 of 217 rows passed and the two reds read
   "2118 chunk(s) already embedded or mislabelled" and "chunks.embedded_at is stamped from the clock
   (2026-10-25 02:39:38+08) and no answer says so". The deeper half is the second red: the D83 block
   answers "why can this column not vary?" with a kind, and the coverage row compared the kind to
   nothing, so that same printout carried a PASS for the exemption row while its own answer list read
   `chunks.embedded_at [never-written]` over 2118 rows stamped at one fresh instant. The chunks row is
   now the invariant the worker guarantees - a vector, the model that produced it and the stamp are one
   fact about one row, and any two of the three is a deception - and `spread_pos` beside `spread_claim`
   compiles every kind into a predicate over the measured position: `never-written` holds only while the
   column is NULL everywhere, `generation-clock` only inside the load's own bracket, and the new
   `run-stamped`, which replaces the false `never-written` for `chunks.embedded_at`, only while the
   column is still empty or its one instant sits at or after the bracket's end. The bracket is
   `[seed_started, seed_finished + 1)` tested half-open, because the old widening by 600 s at each end
   swallowed a run instant 24 s after a 17 s load, and a plane the loader never stamped prints NOT
   RECORDED instead of a bracket built out of NULLs. Verified: 217 quality checks and 217 assertions at
   red = 0 on both states the old row conflated - 2118 pending / 0 embedded on the seed-only plane and 0
   pending / 2118 embedded with one model name and one stamp on the canary that read 215 of 217 before
   this unit - and the live demo database files the same 29 red names under the parent body and the new
   one. Seven new arms PASS with the closing baseline identical to the opening; the two that test the
   bound rather than a value's colour each take the clock row as collateral, which is the right pair.
   The reverse control says what the unit added: HEAD's own body is entirely green under four of the
   eight plants. Registry 402 rows, checker PASS, 216 of 217 assertions with an openable witness.

**Queue spent:** the item D508 left when it wrote the worker - the seed gate asserts the un-embedded
   state as a precondition, so a corpus could be embedded or gated and never both. Three residues
   filed: nothing automated runs `make ai-embed` (zero references in `.github/workflows/ci.yml` or
   `scripts/`), so the demo database is still 0 of 2118 embedded and the vectors exist only on the
   canary plane built by hand; the live demo database's stamped window is a 2024 placeholder
   (1726972800 .. 1726972900, two years before its own seed base) that the loader should stamp or
   refuse rather than carry; and `## 540. D546` appears in docs/STATUS.md twice at HEAD, the same 63
   lines back to back, because no reader counts duplicate section numbers.

### 2026-10-25 (the second) — D551: the retrieval's hit gate stops accepting a function word as evidence

1. D551 7e6e805 - `POST /ai/v1/rag/retrieve` kept a candidate row only when `mentions(text, query)`
   held, and `mentions()` accepted any query token of two characters or more - including `the`,
   `for`, `what`. Measured on the live demo corpus with the reader the gate uses - a word, not
   a substring - where `the` sits in 791 of its 2118 chunks and `for` in 889 while `ferry`,
   `seating` and `outside` sit in none: six ordinary queries got 25 served rows,
   12 of them the data statement, and `outside seating near the ferry` got 8 rows that were all the
   data statement. The gate that D405 built as the one honest signal - containment, because the
   trigram similarity does not separate a real match from noise - was a formality for every English
   query. `EN_FUNCTION_WORDS` is now skipped by `mentions()`, in the gate and not in `query_tokens`
   (the tokenizer feeds the merchant lane's keyword list too, and a word dropped there is a word no
   lane can use again), and a query made only of them mentions nothing, the same refusal the
   one-character query already got. Verified on the same live corpus: served rows carried by no
   content token 0, boilerplate among served 12 of 25 before and 4 of 14 after, and the route's own
   payload for the ferry query 8 chunks before and 0 after - §7's "no answer without retrieval",
   which is the honest answer when the corpus holds no ferry. The three residuals the same four legs
   measured and this unit did not fix are filed: neither shipped builder reaches
   `chunks_embedding_hnsw` even with `enable_seqscan = off` (only a pure `ORDER BY embedding <=> $1
   LIMIT k` does - 1.118 ms against 16.987 ms for the same rows unindexed), the hybrid costs nothing
   measurable at this corpus size (medians 610.263 ms lexical against 532.78 ms shipped), and 1040 of
   2118 chunks - just under half the retrieval corpus - are the section that opens every merchant
   document, which nothing in `data/seed/quality.sql` bounds.

**Queue spent:** the item D550 left when it landed the gate that no longer forbade the pass - the
   embedding pass has now run over the demo corpus (2118 of 2118 chunks carry a vector, `hashing`,
   one stamp) and the vector lane was shown to participate rather than assumed: the same query
   against the embedded plane and the seed-only plane returns 48 rows with a non-zero `vec_score` and
   0, and the two served id sets are disjoint per query. One residue filed here too:
   `docs/DEPLOYMENT.md` §6, the checklist written for the next agent, still sends it to
   `nexus-platform-testpg`, which exited three weeks ago, and carries three numbers this machine no
   longer agrees with.

---

### 2026-10-28 - the four refusals, an interpreter that could not start, and a plane that is not what its own log says

**Two units landed** (§574 D579, §575 D580) and one baseline was taken. The golden sentence
"帮我找一个适合情侣约会的地方" runs end to end against the live rows on this machine: HTTP 200,
`degraded: false`, `strategy: 'hybrid_v1+postgres+vector'`, `relevance_floor_applied: true`,
`total_estimate: 60`. Read the last two against the code before trusting them -
`total_estimate` is `len(ranked)` while the candidate SQL's own default `limit` is 60, so every
query reports 60 with `next_cursor: null` (API_CONTRACT §2 promises a total estimate), and the
strategy string names a `+vector` lane on a plane where 0 of 2118 chunks carry an embedding.
Every demo price fact also carries a September `expires_at`, so the cards honestly say
`price_stale` - the price TTL is 6 hours by AGENT_CONTRACT §5, which means the demo plane is
always stale unless it was seeded within the last six hours, and no re-seed was run here.

**D579** closed the split-lane refusal PLAN had armed (the four negations) and paid for it with a
word-boundary rule, because the two one-character cues are the tail of 特別 / 最少 / 多少 and
"特別辣的餐廳" was filtering out the spice the user asked for. **D580** opened the local path back
up: the venv's own `_editable_impl_nexus_ai.pth` held this project's non-ASCII path, site.py reads
a `.pth` with the locale encoding, cp936 cannot decode those bytes, and so EVERY interpreter in
the venv died at startup - `make unit`, `make test`, `make dev-ai`, `make ai-embed` and a plain
`python -c "import nexus_ai"` alike. The hazard was already written in `docs/ENVIRONMENT_REPORT.md`
§8 as a reason to prefer `uv run --no-sync`; it is now a script, a Makefile line and eleven tests.

**Suite state on this machine:** 10876 passed, 2 failed, 76 skipped, 51 deselected (867.95 s), and
both reds are named in §574 - one was D580's own door, fixed the same session, one is the seed
`scenic_view` door filed above. The live-database integration subset is green (15 passed).

**A note on measurement, because two of this session's claims replaced earlier ones:** 拉麵 does
reach the `ramen`-tagged merchants now (the containment leg in `search/sql.py`), which the D406
entry said it could not; and the embedding pass the 2026-10-27 entry recorded as done is not
present on the plane the service reads. Both were re-measured against the live plane rather than
argued from the log, which is the only reason the discrepancy is visible at all.

---

### 2026-10-28 (later) - the ledger caught up with seven landings, and the next residues

**Landed.** D581 (§576) - the declared-weakness reader, this session's own unit: the preference
matcher reads `weak_aspects` as a set, and the live corpus's 15 noise-weak merchants score 0.200
against 0.800 for the rest. D582-D589 (§578-§585) were landed by the sibling lanes with their
doors green and their sections written here from their own commits and this session's sweep
(**4454 passed, 31 skipped** across the nine files; the live rows skip without
`NEXUS_TEST_DATABASE_URL`). The duplicated section 556 was repaired: the earlier cuisine unit is
now D591/§577, so the ledger's section numbers are unique again (`check_ledger_sections.mjs` was
red at HEAD with `556×2`, and `check_ledger_citations.mjs --worktree` now reads 0 offenders).

**The queue this leaves, in the order the measurements justify.**

- **The avoid constraint reads nothing the corpus writes for `noise` and `queue`** - **closed
  by D595**: `categories.aspect_terms` bridges the constraint value to the corpus's aspect name
  (`queue` -> `waiting_time`), the SQL clause and `_filter_static` both read it, and the live
  plane moves 470 -> 455 for `noise` and for `queue`, with the offering lane 4707 -> 4568.
  The `lively_ambience` residue is **closed by D598**: the refusal now reads both spellings
  (union 16, 470 -> 454, offering lane 4707 -> 4561), the attribute leg is bound per name, and
  `aspect_attributes` is the one map both lanes read. Residue: the bridge is a hand-list that
  grows by hand, and only the words measured so far are on it.
- **`smoking` has no fact in the corpus at all** - `generate.py` writes no smoking attribute or
  tag, so no reader can exclude on it and none should pretend to. The refusal surface exists
  (`smoking_avoid`); the fact does not. D595's gate now asserts that the refusal drops 0 and
  says why, so the word cannot be recorded as filtered while it is not. Owner: the seed lane,
  before the AI lane can serve it.
- **Every demo price is stale by construction** - all 4,707 priced clocks are 36 days old and the
  price TTL is six hours (AGENT_CONTRACT §5), so D589's honest warning now fires on the whole
  golden path. Either the plane is re-seeded on the demo cadence or the TTL for demo rows is a
  contract question; nothing in the AI lane can decide it alone.
- **The vector lane still retrieves nothing** - 0 of 2118 chunks carry an embedding on the plane
  the service reads. **The honesty half is closed by D593**: the strategy string now names the
  lane only when a ranked row carried a non-zero `vec_score`, so the same request answers
  `hybrid_v1+postgres` and a re-embedding brings `+vector` back without a code change. The
  product half remains: `make ai-embed` is what fills the 2118 chunks, and until it runs the
  golden path is lexical-only on a vectorless corpus. Owner: the AI lane (the pass) with the
  seed lane (whether a demo plane should be re-embedded after every reseed).
- **Two live-set reds D583 measured and did not inherit** - `test_a_refused_cuisine_is_not_served_at_the_top`
  now passes with `test_live_search_contract.py` (13 passed), and
  `test_the_outdoor_preference_scores_the_merchants_that_carry_it` was the real defect D594
  fixed: the generator writes `indoor_style: True` on every row, the matcher asked it before
  `outdoor_seating`, and all 470 merchants scored 0.5 for an outdoor preference. Both are
  closed; the residue D594 filed is the mirror question below.
- **The indoor preference is vacuous on a corpus whose every row is `indoor_style: True`** -
  D594 stopped the constant from answering the OUTDOOR question, but `style/indoor` still reads
  `indoor_style` first, so it rewards all 470 merchants equally and its two negative legs
  (`outdoor_style`, `outdoor_seating`) are never reached. The generator's comment ("most HK
  venues are indoor") is a real fact; whether the preference should read a constant as one is a
  product question, and the seed lane may prefer to write the fact only where it discriminates.
  Owner: the AI lane with the seed lane.

- **The category filter's fixture lane cannot see the taxonomy's leaf rule** - D596 made the two
  lanes agree on the bucket walk (`restaurant` 184/184, `cafe` 79/79, `bar` 39/39), but D524's
  leaf-exact rule - a caller who names a leaf gets that leaf, not its root - is answered only by
  the live lane, because the fixture lane has no taxonomy plane. Measured difference:
  `filters={"category": "specialty-coffee"}` answers 33 live rows and the whole cafe root through
  the predicate. A fixture-only taxonomy copy would be a second writer of the taxonomy; the
  honest fix is to hand the fixture lane the plane's leaf set from the DB, and that is a
  fixture-API decision. Owner: the AI lane.

- **`avg_price_hkd` is a fact attribute with three readers and no writer** - D590's follow-up
  arms found the guard that keeps a second price fact from being written is unreachable through
  the comparison grid precisely because the spelling it watches for is never stored. Measured on
  this plane: `facts` holds `price` on 1,560 offering and 520 merchant rows and no
  `avg_price_hkd` row at all, while `cards.py`'s per-card fact list, `DISPUTED_ATTRIBUTES` and
  `attach_price_staleness` each ask for it. Either a writer names it (the platform's fact-ingest
  lane, from `merchants.avg_price_hkd`) or the readers drop an alias no corpus produces - and a
  fixture that invents the attribute would be this lane writing its own evidence. Owner: the AI
  lane with the platform lane.

- **The refusal bridge is a hand-list and only three facts have been measured** - D595 and D598
  closed `noise`/`queue` and the noise fact's second spelling, but `ASPECT_AVOID` and
  `ASPECT_ATTRIBUTES` name the pairings a human read off the generator. `weak_aspects` on this
  plane carries more names than the two the lexin can refuse (`service`, `seating`, `taste`,
  `ambience`, `mtr_distance`); whether any of them is a thing a guest would refuse is a product
  question, and inventing a mapping would be this lane writing its own evidence. Owner: the AI
  lane with the seed lane.

- **`total_estimate` reported the candidate cap as the corpus's size - closed by D599** - the
  search path fetched `max(60, limit * 3)` candidates and answered `len(ranked)`, so the
  `restaurant` root (184 merchants) and the unfiltered catalogue (470) both answered 150. Each
  candidate SELECT now carries an opt-in `count(*) OVER () AS pool_total` (a window taken before
  its ORDER BY / LIMIT), the service sums the lanes it asked for, and the response reports
  `max(len(ranked), pool_total)`. Residue: a text query's total is the size of the MATCHING pool,
  not of the rows the relevance floor keeps, and the window costs a full evaluation of the WHERE
  set on every search (22.4 ms against 234.1 ms cold on the unfiltered query here, i.e. inside
  the noise at this corpus size but not free at production scale).

- **`accessibility` is a writable kind that nothing reads, and `access` is the word that works**
  - D588 widened both write lists to the kinds the ranking table has a clause for and refused to
  shrink them, so three accepted words still have no reader: `activity` and `brand` never had
  one, and `accessibility` is the trap - the published contract's own word for a step-free
  preference, while the ranker's clause and the seed's row (`generate.py:1173`) both spell it
  `access`. A caller who obeys the types package stores a row that answers nothing, which is the
  mirror image of the fault D527 caught. Either the reader grows one clause that resolves both
  spellings, or the stored rows are migrated and the contract retires the word - and a second
  `if kind == "accessibility"` branch scoring the same signal twice would put one value in two
  lanes (D545). Owner: the AI lane with the platform lane.

- **Retrieval precision now has a door, and it names three weak queries (D600)** - mean p@10
  0.733 over nine leaf-named queries, with 壽司 0.5, 按摩 0.3 and 髮型屋 0.4. The diagnosis is
  in the plans, not the ranker: dish words are answered through `category=restaurant` plus a soft
  cuisine preference, and service words through `category=beauty` (a root admitting six leaves).
  Next unit: let a word that NAMES a taxonomy leaf answer with that leaf (the filter already
  honours leaf spellings after D524), and measure it on this door.

- **D601 closed the leaf half of the retrieval door; the ranking half is still unmeasured** -
  every leaf-named word now answers with its leaf (mean p@10 0.667 -> 1.000), which means that
  door's metric is now a FILTER check. Queries whose answer is not one leaf - 安靜的咖啡店,
  適合情侶約會的地方, 可以帶寵物的餐廳, 戶外座位 - need their own family: a share-of-top-10
  carrying the preferred attribute, with its own baseline. Owner: the AI lane. This is the
  instrument the embedding pass should be judged by.
- **`test_lexicon.py::test_unknown_lowercased` is red at HEAD** - `canon_constraint("vegan")`
  answers `vegetarian` while the row asserts `vegan`; `HEAD:nexus_ai/nlu/lexicon.py` loaded on its
  own answers `vegetarian` too, so the red predates D601. It may be the right behaviour (vegan is
  a subset of vegetarian for cuisine matching) with a stale assertion, or a table that folded two
  values into one. Owner: the lane that shipped D584's follow-up.

- **A stated access preference does not lift the ranking, and parking is anti-correlated** -
  D602 measured lift (top-10 share / population share) on the live plane: quiet 1.39, outdoor
  0.88, mtr 0.67, parking **0.00** (true on 28% of restaurants, none in the top ten). The
  preference lane writes `personalization` at weight 0.06, so a preference can move a row by at
  most 0.06 while quality and distance spread wider. The fix is a ranking decision (a query-stated
  preference is stronger evidence than a stored one; or the weight is data to revisit), and the
  door now asserts the defect so a fix reddens it. Owner: the AI lane with the ranking owner.
- **`可以帶寵物的餐廳` answered pet groomers - closed by D603** - the possessive now marks the
  head (`可帶寵物的餐廳` -> restaurant, `寵物美容` -> beauty, `寵物餐廳` -> pet unchanged), and with
  the right population the pet-friendly preference lifts 0.22 -> 0.50 (2.24). The §351 pin in
  `test_lexicon.py` was rewritten to assert both sides.
- **`date_occasion` is true on every restaurant** - 184 of 184, so the occasion/date preference is
  inert on this corpus in the same way `indoor_style` is. Either the seed writes the fact where it
  discriminates or the preference is documented as a corpus constant and its door row keeps
  asserting the vacuity. Owner: the seed lane with the AI lane.

- **An `inferred` preference written with no confidence is still stored at the dead number (D587's
  residue)** - D587 gave the DECLARED lane a floor (`DECLARED_PREFERENCE_WEIGHT` = 0.7, read across
  the repo boundary by `test_a_preference_written_through_the_api_is_not_read_as_silence.py`) and
  left the inference lane at `NEUTRAL_PREFERENCE_WEIGHT`, because a guess the platform made without
  a stated confidence is not evidence the user offered. `PreferenceWeightDoorTest
  ::inferenceStillAnswersNeutralAndThatIsFiled` pins that behaviour as the open question it is. The
  demo corpus is not the caller that trips it - its single `inferred` row carries an explicit 0.6
  (census measured for this bullet: 7 rows across 1 owner, none at 0.500) - so the exposure is an API
  caller or a behaviour pipeline that omits the number, not the seed. Two
  real repairs, and they are different products: the behaviour pipeline computes a confidence from
  how many observations agree and passes it in, or the write plane refuses an `inferred` row whose
  weight is absent (400 rather than a silent 0.5 - which is the shape §33's editability presumes).
  Choosing is a personalization-quality call, so it is not this lane's to make alone. Owner: the AI
  lane with the platform lane.

- **A candidate whose `attributes` JSONB is empty is invisible to the whole stored-preference layer
  (D587's fixture question, filed not fixed)** - the preference loop in `search/service.py` is
  entered only `if attrs and mid not in merchant_attrs`, so `_enriched_attrs` - the fold that hands
  a candidate its OWN `avg_price_hkd` and `district` to the budget and location branches - never
  runs for a row with an empty JSONB, at any weight. Census: 0 of 470 published merchants and 0 of
  4,707 active offerings answer empty or NULL today, so the defect has no victims yet; it acquires
  them the first time a merchant is created through a path that does not fill `attributes`. The
  repair is to make the fold reachable for a candidate that has no JSONB rather than to keep the
  loop's guard, and the tripwire row
  `test_a_candidate_with_an_empty_jsonb_is_invisible_to_the_whole_preference_layer` goes red when it
  is fixed - fold that row into the parametrised table rather than restoring its premise. Owner: the
  AI lane.

- **`notification_channel` rows are written without a `weight` at all (found while asking who writes
  this column)** - `NotificationRepository.setPreference` names six columns in its INSERT and leaves
  `weight` to the DDL's `NOT NULL DEFAULT 0.500`, i.e. to the number D587 just proved the ranker
  reads as no evidence. Measured inert for ranking: 0 occurrences of that kind in `search/service.py`
  and 0 in `MeController`. Measured on the live plane just now: 7 rows across 1 owner, none of them
  `notification_channel` and none at 0.500 - so this write path has never been used here, and the
  defect is a promise waiting for its first caller rather than a broken edit today. The user-facing
  half is read off the source and NOT yet run against a row: `GET /api/v1/me/preferences` takes the
  `kind` filter as optional and selects `p.weight`, so it lists these rows at the weight nobody
  stated, while `PATCH /preferences/{id}` demands the same `PreferenceBody` whose kind `@Pattern`
  does not admit `notification_channel` - §33's "editable" promise therefore does not reach a row the
  notification panel wrote. Either the notification lane states a weight it means (it reads only
  `value.enabled`, so any number is a lie) or its rows are excluded from the preference list the
  user edits. Owner: the platform lane with the notification owner.

- **The memory tier a caller chooses has to be decided, not silently absorbed (D604's gap)** -
  `user_preferences.scope` (`session|long_term`, `V1__init.sql:69`) is validated by the shipped door
  (`MeController.java:57`), stored by the shipped INSERT (`IdentityRepository.java:322`) and listed
  back to the owner (`p.scope`, `:283`/`:301`), while `user_preferences_for` (`sql.py:651`) - the AI
  lane's only read of the table - never names `scope` or `conversation_id`, so a preference scoped
  to one conversation ranks every later answer forever. Census: 7 rows across 1 owner, all
  `long_term`, `count(conversation_id)` = 0, so there is no live victim yet. The two repairs are
  different products and one clause resolves both (D545): honour the tier in the ranking read, which
  means the writer owes the conversation key and §6's split between `conversations.state` and
  `user_preferences` has to be re-read, or refuse `scope="session"` at the door until there is
  something to honour it against. `test_a_preference_scoped_to_one_conversation_is_read_back_by_every_search.py`
  pins the gap in both directions and its shadow rows go red either way, so the decision cannot be
  made by accident. Owner: the AI lane with the platform lane; the spec question is §117's.

- **The stub cart writes the same stale-price sentence with no locale in sight (D605's second
  producer)** - `adapters/platform.py:246` puts `"stale_copy": "價格可能已更新"` into a cart item
  beside a `stale` boolean, and the module has no locale concept at all (measured: 0 occurrences of
  the word `locale` in `adapters/platform.py`; `add_cart_item` takes `cart_id, offering_id,
  quantity, options, token, tenant`). `test_stub_platform.py:100` asserts that exact literal under a
  `# §20 localisation` comment, so the stub's own door currently grades the wrong-language copy as
  correct. D605 fixed the card path and left this one named rather than folding a wider change into
  its evidence. Two repairs, different shapes: give the adapter the request locale, or stop shipping
  a sentence from it and let the client render the notice from `stale` - the item already carries the
  boolean, and §5's promise is about surfacing staleness, not about which module owns the wording.
  Owner: the AI lane with the platform adapter's owner.

- **A party a merchant cannot seat is not answerable by any clause D607 wrote, because the merchant
  lane has nothing to compare it against (D607's scope limit)** - `min/max_party_size` live on
  `offerings`, so the repair bounds which OFFERINGS answer a party; `merchants` carries no party
  columns (measured: `docs/DATABASE.md:72` puts the Booking columns on `offerings` only), and the
  sentence "a restaurant whose every offering caps at 2 cannot host 8 people" is an aggregation rule
  nobody has written down. It needs one first - `any` (one seatable offering is enough), `all` (the
  merchant must seat the whole party in one booking), or a sum over concurrent offerings are three
  different products, and the demo plane's 804 bounded offerings sit across enough merchants that
  the three answers differ. D607's door pins the merchant lane NOT applying one
  (`test_the_merchant_lane_is_not_asked_to_aggregate_the_bounds`), so whichever is chosen has to be
  written before that row is changed. Owner: the AI lane with whoever owns the §117 memory-and-
  intent vocabulary that would have to carry the rule.

- **A page whose ordering key is tied is not a population, and a filter measured on it measures the
  planner (D607's method, and a defect of its own)** - the offering lane's `ORDER BY` is
  `kw_score DESC, o.rating_agg DESC` (`sql.py:576`) with no final tie-break. Measured on `下午茶`
  at `LIMIT 200`: 200 rows over 27 distinct `(kw_score, rating_agg)` keys, and **148 of the 200
  share one key** - `(1.75, 0.0)` - which is also the key of the page's last row, so the cut falls
  inside that tie group and which rows win it is the planner's choice. Adding the party predicate
  replaced 21 of the page's 200 rows, 9 of them rows that fit the party perfectly, while the same
  query called twice with no change returned the identical 200 ids. Two consequences: the exactness
  claim had to move to whole per-merchant populations (`POPULATION` in D607's door), and
  `filters.exclude` - the already-seen list - plus every second page is unstable under a change to
  an unrelated predicate. Either the ordering owes a deterministic tie-break (`o.id` is the obvious
  one) or the paging contract has to say out loud that it does not exist. Owner: the AI lane.

- **How long an offering takes is read by nobody who books one (D607's census)** -
  `offerings.duration_minutes` is populated on 804 offerings, the same count as the rows stating a
  party bound, so the corpus's bookable rows do carry a duration. Java names the column 13 times,
  the web 0 times, and the AI lane's SQL never selects it (measured: 1 occurrence of the word in
  `nexus_ai`, which is D607's own comment). `_slot_window` (`service.py:895`) and `slots_for`
  (`sql.py:622`) bound a time window and a capacity, never an offering's length, so a
  recommendation can propose a two-hour offering into a one-hour slot and nothing between the card
  and the booking says so. The product question comes first: does the slot window come from the
  offering's own duration, or from what the caller asked for? Owner: the AI lane with the
  reservation owner.

- **A fixture merchant that names its coarse bucket cannot answer a leaf the live lane answers, and
  HEAD is red on it (found while proving D607's reds were not D607's)** -
  `test_sort_preference_reader.py::test_the_followup_sentence_reaches_the_served_order` and
  `::test_closer_orders_by_distance_only_when_distance_is_known` fail at `d0f3b91`, measured in a
  detached worktree of that commit so none of D607's files existed. The utterance 拉麵 yields
  `filters={'category': 'ramen'}`; the live lane answers **22** merchants (23 are tagged `ramen`,
  which exists as a child category) and `_filter_static` answers **0** of the fixture's rows, each of
  which carries `category_primary='restaurant'` and no `category_slugs`. D596's mirror compares the
  resolved bucket against the row's own display name or its slugs, so a LEAF bucket breaks the case
  its docstring promised to keep: "a fixture that stores the coarse bucket in `category_primary`
  itself keeps the old comparison". Owner: the D596 lane - the clause and the fixture are both
  theirs; this row records the measurement because D607 could otherwise be blamed for it.


- **The district every card prints is a fact the card lane never fetches - the plane keys its
  address facts to the location row, and the card's fetch binds merchant ids (found measuring
  D608's collateral) - closed by D609**: `facts` holds 684 `address` rows, all of them
  `subject_type='location'` with `subject_id = locations.id` (measured: 684 of 684 hit
  `locations.id`, 0 hit `merchants.id`) - the one attribute this plane files under a third kind
  of subject - and `facts_for` (`search/sql.py`) asks `subject_id = ANY(<the card's subject ids>
  ::uuid[])`, which the card lane fills with merchant/offering ids; over the plane's first 40
  merchants that bind returns 160 facts, 40 each of `cuisine`, `opening_hours`, `price`, `rating`,
  and 0 address facts. The location's uuid was on no list the load could ask for: the geo LATERAL
  selects `l.id` inside its subquery and projects five other columns, never the id, so the row was
  never fetched rather than filtered out. A live geo answer at Central (10 cards) therefore carried
  `price` 54, `opening_hours` 54, `cuisine` 54, `rating` 64 plus the synthesised
  `distance_m`/`open_state`/`relevance`/`mtr_proximity` 10 each and **no `address` fact at all**:
  0 of 10 cards raise `district_match` - `_fact_for` maps that label to `address`, so it can never
  resolve - while 10 of 10 print `· Central` in `subtitle`, ungrounded (§18 asks every bullet to
  name a fact, and here the sentence that would name one is the one that cannot). Of the two shapes
  filed here the first shipped, because the second cites the wrong district: 133 of the plane's 145
  published multi-location merchants keep their NEAREST location in a different district from their
  PRIMARY one (松屋: Ma On Shan / Tai Wai), and 77 of 520 merchants have locations in more than one
  district. `build_merchant_query` and `build_offering_query` both project `loc.id AS location_id`
  (`NULL::uuid` when a page asks no geo), the page's single fact fetch asks for the deduplicated
  union of candidate and location ids, and a row that names a location cites that location's fact
  and no other. After, live on both lanes: **6 of 6 cards raise the bullet, 6 of 6 carry the
  `address` fact on `cards[].facts`, the bundle holds 54 of them over 54 distinct locations, and
  all 18 lane×locale pages report 0 ungrounded bullets and 0 citations disagreeing with the printed
  word**; a page with no geo still asks for its own 60 ids and loads 0 address facts. This is
  D589's class - a rendered value with no fact behind it - one column over. `address_line1` arrives
  in the same row and is still read by nothing in the AI lane (census: 0; web 4, Java 15 - both on
  the platform-catalog path, not the card), which stays open below. Owner: the AI lane.

- **Two of the census's zero-reader tokens were the census being wrong, and the ones left are named
  here rather than "fixed" (D608's method, audited)** - `merchant_lively_ambience` is read: the
  static refusal's offering leg looks the row value up under a key it COMPOSES
  (`row.get("merchant_" + name)`, `search/service.py:342`), which a name-match census cannot see.
  `mean_rating` is read too - it is the inner aggregate alias re-exported one line up as
  `tenant_mean_rating` (`search/sql.py:388`, `:393`) and consumed at `service.py:801`. So the
  census's output is a queue, not a verdict, and every "0 readers" gets re-checked against
  composition and aliasing before it is filed. What survives: `address_line1` (the bullet above),
  and the whole `reviews_for` builder (`search/sql.py:649`) - no caller outside its own three tests,
  and it sits on the dead-name exemption list at `tests/test_no_dead_constants.py:63` with a comment
  describing it as "the review rows for a set of merchants" while the product already renders review
  rows, with their ids, from the platform lane (`apps/web/src/components/merchant-view.tsx:209`).
  Either the AI lane's review lane gets wired and its `review_id` becomes a citation the card can
  carry, or the builder and its exemption both go; which of those is a product question about who
  owns review evidence. Owner: the AI lane with the review-ingest owner.

- **The census that found D607's column, D608's column and the address keying - so the next one is
  looked for rather than tripped over** - `tmp/d608_census.py` reads every bare `m.`/`o.` column and
  every `AS alias` out of `search/sql.py`'s SELECT lists (47 tokens on this tree), counts each
  name's occurrences per AI-lane module, the web app and the Java platform, and then asks the plane
  how many rows actually carry a value. It is cheap, it is re-runnable after any SELECT-list change,
  and its numbers are the day's plane - they have to be re-measured, not remembered. Three units
  have now come out of the same question: D607 (`min/max_party_size`), D608
  (`mtr_station`/`mtr_walk_min`), and the `address` keying above.

- **Reaching the district's fact widened what the verifier will accept as grounded (the cost D609
  disclosed instead of absorbing)** - `build_ground_set` feeds every scalar of every bundle fact,
  so a merchant geo page's set goes from **1,078 numbers / 323 strings to 1,186 / 600** and an
  offering page's from 264 / 94 to 340 / 289 (`tmp/d609_final_live.py`). The 277 new strings are the
  district and address words the cards now print, which is the point. The 108 new numbers are the
  `lat`/`lng` pairs inside those same 684 `address` values, and `TOLERANCE[NUMBER_KIND]` is
  `(0.01, 0.5)` (`trust/verification.py`): a number a model invents within half a degree of a real
  latitude - about 55 km - now matches a fact and reads as grounded. That tolerance was written for
  prices and distances, not for coordinates, and D609 made 54 of them reachable per page. Either the
  table carries a per-kind tolerance with a km-scale bound for `lat`/`lng`, or the geo scalars stay
  out of the ground set while the district half of the same value stays in - **closed by D610**: the
  second shipped. `_feed` now receives the LEAF KEY of the scalar it is feeding (`_scalars` yields
  `(key, value)` instead of a bare value), `COORDINATE_LEAVES` names `lat`/`lng`/`lon`/`latitude`/
  `longitude` and is matched against the LAST dotted segment only - a substring rule would close
  `plate` and `translate`, and a flattened card key arrives as `facts.value.lat` - and a coordinate
  joins the ground set as a string, never as a number. Live after (`tmp/d610_live.py`): a merchant
  geo page's set is **1,324 numbers / 791 strings** where D609 left 1,444 / 791, and an offering
  page's **432 / 465** where it was 520 / 465 - the numbers fall by exactly the 120 and 88
  coordinate scalars and the strings do not move; the same bundle with its `address` facts removed
  now holds the SAME 1,324 numbers while carrying 244 fewer strings, so the district and the
  address line still feed the page and only the position stopped being a quantity. Both invented
  longitude readings (`114.05`, `114.5`) are ungrounded, and all six probes are ungrounded on the
  offering page. Owner: the trust lane with the AI lane.

- **A location's clock joins the bundle and no score, and nothing decides whether that is right** -
  `facts_from_rows` groups into `facts_by_subject` under each fact's OWN `subject_id`, and
  `Candidate.freshness` reads `facts_by_subject.get(subject_id)` for the candidate's own id
  (`search/service.py:807`), so the 54 location facts D609 now loads cannot lift or sink the
  merchant's freshness contribution. D609 pinned that with
  `test_a_location_fact_moves_no_ranking_number` because a citation unit must not re-rank the plane
  on the side; the open question is the product one - a merchant whose nearest location's address
  fact is 36 days old but whose own four facts are fresh still scores as fresh today. Owner: the AI
  lane with the ranking owner.

- **§5's surfaced warning still exists only for price, and D609 put a stale word on more cards** -
  all 684 `address` facts carry `observed_at = 2026-09-22 03:00 UTC` against
  `FRESHNESS_TTL["address"] = 30 days`, so every one is past its TTL; 684 of 684 say `stale = false`
  in the column, and `facts_from_rows` re-evaluates from the clock (D589's rule), so all 54 facts a
  live geo page loads arrive `stale = True` - and the district bullet still rises, because
  §18 asks a claim to trace to a fact id and this is the merchant's own statement of where it is
  (`source = 'merchant'` on 684 of 684). §5 asks a stale value to be surfaced ("價格可能已更新"), and
  the only lane that does that is the price one. Whether a district the user is about to walk to
  earns the same banner, a weaker marker, or nothing, is a product decision about which stale
  attributes are allowed to speak plainly; D609 names it rather than inventing a marker. Owner: the
  AI lane with the product owner.

- **The comparison grid files its own `address` fact under the merchant, and the card lane now
  refuses that key** - `apps/ai/nexus_ai/api/routes_discover.py:325-330` (D401) synthesises a
  merchant-keyed `address` fact when the grid finds none, from the merchant's primary location.
  D609's rule is that a row which names a location cites that location's fact and nothing else,
  because the nearest location and the primary one differ in district for 133 of the plane's 145
  published multi-location merchants. So the same product shows the same merchant in two cells and
  the two surfaces can vouch for different districts with different shapes of citation - one stored
  under a key the plane's own `facts` table never uses, one stored and read under the location's id.
  Reconciling them means either the grid reads the geo lane's location too, or the D401 synth stops
  claiming a key the corpus does not file; either is a decision about who owns the grid's geo row.
  Owner: the AI lane.

- **The fact load's id list now grows with the places on a page, measured only at `limit` 6** - a
  merchant geo page's candidate list is 54 rows naming 54 distinct locations, so its one `facts`
  fetch binds 108 ids where it bound 54; an offering page is 60 rows over 38 distinct locations, so
  60 to 98; a page with no geo still binds its own 60 (`tmp/d609_cost_probe.py`). The ids are
  deduplicated, so the ceiling is the page's distinct locations rather than a multiple of its rows,
  but the largest page actually shipped (`limit` 20 with `subject_types=('merchant',
  'offering')`) has not been measured for either id count or the `facts` query's own time, and the
  load has no cap. Owner: the AI lane.

- **The offering page answered the same dish twice, and D609's live rows read it rather than
  tripping on it** - `下午茶` near Central at `limit` 6 returns six cards of which two are
  `雲吞蝦麵（下午茶版） Prawn Wantan Noodles` with the same merchant, district and price
  (`tmp/d609_final_live.txt`), and 60 offering rows share their 38 locations unevenly for the same
  reason. Both cards cite a real fact for the district they print, so nothing here is ungrounded.
  The defect, if it is one, is that six slots hold two copies of one dish: nobody has measured
  whether they are distinct `offerings.id` rows of one merchant, one row reached through two
  locations, or the ranking's tie-break choosing the same product twice over. Filed because the
  measurement was in front of this unit and its cause was not. Owner: the AI lane with the offering
  ingest owner.


- **A bare number the extraction cannot type still fuzzes onto any quantity on the page within half
  a unit - the half of D610 that closing the coordinates did not reach** - after the reservoir
  closed, the live merchant page still reads a claim of `22.4` as grounded, and it cites the
  `rating` fact's `{"count": 22, "value": 3.56, "max_score": 5, …}` (`4751f27f-…`): every leaf of a
  fact value enters the ground set under the fact's own ATTRIBUTE, so a review count filed as
  `rating` sits in the same pool as the rating, and `TOLERANCE[NUMBER_KIND] = (0.01, 0.5)` puts an
  ABSOLUTE half-unit floor under any claim `_bare_kind` could not type as money or rating. A page
  carrying a count of 22, a 22-minute walk or a party of 22 therefore vouches for every number
  within 0.5 of it (`tmp/d610_live.py`, 2026-10-29). The floor is load-bearing where the kinds are
  typed - it is what lets `700m` ground onto a computed 683m - so the open question is whether an
  UNTYPED bare number should instead require an exact stored value, and what that costs shipped
  copy: on these two pages the mock summary's own claims are `6 個` (count) and `470m` (distance),
  both typed, so the floor is exercised today only by numbers a model invents. Owner: the trust
  lane. **Closed by D611 for the pool, narrowed to the floor.** The count 22 no longer shares a
  pool with the rating it was counted from: every stored number now carries the kind its OWN key
  names (`_number_kind`, `trust/verification.py:545`) and `find` refuses a witness of a kind the
  claim did not say (`trust/verification.py:171`). Live after (`tmp/d611_live.txt`, the same two
  pages): `評分 22` and `最平 HK$22` are ungrounded, and so are all four D610 probes read as bare
  numbers - `22.4`, `22.05`, `114.05`, `114.5` - because the `22` that used to catch them is filed
  as a COUNT now. What survives is the floor itself, narrowed to numbers no key types: the
  day-of-week indices below.

- **The seven day-of-week integers inside every `opening_hours` fact are the largest untyped class
  in the ground set** - 578 of the 1,085 numbers a live merchant page carries are
  `zones[].weekday` values 0..6 (`tmp/d611_probe2.txt`), filed as plain NUMBER because the leaf
  `weekday` names no kind, so the half-unit floor still lets an invented `4` or `6` ground on a
  Thursday. D611 pinned this rather than hiding it:
  `test_a_bare_number_still_grounds_on_a_stored_number_of_no_kind` asserts that `營業 4 小時`
  grounds, and the live `en` page's own summary claim `6` comes back grounded as a NUMBER. The
  repair is not a tolerance change: a weekday is neither a quantity nor a clock, so either the day
  joins `strings` and an answer that says `週四` grounds by text, or the ground set grows a DAY
  claim kind the extractor has to learn to emit - a new kind is a change to §4's vocabulary, not
  to this pool. Owner: the trust lane.

- **`max_score` sits in the RATING pool, so an invented `評分 5.0` has a witness that is the
  scale rather than an opinion** - the leaf names no kind, so the path decides and
  `rating.max_score` reads RATING. Measured as arm V3 of the blast (`tmp/d611_blast2.py`, 15 pages,
  both lanes x 5 queries x 3 locales): excluding the bounds changes nothing that ships - no claim
  on any of the fifteen pages reads a bound - so the fix is free, and it was still left out because
  it is a SECOND rule (a scale bound is not a value) bolted onto a unit that had already bought its
  cost with the page-length witness below. Note what the live page does today: `評分 4.0`, which
  D611 measured as vouched by a weekday index before, now comes back grounded on a real
  `rating.value` of 3.99/4.0 (`tmp/d611_live.txt`) - a right answer for a claim nobody asked for.
  Owner: the trust lane.

- **A count written with a bound loses its type before it reaches the pool** - `COUNT_RE` needs the
  unit word immediately after the digits, so the literal `+` in the shipped bullet
  `評分 4.4（40+ 條評價）` costs the 40 its count: the claim comes out a RATING of 40. It is kept
  anyway, by `find`'s exact-text tail fallback (`claim.norm in self.strings`), which returns
  `fact_id=None`. §18 asks a kept claim to trace to a fact, so this one is kept on the echo of a
  stored scalar rather than on the fact that stores it - the reason the bullet survives is a string
  match, not the typing D611 added. Either `COUNT_RE` accepts a bound between the digits and the
  unit, or the fallback stops being a pass. Owner: the trust lane (the extractor's typing, not the
  pool).

- **No stored key names a percent, so the PERCENT pool is empty by construction** - `_attr_kind`
  returns money, rating, distance, minutes, count or number and never PERCENT, so under the kind
  rule a `92%` claim can only be kept by an exact-text echo. Measured cost: zero percent claims
  over the 15 simulated pages of shipped copy (`tmp/d611_blast2.txt`), so nothing that ships pays
  this today - and the first card that prints a satisfaction percent will print an ungrounded one.
  `test_a_percent_has_no_stored_key_that_names_it` pins the shape so the day it costs something it
  is a decision, not a discovery. Owner: the trust lane.

- **A party size is a count of people and the ground set files it as a number** - D607's
  `min_party_size`/`max_party_size` read NUMBER under `_attr_kind` (the leaf names a `size`, not a
  `count`), so an answer that says `8 位` cannot be vouched by the capacity actually stored, even
  though the plane holds it for every offering row. Owner: the trust lane with the offering lane.

- **The page's own length is now a count witness with no fact behind it** - once every stored
  number is typed, nothing on a page counts six of anything, and the shipped sentence `找到 6 個`
  was vouched by one card's `travel_minutes` 6; `build_ground_set` therefore files
  `len(records)` under `result_count` (`trust/verification.py:207`). What that buys and what it
  costs, both measured: the alternative (no witness) strips 4 claims over the 15 simulated pages,
  all four of them exactly this sentence, and the witness itself is one number per page with
  `fact_id=None` - so a fabricated count that happens to equal the page length is kept and cites
  nothing, and a count of six is now vouched whether or not the retrieval *intended* six. Owner:
  the trust lane.

- **A card's own reason bullets quote the user's query, and nothing in the ground set is that
  query** - pre-existing, and D611 found it only because it re-ran the whole page through
  `verify_generated_text`: a live merchant page's three bullet lines each carry an ENTITY claim
  `「咖啡店」` and all three come back ungrounded (`verified=False, stripped=3`,
  `tmp/d611_live.txt`), because the entities pool is built from card names and slugs and never from
  the request text - although the bullets are copy ABOUT the request. It is invisible today because
  `api/pipeline.py:251` verifies the model's summary and the bullets are template copy that no gate
  reads; the entity path is untouched by D611, so this is not a regression but a fifth reader of
  the same gate. Either the request joins the ground set at that call site or the bullets stop
  quoting it. Owner: the trust lane with the ranking owner.

- **A claim is vouched for by the page, not by the card it is about** - `build_ground_set` is handed
  the whole bundle and the whole record list and `find` searches that one pool, so on a live
  merchant page the invented `評分 4.0` grounds on fact `c7b18a20`, whose rating is 3.99 - a
  different merchant from the one any sentence carrying that number is about (`tmp/d611_live.txt`,
  2026-10-29). D611 made the witness the right KIND, which is the cheaper half of the honesty
  question; the half left is that no claim is tied to the subject it names. Closing it means the
  verifier knowing which card a sentence is about - a per-claim subject `extract_claims` does not
  produce and `REASON_COPY` does not need today. Owner: the trust lane with the copy owner.

- **A dish refusal is carried out as a cuisine refusal, and the taxonomy already holds the finer
  leaf** - `lexicon._add_cuisine_refusal_surfaces()` folds every `CUISINE_TERMS` surface into
  `CONSTRAINT_CANON`, so `拉麵` and `壽司` both canonicalise to `japanese` and `avoid_terms` expands
  that to `['japanese', 'sushi', 'ramen', 'izakaya']`. On the plane (`tmp/d615_avoid.txt`, 470
  published merchants, 2026-10-29) that refusal removes **28 merchants on the tag leg and 25 on the
  offering-name leg**, while the taxonomy's own `ramen` leaf - a real slug, 22 merchants - would
  remove 12 and 12. So the sentence "I don't want ramen" is answered by hiding every Japanese
  restaurant, including the 32 that carry no ramen category at all. The widening is right for the
  words that NAME a cuisine (日本嘢 → `japanese`) and over-broad for the words that name a dish, and
  the table cannot tell the two apart because it stores one flat list per cuisine. Either the fold
  keeps a dish's own slug when the taxonomy has one - `ramen`, `sushi`, `izakaya` are siblings under
  the `restaurant` root, so `categories.resolve` already reaches them - or the product accepts that
  a dish refusal is a cuisine refusal. D612 pinned the behaviour with its numbers in
  `tests/test_lexicon.py::TestConstraintCanon::test_a_dish_surface_refuses_its_whole_cuisine`
  instead of choosing. Owner: the AI lane with the ask-lane owner.

- **Words a user actually says that carry no refusal at all** - `唔想食燒烤` produces
  `constraints=[]` (`tmp/d615_simp.txt`, `tmp/d612_hole2.txt`), so the plan filters nothing and the
  barbecue houses stay in the answer, while `烤肉` - the Korean list's spelling of the same food -
  refuses `korean`. The word is not absent from the vocabulary, it is in the wrong LANE: a hand wrote
  燒烤 / 烧烤 as a surface of `style/outdoor` (the D548 row that folds in 露天, the barbecue-AREA
  sense), so the sentence reads `preferences=[('style','outdoor',-1)]` - the user is talking about
  food and the ranking lane answers by pushing terraces down. `火鍋` / `火锅` are worse: nothing in
  either lane, although the taxonomy has a `hotpot` leaf. Also carrying no refusal in the same sweep:
  串燒, 自助餐, 甜品, 快餐, 小吃, 咖啡. This is not the hole D584's follow-up door watches for:
  `test_the_surfaces_that_refuse_nothing_are_the_single_characters` walks `CUISINE_TERMS` and says
  anything that refuses nothing and is not one character is a hole - a word that is not a surface of
  any cuisine is invisible to it by construction. Filing rather than filling, because the fix is a
  vocabulary decision (which word joins which list, in which lane, and with what value) rather than a
  reader bug - and one word with two senses (the food and the place) is that decision in its sharpest
  form. Owner: the AI lane with the ask-lane owner.

- **The Simplified↔Traditional bridge is in the reader, and the table does not carry it** -
  `CUISINE_TERMS` is itself canonicalised at import, so `CONSTRAINT_CANON` gained only Traditional
  keys: `canon_constraint("点心")` answers `点心` and `constraint_hits("唔想食点心")` answers `[]`, while
  the shipped sentence works (`唔想食点心` → `cuisine_avoid: dim_sum`) because
  `understand.extract_intent` runs `canonical(text)` on the QUERY before any vocabulary comparison -
  deliberately kept out of `normalize_query` by D420 so a Simplified user is not answered in the
  Traditional locale. No consumer is broken today (`canon_constraint` has exactly one shipped caller,
  and it feeds the row's own value), but a second caller that skips the fold gets a raw CJK word into
  `avoid`, where `avoid_terms` hands it back unchanged and the tag predicate `&&` matches no row.
  Pinned in `test_a_simplified_surface_is_folded_upstream_not_here` so the next caller reads the
  bridge's location before assuming it. Owner: the AI lane.

- **The refusal table lists 96 surfaces and means 81 things** - 21 entries across the five rows are
  repeats (`tmp/d612_dupes.py`: 15 in `cuisine_avoid`, 3 in `diet_avoid`, 2 in `feature_avoid`, 1 in
  `smoking_avoid`), every one of them a Traditional spelling, which is the signature of
  `_canonicalise_vocabulary()` rewriting both spellings of one word (純素 and 纯素) to the same string
  inside a row that already held it. Nothing downstream sees it: `constraint_hits` dedups on
  `(key, canon)`, so one sentence writes one refusal either way - measured identical for 純素, 點心,
  海鮮. The cost is that a row's LENGTH is not its vocabulary, so any reader that counts the table
  (the fold's own docstring says "the 96 new words") over-reads it by 15. D584's follow-up door
  enforces one ROW per kind and one LANE per value; nothing enforces one SURFACE per row, and the
  arms prove the gap: dropping `_refused_today` appends 102 further copies and moves none of the four
  doors that read this vocabulary. Owner: the AI lane.

- **The static lane's category fallback compares a slug bucket to a display-name column** -
  `_filter_static` matches a row that carries `category_slugs` against `resolve(bucket)` and otherwise
  falls through `elif r.get("category_primary") != bucket`. On the live plane that column is a NAME:
  the 23 merchants a `category=ramen` clause reaches carry `'Ramen & Noodles'`, `'Italian'`,
  `'Dim Sum'`, `'Vietnamese'`, `'Steakhouse'`, `'Malaysian & Singaporean'` in it
  (`tmp/d614_select_run.txt`), so the comparison can only ever match a row that invents a slug in a
  name column - which is exactly what D596 measured from the other side (`category=cafe` kept 79
  merchants live, 0 in this lane). It still fires live for one shape: a merchant with no
  `merchant_categories` rows gets `'{}'::text[]` from `CATEGORY_SLUGS_SUBQUERY`, so `row_slugs` is
  empty, so it is dropped by a comparison that could not have matched anyway. The direction is safe -
  an uncategorised merchant should not answer a category request - but the rule is enforced by
  accident, and no door names the shape. Owner: the AI lane.

- **A fixture must carry the two-level `category_slugs` mirror, or it is testing the fallback** -
  every shipped candidate row carries leaf AND parent slugs (both lanes' SELECT, D596/D597), and D613
  found two end-to-end rows whose fixtures did not, which made them fail on an EMPTY answer set while
  looking like a ranking bug (`tmp/d613_static_probe.txt`). Nothing checks the shape of a hand-built
  row, so the next fixture that filters by category repeats the mistake. The cheap fix is a door over
  the fixture backends: any row list a category-filtered plan is pointed at either carries
  `category_slugs` on every row or says why not. Owner: the AI lane.

- **A card that answers a category request never says which category matched it** -
  `filters.category=ramen` reaches 22 published merchants (23 rows in `tmp/d614_select_run.txt`, one of
  them `pending_review` and excluded by the shipped `m.status='published'` predicate), and **11 of them
  print a `category_primary` that is not ramen** - Italian, Dim Sum, Vietnamese, Hot Pot, Steakhouse,
  Malaysian & Singaporean. The filter is right: every one of those merchants carries the `ramen` leaf
  as one of its own categories (`by_self=23`, `by_parent=0`, so no ancestor slug smuggled anything in),
  and a multi-category restaurant is a real thing. What is missing is the reason: `search/cards.py`
  builds the chip as `cand.category or rec.get("category_primary")`, so the user reads "Italian" on a
  card that answered a ramen request and nothing tells them why it is there. Same run, a second data
  smell: `Ginger Studio` appears TWICE with different primaries, and `tmp/d614_dupes.txt` resolves it -
  two DISTINCT merchants (`dc5f1725` Italian, `bbecb58a` Malaysian & Singaporean) sharing one display
  name, and the plane carries **7 such names over 14 of its 470 published merchants** (Banyan Room,
  Cove Gate, Ginger Studio, Marble Kitchen, Saffron Table, Zenith Stop, 知嶺 - every one a pair), so
  one answer can carry two cards the user cannot tell apart.
  What a fix would need is already in the corpus: `categories.name_zh` is populated (ramen ->
  拉麵粉麵, hotpot -> 火鍋, izakaya -> 居酒屋), so a card CAN name the category it matched in the
  user's own script - but no candidate row carries that name today, because
  `CATEGORY_SLUGS_SUBQUERY` aggregates slugs only, so the reason either widens that column or costs a
  taxonomy lookup per request. Owner: the AI lane with the copy owner.

- **The demo catalogue's OFFERING rows answer no category at all.** `_filter_static`'s coarse
  fallback compares the bucket to `category_primary`, and an offering row does not carry that key:
  `api/demo_data.py:124` builds `"category": parent["category_primary"]`, so the two demo offerings
  spell their bucket under a column the predicate never reads. Measured (`tmp/d615_offering_leg.txt`):
  the demo offering lane keeps **0 of 2** for every bucket tried (`restaurant`, `cafe`, `retail`,
  `bakery`, `ramen`) — including `restaurant` for the milk-tea set whose own row says `restaurant` —
  while the live lane answers the same filters with **2384** (restaurant), **342** (bubble-tea) and
  **166** (retail) offerings (`tmp/d616_offering_live.txt`). A user on the degraded path asking for
  a milk-tea set (`想飲杯奶茶` → `category='bubble-tea'`) is told the catalogue has none, and it has
  one. Two layers, one repair: the fallback needs the offering's own spelling, and the demo rows
  need the same two-level `category_slugs` mirror the product SELECT builds — even with the key
  fixed, `bubble-tea` (手搖飲品, a leaf under the `cafe` root, 45 `merchant_categories` rows) is not
  the inherited value `restaurant`. The demo catalogue's third value is worse: `retail` is not a slug
  in the taxonomy at all — `resolve('retail')` is `['retail','shopping']` and the live offering lane
  answers that bucket with 166 rows reached through the `shopping` root (`tmp/d616_taxonomy.txt`).
  Filed with the honest non-claim: `想買行山鞋` → `footwear` answers 0 on BOTH lanes (no such leaf
  reaches any offering), so that one is not a divergence.
- **D596's parity door cannot see this gate, by construction.** Every row of
  `test_the_category_filter_answers_the_same_question_on_both_lanes.py` asks
  `S._filter_static(rows, "", {"category": bucket})` — text empty — so it compares the two lanes'
  *filter* semantics and never the order in which the same function applies text and filter. Widen
  it (or keep the D615 door beside it) so a text-carrying request is part of the parity claim.
- **The no-bucket case is left as it is, deliberately.** `想去美髮` reads no category, and the demo
  lane then answers it with the text gate alone (0 cards; the catalogue holds no salon — honest) while
  the live lane answers 60 merchants of 35 different primaries (measured, `tmp/d615_same_request.txt`).
  "Should the degraded path answer a request its catalogue cannot satisfy with the nearest thing it
  has, or with nothing?" is a question about the degraded contract (§105), not about this predicate;
  this unit changes only the case where the catalogue DOES hold the answer.
- **`text_matched` on the static lane claims more than it knows.** `service.py:280` sets
  `r.setdefault("text_matched", bool(low))` — every row that survives a request carrying any text is
  marked as text-matched, including a row with zero token hits. After D615 such a row can now reach
  the ranking floor (`ranking.py:262` reads the flag), so the flag is load-bearing in a way it was
  not before: the lane keeps the row and simultaneously tells the ranker the user's words appeared in
  it. Measured before/after on the eight demo requests; not repaired here because the live flag is a
  per-row SQL expression and the two would then disagree in the other direction.

- **Closed by D620 (§618): the lift door now asks the production path.** It called `S.search(...)`
  without `intent_preferences` - the keyword `api/pipeline.py:192-197` fills - so the preference lane
  scored neutral 0.5 on every row and the table was the default ordering's base-rate correlation.
  Through `run_search` the lifts are quiet 2.32, pet 4.04, outdoor 1.75, parking 2.89, MTR 3.01
  (`tmp/d620_lift_prod.txt`), and the door's ten new legs require the two calls to disagree
  (`tmp/d620_fired.txt`). The stale numbers this bullet used to carry (outdoor 1.31, MTR 1.00, pet
  1.80, parking 0.00) were measured with `embedding` toggled and the preference still absent.
- **`parking_access` lifts - it was the harness that did not.** D618 (§616) filed "parking lifts
  nothing, with or without the vector lane" from that same preferenceless call; D620 (§618) measured
  2.89 through `run_search` (base 0.28, top-10 0.80, 8 of 10 rows firing). Nothing in the ranking was
  changed. What stays open is the general question the wrong table hid: which stated preferences move
  a page by how much, measured on the lane the routes use.
- **The vector lane's effect on a STATED preference is still unmeasured.** §616's on/off column
  toggled `embedding` inside a call that never received the preference, so it compared two
  preferenceless orderings; with the preference in the ranking the comparison has to be redone (the
  same six sentences, `embedding=None` against the hashing lane, both through `run_search`-equivalent
  input). Until then, no door says whether the vector lane helps or hurts a preference.

- **`indoor_style` is true on all 470 published rows, so a typed indoor preference is a constant.**
  D621 (§619) measured it: `有室內座位嘅餐廳` scores **184 of 184** restaurants 1.0
  (`tmp/d621_indoor_live.py`), so the preference cannot change a page, and the stored branch's
  indoor half has the same shape (`service.py:1390-1395` asks `indoor_style` first). A discriminating
  fact has to be chosen - `outdoor_seating is False` is true on 359 rows - and the two readers have to
  agree on it before the corpus or the matcher changes.
- **The seed writes "outdoor" twice, and the two spellings disagree on 407 rows.** `outdoor_style`
  (63 true / 407 false) and `outdoor_seating` (111 true / 359 false) are both present on all 470 rows
  (`tmp/d621_overlap.py`): 14 both, 49 style only, 97 seat only, 310 neither. D621 made the reader
  read both, which fixes the symptom; whether the corpus should carry one fact or two is a seed
  question, and every future reader will pay for the answer being "two".
