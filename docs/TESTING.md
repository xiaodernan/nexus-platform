# NEXUS — Testing & Quality (§71–§76, §156, [`DECISIONS.md`](DECISIONS.md) D7, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11)

Status: **to be built.** Owner: unit/integration next to each module; browser suites in `tests/e2e` (Playwright) with
screenshots in `tests/evidence/`; AI evals in `apps/ai/app/eval`. CI pipeline (§132): lint → type check → unit →
integration → build → E2E → security scan. Honesty is testable here, not just aspirational (§155, §156).

## 1. Test pyramid (§73)
| Layer | Tool | Scope | Gate |
|---|---|---|---|
| Unit | JUnit (platform) · pytest (ai) · vitest (web) | pure functions: `Intent` merge ([AI.md](AI.md) §3), ranking score ([RECOMMENDATION.md](RECOMMENDATION.md) §2), Bayesian smoothing, TTL/stale computation | every PR |
| Integration | Testcontainers (Postgres+pgvector, Redis) | repositories (tenant predicate enforced), Flyway migrations, tool dispatch, hybrid search SQL | every PR |
| API / **contract** | schema tests vs generated OpenAPI ([API.md](API.md)) | every documented shape; error envelope codes; `Idempotency-Key`; no-store headers; SSE event names | every PR |
| RAG | `rag_faithfulness_v1` | retrieval precision, citation resolution, answer-without-retrieval refusal | AI merge |
| Agent | `intent_v1`(1000) · `tool_selection_v1` · `safety_injection_v1` · `personalization_v1` | task/tool success, hallucination, injection containment | **release gate** (§5) |
| Browser E2E | Playwright (§74) | full journeys (§2) | nightly + pre-release |
| Visual | Playwright screenshot diff (§75) | major UI changes → regression detect | on UI PR |
| Security | §50 checklist + injection | tenancy 404, RBAC denial audit, SSRF allow-list | PR + scan |
| Performance | k6/vegeta | p95 search <250ms, first-event <1.2s, answer <6s (§11) | pre-release |

## 2. Playwright journeys (§74, vertical slice §168→§170 — the MVP acceptance path)
Consumer: register → login → **AI search** (`帮我找一个适合情侣约会的地方`) → open merchant → compare → favorite → reserve →
cart → checkout → confirmation. Merchant: signup → create business → upload menu → AI import → review generated profile
→ publish → enable AI agent → customer asks → AI responds → lead/reservation → analytics. These two scripts ARE the §170
"MVP COMPLETE" gate; they are recorded, not mocked.

## 3. Agent browser testing (§76)
An agent may drive the browser (open, click, type, scroll, wait, screenshot, inspect) to check "UI 是否真正可用"; results
saved under `tests/evidence/` as artifacts feeding [ARCHITECTURE.md](ARCHITECTURE.md) D7 self-review (§157).

## 4. "Every change must be verified" (§156) — per area
```
code   → modify → build → test
UI     → modify → browser → screenshot → visual inspection
agent  → modify → evaluation → test cases
search → query → ground truth → precision & relevance
```
`packages/types` is generated from contracts ([API.md](API.md)); a shape change without a passing contract test fails CI.
Unimplemented paths raise `NotImplementedError`/501 with a clear message — **no stub that pretends to work**
([D7](DECISIONS.md)).

## 5. Evaluation gate = merge blocker (§71–§73, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11)
Benchmarks in `eval_suites/eval_cases/eval_runs`; per-run metrics: task success, tool success, precision@10, relevance
nDCG, **hallucination rate**, p50/p95 latency, cost, human-intervention. **Gate (blocks merge — "no shipping and hoping"):**
hallucination **< 2%**, injection containment **100%**, p95 search **< 250ms**, no task-success regression **> 3pp**
([AI.md](AI.md) §6). With `NEXUS_LLM_PROVIDER=mock` (D4) these run offline/deterministically in CI; real-provider evals run
separately and are reported in the provider's own lane.

## 6. Honesty & data tests (§86, §109, §155) — non-negotiable
- Seed run (`data/seed`, 500+ merchants / 5000+ offerings / 10000+ reviews) asserts every row is `data_origin='demo'`,
  synthetic (invented names, `example.*` domains, DEMO markers) and renders `flags.demo` + `X-Demo-Data`
  ([DATABASE.md](DATABASE.md) §4, [D6](DECISIONS.md)).
- Golden assertions: no endpoint fabricates availability/rating/price/traffic; empty state is asserted valid;
  a rendered bullet without a `fact_id` fails the render test.
- A test must prove that with the LLM disabled the deterministic search path still returns (§105).

## Open questions / risks
- **Deterministic CI vs real-model quality:** mock keeps CI green but doesn't measure real hallucination/latency; the
  eval gate is only meaningful against a configured provider — define a separate, non-blocking "real model" lane.
- **nDCG/ground-truth labels** for `search_relevance_v1` are manual and subjective; without trustworthy labels the gate
  measures nothing (§71). Needs a labeling process that itself won't fabricate "truth".
- **Visual regression flakiness** (fonts/animations/streaming UI) vs. real signal — needs stabilized waits on `event: done`.
- **Playwright + streaming SSE + demo auth** coupling makes E2E brittle; the failure-ladder UI (degraded fallback) needs
  its own deterministic test hook rather than timing-dependent waits.
