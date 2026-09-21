# NEXUS — API (pointer document)

Status: **to be built.** This file is intentionally **thin**. It does **not** restate endpoint tables — the single
source of truth for every HTTP shape is [`API_CONTRACT.md`](API_CONTRACT.md). If this file and the contract ever seem to
differ, **the contract wins** and this file is a routing note only.

## The contract is `docs/API_CONTRACT.md`
Read it for: topology & ownership (§0), global conventions & error envelope (§1), shared objects `Fact`/`EntityCard`/
`Money`/`MatchExplanation`/`Intent` (§2, §7.1), auth/account (§3), merchants (§4), merchant workspace + AI import (§5),
commerce (§6), conversations & AI/SSE (§7), growth (§8), admin (§9), external-agent surfaces (§10), and the
non-functional contract (§11). Agent/tool/trust shapes (tool registry, orchestrator, ranking, eval gate) are in
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md). Design intent behind the endpoints is in [PRODUCT.md](PRODUCT.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [AI.md](AI.md).

## Two surfaces, two owners (do not mix them)
- `services/platform` (Spring Boot, 8080) owns `/api/v1/**`.
- `apps/ai` (FastAPI, 8000) owns `/ai/v1/**` plus the `/mcp` and `/.well-known/ucp` adapters.
- `apps/web` proxies `/api/*` (BFF) and opens SSE to the AI service; the browser never calls Postgres.
Detailed split: [`API_CONTRACT.md`](API_CONTRACT.md) §0 and [ARCHITECTURE.md](ARCHITECTURE.md) §3.

## OpenAPI generation workflow (§11)
1. **Contract-first design:** `API_CONTRACT.md` is the design input (hand-written).
2. **Code-first build:** endpoints are annotated in code — Spring/OpenAPI annotations in `services/platform`, FastAPI
   route models in `apps/ai`.
3. **Generate:** the running services expose `/v3/api-docs` (platform) and `/ai/openapi.json` (AI). These generated specs
   are the **build output**.
4. **Publish to shared types:** `packages/types` is generated from the merged OpenAPI (TS client + JSON Schemas +
   `Intent`/`EntityCard`/`Fact` models). No hand-maintained request/response interfaces in `apps/web`.
5. **Agreement check:** a CI job regenerates the specs and diffs them against `packages/types`; the design contract and
   generated output **must agree** (see contract tests below). Never edit a generated artifact by hand — change the code
   or `API_CONTRACT.md` and regenerate.

Suggested CI wiring (M0 task, see [ROADMAP.md](ROADMAP.md)):
```
platform:  springdoc → /v3/api-docs      →  openapi/platform.json
ai:        fastapi  → /ai/openapi.json   →  openapi/ai.json
codegen:   openapi + AGENT_CONTRACT schemas → packages/types
contract test: generated specs ⊆ API_CONTRACT.md shapes (and vice-versa on shared objects)
```

## Versioning policy
- Path versioning: `/api/v1/**`, `/ai/v1/**`. **v1 is additive-only**: new optional fields and new endpoints are
  non-breaking; removing/renaming a field, changing a type, tightening validation, or changing status-code semantics is
  breaking and requires `/v2`.
- Shared objects (`EntityCard`, `Intent`, `Fact`, `MatchExplanation`) are versioned implicitly by the
  [`API_CONTRACT.md`](API_CONTRACT.md) §2 shape; a change there is a change everywhere and must update `packages/types`
  + contract tests in the same commit ([`API_CONTRACT.md`](API_CONTRACT.md) header rule).
- `recommendation_sets.strategy` (`hybrid_v1`, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6) versions *ranking behaviour*
  independently of HTTP version so a ranker change can be A/B'd without an API bump.
- Deprecation: mark via response header + `Sunset`; remove only in a major version.

## Contract-test expectations ([`DECISIONS.md`](DECISIONS.md) D7, [TESTING.md](TESTING.md))
- **Schema conformance:** every documented request/response validated against the generated JSON Schemas for
  `packages/types`; a doc/example that fails to validate the schema is a red build.
- **Invariant tests (must pass or block merge):**
  - `Intent` never fills an unstated field (nulls stay null; `unknowns` lists what to ask, §8).
  - Every rendered `EntityCard` number has a matching entry in `facts[]`; every `ai_match.reasons[]` carries a
    `fact_id` ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4).
  - Availability / price / inventory responses carry `Cache-Control: no-store` (§103, [`API_CONTRACT.md`](API_CONTRACT.md) §11).
  - Mutation endpoints (checkout/payment/reservation/review/campaign-publish) reject a missing `Idempotency-Key` (§1).
  - Error envelope shape and codes are exact for `422/401/403/404/409/429/503/500` (§1).
  - SSE `/ai/v1/search/stream` emits only the legal event names (`status/intent/results/summary/done/error`) with
    user-legible text and no chain-of-thought (§116).
  - Demo rows set `flags.demo=true` and return `X-Demo-Data` ([`API_CONTRACT.md`](API_CONTRACT.md) §2, §109).
- **Consumer-driven contract tests:** the BFF/`apps/ai` clients run against a platform/AI mock built from the same spec,
  so frontend and services can be developed in parallel without drifting.

## Open questions / risks
- **Search surfaces are now one path each (resolved, was a contract bug):** `POST /ai/v1/search/stream` is the
  only SSE turn (the web BFF proxies it as `POST /api/nexus/ai/stream`); `POST /ai/v1/search` is the single
  deterministic non-streaming endpoint for MCP/UCP/API callers **and** the stream's `event: error` fallback
  target. `/api/v1/ai/**` does not exist on any service — see [`API_CONTRACT.md`](API_CONTRACT.md) §7 and
  [`STATUS.md`](STATUS.md) ruling D13. `scripts/check_contract_drift.mjs` fails CI if a client names a path
  the contract does not define, which is how this was caught.
- **Merchant-agent path** is `/ai/v1/merchant-agent/chat` (AI surface) while a consumer's ordinary turns are
  persisted through the platform (single writer, D20). The asymmetry is deliberate; §7.0 lists both doors.
- **Generated-vs-authored drift** is only caught if the CI diff job actually runs; until M0 wires it, treat
  `API_CONTRACT.md` as manual-law and re-verify shapes each milestone.
