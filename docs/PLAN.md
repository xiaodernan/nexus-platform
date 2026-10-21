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

### Open, waiting on the AI lane (next)

- **The `food/cuisine_like` structured preference is read by the matcher but not produced by the NLU** — the seed stores `{"values": ["cantonese","sushi"]}` under `food/cuisine_like`, and the category inference reads it, but a typed "我想食粵菜" produces a `cuisine` preference (a string value) rather than a `cuisine_like` one (an object with `values`). The two shapes now MEET at the matcher (D394 routes both through `cuisine_matches`), but they do not meet at the WRITER: a typed cuisine is not stored anywhere, so the user's own words about a cuisine are not recorded as a preference.
- **The `ambience` preference's two spellings** — the seed stores `style/ambience` with `{"value": "quiet"}` while the lexicon's preference key is `ambience` with value `quiet`. The matcher reads the stored shape, so it fires; but a typed "安靜" produces `ambience=quiet` (a string), and the two shapes are read by different code paths. Worth one vocabulary decision rather than two readers.
- **The seeded merchants carry no `vegetarian` attribute** — `vegetarian` is a lexicon cuisine and a seeded taxonomy leaf, so a typed "食素" resolves the category but the preference signal has no attribute to fire on (it is a cuisine, matched by leaf, so this is already covered by D394's `CUISINE_LEAVES`).
- **The `personalization` weight is one number for two different things** — after D397 the preference and the feedback signals combine by maximum, so the number no longer says WHICH evidence produced it. A separate `preference` weight would need a `ranking_weights.yaml` change (the weights must sum to 1.0) and a strategy version bump; the current shape is defensible and the change is a product decision, not a bug fix.
- **The `weak_aspects` attribute is a LIST, not a boolean** — the matcher reads booleans, so a merchant that is weak at something cannot be demoted by a preference naming that weakness. The vocabulary has no "prefer a merchant who is strong at X" rule, so the gap is a missing RULE rather than a broken matcher.
- **A Chinese query's candidate pool is not subject-bounded** — the merchant lane's text match is blind to CJK (`tsvector` cannot segment it and the `%` operator needs three-character trigrams), and the corpus's tags are English, so 拉麵 matches **zero** `ramen` tags and the answer is a relevance order over every restaurant. Measured on the live plane while landing D406; the merchant lane's trigram work (D366) does not reach the candidate FILTER, only the score.
- **The compare grid's row LABELS are raw attribute keys** — the rows are fact-backed (`price`, `rating`, `category`, `district`, `open_state`, `distance`) but the labels are the keys themselves; the surface that prints them is the web lane's (`packages/ui/src/trust/CompareTable.tsx`), reported and not edited here.
- **The corpus's tags are English** — 拉麵 matches zero `ramen` tags, so a Chinese query reaches only the merchants that spell the word in Chinese (D407's lane). A translation layer for the tags is the open half of that unit.
- **The open state's `opens_at`/`closes_at` are TIME strings, the contract declares them datetimes** — `compute_open` produces "18:00" ✓ and `OpenState` declares `Optional[datetime]` ✓, so the card cannot pass them through ✓ (a validation error ✗) and the `closes_hhmm` the computation produces is dropped by the contract's model ✗. Which of the two shapes is right is a contract question — "closes at 18:00" is a time of day ✓, not an instant ✓, and `as_of` already carries the instant ✓ — so it is not decided in the AI lane's files.
- **Three ledger sections are invisible to the readers** — the sibling lane's D425/D426/D427 landed as `## 419 · D425 · …` (the number before a MIDDLE DOT), while the readers' pattern is `^## (\d+)\. ` (a number, a DOT, a space) ✓. So `check_ledger_sections.mjs` does not count them ✓, its duplicate-number check does not cover them ✓, and a future section could take 419/420/421 without the reader noticing ✗. Reported, not edited: those are the sibling lane's sections ✓. The format that works is `## 419. D425 · …` ✓ (as this lane's sections are written ✓).
- **The live demo corpus was never wrong** — D403's claim that "54 merchants' descriptions carry 餐庁" was itself a code-point mistake: the corpus has always carried 餐廳 (U+9910 U+5EF3), and the 54 are the CORRECT word. D414 withdrew the claim with the measurement (the corpus has 54 of U+9910 U+5EF3 and 0 of U+9910 U+5EF6). No re-seed is needed; the item is closed.
- **The live demo plane's corpus predates the seed generator** — D419 measured it: 0 of the plane's 500 published rows carry `date_occasion` (the generator learned to write it in D383), so the occasion preferences are understood and then do nothing there, and the personalization signal reads 0.5 (neutral) instead of 1.0. The re-seed is the seed lane's call — on a shared plane the load truncates the AI lane's own 968 `agent_runs` rows and the platform's demo rows, and the `nexus_ai` role cannot even read those tables to tell whether they hold anything. The recipe (measured on a throwaway database in D419): `python data/seed/generate.py --counts <n>` then the `data/seed/out/*.sql` files applied in order with `--single-transaction`. **D422 showed why it matters**: the lane's live suite was green on the stale plane and failed four times on a plane seeded from the current generator.
- **The seed's Chinese text could be checked against the canonical table** — D418 measured that 0 of the 470 published rows hold a character the canonical table changes, so the corpus is entirely in the standard forms ✓. The seed's GENERATOR is the other half: it writes the vocabulary the product's matchers read ✓ (D419's table), so both sides are checked — but nothing checks that automatically, and a generator change that dropped an attribute would take the preference with it.

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
- **The numbering: the D-numbers 428-454 and 458-463, the sections 422-448 and 452-457, are this lane's** — the sibling lane worked in parallel and took **D455-D457 / §449-§451** (their commits landed on top of D454 ✓), so this lane's next unit is **D464 / §458** ✓. If the next unit collides, renumber it (as D409 did, and D414 recorded) — the readers cannot see the sibling's sections, so only the two lanes can keep the numbering straight.
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
to end on the kept gate database - step 5 green again, the instrument unblocked The ledgers' line
endings got their own census and reader (D360, 7dd07d5): both ledgers are CRLF bodies with this
lane's LF appends as whole uniform sections, ZERO sections mix spellings (the earlier mixed
phrasing corrected by its own measurement), the reader enforces no-mixing from gate step 10
(reachability 14/14), and it self-falsifies on a planted mixed section The mixed bytes also defeat the drift reader's blame walk - three re-aim rows it could not derive on the working copy derived cleanly on a clean checkout of HEAD and applied (D366, the strict census clean with EXACT 158 of 158) The Makefile's three dev targets were rewritten to the measured boot recipe (D364, dc7544d): ports D9-pinned (3002/8010/8090), the datasource password, the flyway disable, the dev profile, the AI's database url, and the quiet flag dropped - each target verified by killing the services and booting through it, health-checked Open next: the AI test
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