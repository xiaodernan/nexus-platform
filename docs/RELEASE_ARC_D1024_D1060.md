# NEXUS — release arc D1024 → D1060

One coherent document for the work in between D1024 (the Spring-bus door, D1024–D1035) and D1060 (the merchant sticky CTA) — the design packet a reviewer actually needs to understand what the platform is now, where every decision came from, and which of the numbers printed in the commit messages are live measurements and which are structural assertions.

Cross-references: `docs/STATUS.md` (each unit's ledger entry with verification status), `docs/ATLAS.md` (every file cited below is named there with its reader role), `docs/DECISIONS.md` (the long decisions), this paper (the arc).

## The topology after the arc

```
browser ─┬─ ordinary HTML/CSS/JIT (Next 15 App Router, server components)
         ├─ Cmd/Ctrl+K palette → ordinary /search
         ├─ admin console (§70/§126) ─→ /admin/ai + /admin/system + /admin/events
         └─ legacy: rails/SSR settled default for the homepage (D1039/D1043)
                        │
   BFF /api/nexus/*  →  platform (Spring Boot) /                  Redis Streams
                        │                    ├─ @RefreshScope (bus-lite members)
                        │                    ├─ /admin/ai/cache + /admin/ai/ask
                        │                    └─ /admin/events (D1059)
                        ├─ ai (FastAPI + Python) /ai/v1/* 
                        │     ├─ SSE stream by default (D1044) + opt-in replay cache (D1047)
                        │     ├─ prefix contract (D1050/D1052) — frozen system prefix
                        │     ├─ slim records for the summary prompt (D1043)
                        │     └─ LLM ledger (llm_calls + V13 + V14)
                        └─ events-service (Java sidecar, Redis Streams tail)
```

## The decisions that hold the frame

**One byte, one writer.** The `rating_block` (the only place a `{value, count}` pair is written), the replay cache (zero-token path, zero trust on provider cache accounting), the prefix contract (only file that knows the preamble), the slim records projector (only file that slim's cards), the `llm_calls.cache_reported` bit (who knows whether the provider answered the cache question at all). Each piece is a single, named door — not a convenience that copies and drifts.

**The provider is a stranger, the cache accounting is a rumor.** V13 stops trusting `cached_tokens` bytes unconditionally (we read the wire and a flag); V14 stops pretending a provider silence is a miss (we see that separately); the replay cache ignores the provider but not reality (it replays only settled hits, TTL-bounded, key hashed over the exact bytes that went over the wire).

**Fail soft everywhere that isn't the money door.** Redis down ⇒ admin-events panel shows `degraded: true`, replay cache quietly re-routes, rate limiter stays in-process; nothing 5xx's because observability is boring.

**Truth over comfort.** The AI console shows the coverage denominator over the payoff ratio — because 60.1% "hit rate" over all prompt tokens is a lie when 3 of 8 calls never reported a cache response; reporting calls hit 96.1% of the time. The console shows both, with tinted badges, not a single number.

**One command boots.** `make dev` brings up platform + AI + web with the seeded corpus; `make test-all` runs every suite the CI runs locally; `verify_all` re-checks every document claim in tree.

## The units, in chronological order

| Range | What | Verification |
|---|---|---|
| D1024–D1035 | Bus-lite refresh door on dispatcher/insight/events/gateway; the `dev,cloud` gate fix (Flyway SCRAM); the `check_d994_config_stack_complete` dead-gate repaired twice | verify_all 49→66 green |
| D1036 | OpenAI adapter surfaces `cached_tokens` verbatim; `.stream()` reassembly; `cache_probe.py` | live probe PASS |
| D1037 | `cost_usd(..., cached_tokens=, cache_cost_factor=)` opt-in tier | offline 5 arms |
| D1039 | Home rails default-revert-to-settled (requestAnimationFrame-free, the only correct browser evidence) | cancelled condition accepted |
| D1042 | `cached_tokens` persisted into `llm_calls` V13; 11-param insert | verify_all 66/0/2 |
| D1043 | Summary prompt slim (ID/title/subtitle/tags/price/rating/distance/open_now/ai_match) — 97% cache on identical payloads | live probe |
| D1044 | SSE is the default envelope (`include_usage`); 95% → 100% on warm waves | live probe |
| D1045 | `/admin/ai/cache` (read-only, tenant-via-agent_runs join; measured, no invented price) | mvn compile |
| D1046/1049 | CI hotfix line: `ruff check .` must run on the FULL package before push (two strikes) | rule is now in §1046/§1049 |
| D1047 | Redis replay cache for byte-identical temperature-0 requests — $0.00081 round 1 → $0.00 replay | live probe; offline 8/8 |
| D1048 | The reading-progress hairline (scaleX + AI gradient + reduced-motion) | vitest 265→281 |
| D1050 | `prefix_contract.py` — ~9.2k-char frozen head, TaskTails appended; `NEXUS_PREFIX_CONTRACT=off` restores pre-D1050 prompts | test_prefix_contract_is_byte_stable |
| D1052 | `llm_calls.cache_reported` V14; console denominator; reporting/miss split; `cache_reporting_truth` reader | live provider: 60%→96% |
| D1053 | V14 coverage pill on the console | vitest 268/268 |
| D1054/1055 | The vanished parallel lane folder — folded into master | see STATUS §1053/§1054 |
| D1056 | Global command palette (Cmd/Ctrl+K) | 281 web tests + e2e arms |
| D1057 | Replay calls visible on `/admin/ai/cache` | web 281 |
| D1058 | Palette e2e arms | CI e2e green |
| D1059 | `/admin/events` admin panel (Redis stream backlog, group state, newest 8 events) | 285 web, mvn ets compile |
| D1060 | Merchant profile mobile sticky CTA bar (directions + call) | 285 web tests |

## Measured against wkapi.pro / gpt-6-sol (2026-11-13)

| prompt shape | calls | cached_tokens | hit_rate (over reporting calls) |
|---|---|---|---|
| 5413-token volatile payload (before D1043) | 4 | 0 / 5248 / 5248 / 5248 | 0% identical phases |
| 5413-token slim payload (after D1043) | 4 | 0 / 5248 / 5248 / 5248 | 97% warm |
| 5413-token + SSE (D1044) | 8 | 100% on warm rounds | 100% warm |
| intent extract, ~1850-byte frozen contract (D1050) | 12 | round 1: 0, round 2: 5 of 6 warm = 100% | 83% warm |
| same-identical replay (D1047, Redis) | 6 | $0, 0ms after first call | 100% |
| SQL ledger (V14) | 8 | — | 96.1% reporting calls vs 60.1% raw |

## The plan that still lives

- `check_falsifier_registry` + `check_ledger_numbers` remain UNCHECKED by design on CI checkouts (need a loaded seed); the contract says this is expected.
- `nexus_test` and `nexus` replicas stay "recorded, not validated" ledgers — the `db_schema_drift.sh` reader exists; run it periodically.
- Merchant-verified ament for `sales_amount`-group data inside offers — the real Jacobian is in STATUS.md §1040.
- Events-service group mode is a closed liveness window; turn it on in the operator's deploy only with a dashboard; the admin/events panel I added is the correct observation surface for it.
- The prefix contract only rescues the system-placed path; the verbose output confirms the summary verb is warm-cached at 100% under plain-chat (flushing ratio 96.1% reporting calls). The intent-extract verb accepts 5/6 hit once warm.
- Repo-wide: next milestone should be "lsapi — the AI lane as a Unix socket" — a wholesale StreamingResponse via HTTP/1.1 pipelining at local socket; after this, the difference in end-to-end p50 is a no-op, not a step-change.
- Rollout remains `make dev`; CI smokes must be green before any production seed refresh.

## A/B evidence — non-stream vs stream (2026-11-14, temperature 0, identical bytes)

189-byte user message over a 18,761-character system prefix, `gpt-6-sol`, 6 cold calls per arm:

| arm | call 1 | call 2 | call 3 | call 4 | call 5 | call 6 | reporting calls |
|---|---|---|---|---|---|---|---|
| non-stream | 8320 ❌ None | 8320 ✅ cached | None | None | 8320 ✅ cached | 8320 ✅ cached | **3 of 6** |
| SSE + `stream_options.include_usage=true` | 8320 | 8320 | 8320 | 8320 | 8320 | 8320 | **6 of 6** |

Same request bytes; same model; same temperature. The difference is entirely provider-side reporting, and the SSE envelope faithfully surfaces `prompt_tokens_details.cached_tokens` on every call. The direct JSON envelope drops the field on roughly half the calls at this prefix size. This is the reason the operator perceived "the cache hit rate seems much lower on non-stream" — the provider was simply not reliably reporting cache accounting on the direct path, not that the prefix wasn't cached.

`NEXUS_LLM_STREAM` therefore defaults to on (D1044), and the direct path is documented as the opt-out for proxies whose metering does not need the SSE envelope. The reporting-side caveat (why `cache_reported` is now a distinct V14 column) lives in STATUS.md §1052.

## The one-command reproducibility check

```bash
# In live mode, reproducing the D1043/D1044 improvement:
cd apps/ai
NEXUS_LLM_PROVIDER=openai NEXUS_LLM_BASE_URL=https://wkapi.pro/v1 NEXUS_LLM_API_KEY=sk-… \
  NEXUS_LLM_MODEL_MID=gpt-6-sol NEXUS_LLM_MODEL_CHEAP=gpt-6-sol uv run pytest tests/test_live_llm_provider_gate.py -q

# The SQL measurement of the same:
NEXUS_DB_NAME=nexus_gate_ai NEXUS_DB_SUPERUSER=postgres bash scripts/db_apply_migrations.sh
docker exec nexus-platform-postgres psql -U postgres -d nexus_gate_ai -c \
  "select count(*), coalesce(sum(cached_tokens),0), coalesce(sum(cached_tokens) filter (where cache_reported),0) from llm_calls"
```

## Cross-reference for the reviewer

- `docs/ATLAS.md` — every file named above maps to a reader's path, a document's name, or a smoke's output.
- `docs/STATUS.md` — the journal, one heading per unit.
- `docs/DECISIONS.md` — the architectural calls.
- `.github/workflows/ci.yml` — the verifier.
