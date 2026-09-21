# NEXUS API Contract (v1) — AUTHORITATIVE

> Every service and frontend module codes against this file. Changing a shape here means updating
> `packages/types` and re-running contract tests. Nothing else is a source of truth for HTTP shapes.

## 0. Topology & ownership

| Surface | Process | Port | Owns |
|---|---|---|---|
| `/api/v1/**` | Spring Boot platform service (`services/platform`) | 8080 | Auth, RBAC, merchants, offerings, orders, carts, reservations, payments, reviews, conversations, events, growth, admin |
| `/ai/v1/**` | FastAPI AI service (`apps/ai`) | 8000 | Query understanding, hybrid search, RAG, agent orchestration, recommendations, comparison, eval, observability |
| `/mcp`, `/.well-known/ucp` | FastAPI AI service adapters | 8000 | External-agent surface (§43-45) |
| `/**` | Next.js (`apps/web`) | 3000 | SSR/SSG pages, BFF proxy at `/api/*`, streaming UI |

Data access rules (no `LLM → database` path, §52):
- Platform service: `nexus_app` DB role, read-write on commerce tables.
- AI service: `nexus_ai` DB role — **SELECT** on merchants/offerings/locations/reviews/facts/business_hours/availability_slots,
  and read-write only on `documents, chunks, facts, recommendation_sets, feedback_events, agent_runs, llm_calls, eval_*, review_summaries, seo_pages, campaigns`.
  Anything it must mutate in the commerce core (cart, reservation, order) goes through platform HTTP APIs with a scoped token.
- Web never talks to Postgres. It calls platform + AI through the BFF.

## 1. Global conventions

- JSON only; **snake_case** keys; ISO-8601 UTC timestamps; `money` as string decimal + `currency` code.
- Auth: `Authorization: Bearer <jwt>` **or** `nexus_session` HttpOnly cookie. `X-CSRF-Token` required for state-changing cookie requests.
- Tenant: `X-Tenant: hong-kong` (else derived from hostname). Every query is tenant-scoped server-side.
- Request id: `X-Request-Id` echoed and attached to logs, `agent_runs`, `audit_logs`.
- Idempotency: `Idempotency-Key` **required** on checkout, payment, reservation create, review create, campaign publish.
- Rate limits: `429` + `Retry-After` + `X-RateLimit-Remaining`.
- Pagination: cursor-based — request `?limit=20&cursor=...`; response `{ "items": [...], "next_cursor": "...", "total_estimate": 123 }`.
- Error envelope (always):
```json
{ "error": { "code": "merchant_not_found", "message": "...", "details": {}, "request_id": "..." } }
```
  Codes: `validation_error(422) unauthorized(401) forbidden(403) not_found(404) conflict(409) rate_limited(429) ai_unavailable(503) internal(500)`.
- Failure ladder (§105): LLM error → fallback model → deterministic search endpoint → human handoff. `ai_unavailable` must
  never break `/ai/v1/search` (pure deterministic path).

## 2. Core shared objects

```jsonc
// GeoPoint
{ "lat": 22.3809, "lng": 114.1861 }

// Money
{ "amount": "128.00", "currency": "HKD" }

// Fact — the trust-layer primitive (§19). Any AI-stated fact cites one of these.
{
  "fact_id": "uuid",
  "subject_type": "offering",
  "subject_id": "uuid",
  "attribute": "price",
  "value": { "amount": "128.00", "currency": "HKD" },
  "source": "merchant",          // merchant|imported|observed|third_party|inferred
  "confidence": 0.98,
  "observed_at": "2026-09-22T02:00:00Z",
  "expires_at": "2026-09-22T08:00:00Z",
  "stale": false
}

// Opening state (computed, never guessed)
{ "is_open": true, "opens_at": "...", "closes_at": "...", "as_of": "...", "source_fact_id": "uuid" }

// MatchExplanation (§18) — every bullet must trace to a fact id
{ "label": "within_budget", "text": "符合你的预算 HK$500", "value": "128.00", "fact_id": "uuid" }

// EntityCard — the single render contract for consumer + AI + MCP surfaces (§35)
{
  "card_type": "merchant",            // merchant|product|service|experience|collection
  "id": "uuid",
  "slug": "lung-yuen-kitchen",
  "title": "龍苑 Kitchen",
  "subtitle": "Cantonese · Sha Tin",
  "image": { "url": "https://...", "alt": "demo image", "credit": "synthetic" },
  "price": { "amount": "128.00", "currency": "HKD", "model": "per_person" },
  "rating": { "value": 4.6, "count": 213 },
  "distance": { "meters": 700, "text": "700m", "travel_minutes": 9 },
  "open": { "is_open": true, "text": "Open until 22:00" },
  "availability": { "status": "available", "next_slot": "2026-09-26T19:00:00Z" },
  "ai_match": { "score": 0.91, "reasons": [ /* MatchExplanation[] */ ] },
  "actions": [ { "type": "reserve", "label": "预订", "endpoint": "/api/v1/reservations" } ],
  "facts": [ /* Fact[] backing every rendered number */ ],
  "flags": { "sponsored": false, "demo": true, "unverified": false }
}
```

`flags.demo` is `true` for all seeded/synthetic data and must be surfaced in the UI (§109, §155).

## 3. Auth & account

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/register` | `{email,password,display_name,locale,accept_terms}` → `{user,access_token,refresh_token}`; password Argon2id |
| POST | `/api/v1/auth/login` | `{email,password}` → same shape |
| POST | `/api/v1/auth/oauth/{provider}` | `{id_token}` verified against provider JWKS (google/apple) |
| POST | `/api/v1/auth/refresh` | `{refresh_token}` → new pair (rotation, reuse detection) |
| POST | `/api/v1/auth/logout` | clears session |
| GET | `/api/v1/me` | profile + memberships + preferences summary |
| PATCH | `/api/v1/me` | profile |
| DELETE | `/api/v1/me` | creates `deletion_request` (§106) |
| GET | `/api/v1/me/export` | streaming JSON of all personal data |
| GET/PATCH/DELETE | `/api/v1/me/preferences[/{id}]` | preference memory; user-visible, editable, deletable (§32-33) |
| POST | `/api/v1/me/personalization/reset` | wipes inferred memory |
| GET | `/api/v1/me/favorites` · POST `/api/v1/me/favorites` · DELETE `/api/v1/me/favorites/{type}/{id}` | |
| GET/POST/DELETE | `/api/v1/me/saved-searches[/{id}]` | |
| GET | `/api/v1/me/orders` · `/me/reservations` · `/me/conversations` | |
| GET | `/api/v1/notifications` · POST `/api/v1/notifications/{id}/read` | in-app inbox for the acting subject (§123-125); merchant notifications are read through the same route with the merchant membership |
| GET | `/api/v1/users/{id}` | **admin/ops only** — consumer support tooling (§68). Merchant staff must never reach this; merchant-side customer data goes through `/api/v1/merchant/customers` and is RBAC-scoped (§46, §47). The `/api/v1/me/*` routes are the self-service surface and stay separate on purpose. |

JWT claims: `sub, tid (tenant), typ(access|refresh), sid, jti, iat, exp`. Access 15m, refresh 30d rotating.
Demo login (§87): `POST /api/v1/auth/demo {role: consumer|merchant|admin}` returns a scoped demo session.

## 4. Merchants (consumer-facing reads are public, cacheable)

| Method | Path |
|---|---|
| GET | `/api/v1/merchants?district=&category=&max_price=&open_now=&rating=&cursor=` |
| GET | `/api/v1/merchants/{id_or_slug}` — profile + locations + hours + top offerings + review summary |
| GET | `/api/v1/merchants/{id}/menu` | paginated offerings |
| GET | `/api/v1/merchants/{id}/reviews?sort=recent|helpful&cursor=` |
| GET | `/api/v1/merchants/{id}/reviews/summary` | AI summary **with review_ids as evidence** (§55) |
| GET | `/api/v1/merchants/{id}/availability?starts_at&ends_at&party_size` | real-time, no cache (§20) |
| GET | `/api/v1/locations/geo?bbox=&zoom=` | marker clustering payload |

## 5. Merchant workspace (tenant + RBAC enforced; role from `merchant_users`)

| Method | Path | Required permission |
|---|---|---|
| POST | `/api/v1/merchant/businesses` | (creates membership owner) |
| PATCH | `/api/v1/merchant/businesses/{id}` | `write_profile` |
| POST | `/api/v1/merchant/businesses/{id}/verification` | `write_profile` |
| POST | `/api/v1/merchant/businesses/{id}/publish` | `publish_listing` |
| POST/PATCH/DELETE | `/api/v1/merchant/offerings[/{id}]` | `write_products` |
| POST | `/api/v1/merchant/offerings/bulk` | `write_products` |
| POST | `/api/v1/merchant/imports` | `write_products` |
| GET | `/api/v1/merchant/imports/{job_id}` | `read_products` |
| GET | `/api/v1/merchant/dashboard/overview` | `read_analytics` |
| GET | `/api/v1/merchant/analytics?from&to&metric` | `read_analytics` |
| POST | `/api/v1/merchant/ai-agent/config` | `configure_ai` |
| GET | `/api/v1/merchant/conversations` · POST `/{id}/reply` · POST `/{id}/handoff-resolve` | `send_message` |
| POST | `/api/v1/merchant/campaigns` (AI drafts land in `draft`) | `create_draft_campaign` |
| POST | `/api/v1/merchant/campaigns/{id}/approve-publish` | `publish_campaign` — **explicit human action** (§27) |
| POST | `/api/v1/merchant/coupons` | `create_draft_campaign` |
| GET | `/api/v1/merchant/knowledge-base` · POST `/knowledge-base/reindex` | `read_products` / `configure_ai` |
| POST | `/api/v1/merchant/api-keys` · DELETE `/{id}` | `admin_members` |
| GET | `/api/v1/merchant/members` · POST/PATCH/DELETE `/{member_id}` | `admin_members` |
| GET | `/api/v1/merchant/export` | `read_products` — merchant owns data (§107) |

### 5.1 AI import (§22)
`POST /api/v1/merchant/imports`
```json
{ "merchant_id": "uuid", "source": { "type": "url", "value": "https://example.hk/menu" },
  "files": [{ "name": "menu.pdf", "content_base64": "..." }] }
```
→ `202 { "job_id": "uuid", "status": "queued" }`. Async pipeline: crawl → parse → clean → chunk → embed → classify →
proposed offerings. Client polls `GET /imports/{job_id}` and gets `proposals: [{offering_draft, evidence_fact_ids, confidence}]`.
Nothing is published without merchant review.

## 6. Commerce

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/carts` | `{}` → cart (anonymous allowed, `session_id`) |
| GET | `/api/v1/carts/current` | universal cart: products + services + reservations (§41) |
| POST | `/api/v1/carts/items` | `{offering_id|reservation_id, quantity, options}`; server re-prices + TTL check |
| PATCH | `/api/v1/carts/items/{id}` | |
| DELETE | `/api/v1/carts/items/{id}` | |
| POST | `/api/v1/carts/price-check` | returns per-item `stale` flags before checkout — never silently charge stale price (§20,§103) |
| POST | `/api/v1/carts/checkout` | **Idempotency-Key required** → `{order, payment_intent}` |
| GET | `/api/v1/orders/{id}` | status machine |
| POST | `/api/v1/orders/{id}/cancel` | |
| POST | `/api/v1/reservations` | `{merchant_id,offering_id?,slot_id,party_size,contact,notes}` → `201` with code |
| PATCH | `/api/v1/reservations/{id}` | `status` transitions guarded |
| POST | `/api/v1/payments/{order_id}/confirm` | demo provider; real provider via webhook |
| POST | `/api/v1/webhooks/payments/{provider}` | signature verified, idempotent |
| POST | `/api/v1/merchants/{id}/reviews` | verified purchase/reservation flags computed server-side |

## 7. Conversations & AI

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/v1/conversations` | `{merchant_id?, channel, mode}` → conversation |
| GET | `/api/v1/conversations/{id}` | messages + state |
| POST | `/ai/v1/search/stream` | `{query, conversation_id?, context:{geo,now,locale,party_size}}` → **SSE stream** (§116). The web BFF proxies this as `POST /api/nexus/ai/stream`; the platform service never serves `/api/v1/ai/**`. |
| POST | `/ai/v1/search` | non-streaming variant for MCP/UCP/API consumers (also the §105 fallback target) |
| POST | `/ai/v1/query/understand` | `{query, context}` → `Intent` (below) |
| POST | `/ai/v1/search` | deterministic hybrid search: `{intent, geo?, filters?, limit}` → `{items:EntityCard[], facets, took_ms, strategy, degraded:false}` |
| POST | `/ai/v1/recommend` | `{intent|conversation_id, limit}` → `{set_id, items:EntityCard[]}` with explanations + fact ids |
| POST | `/ai/v1/compare` | `{subject_ids:[...] }` → `{rows:[{attribute, cards:[{value,fact_id}]}]}` (§37) |
| POST | `/ai/v1/rag/retrieve` | `{query, merchant_id?, filters, top_k}` → `{chunks:[{id,text,score,document_id,source_uri,fact_ids}]}` |
| POST | `/ai/v1/merchant-agent/chat` | `{merchant_id, message, conversation_id}` → SSE; grounded only in merchant KB, low confidence → handoff (§24-26) |
| POST | `/ai/v1/feedback` | `{subject_type,subject_id,signal,value,session_id}` (§99) |
| GET | `/ai/v1/tools` | tool registry manifest (§11) with schema + permission |

SSE event stream for `/ai/v1/search/stream` (statuses are user-legible, never chain-of-thought):
```
event: status     data: {"stage":"understanding","text":"理解需求…"}
event: intent     data: {Intent}
event: status     data: {"stage":"searching","text":"搜索附近商户…"}
event: results    data: {"set_id":"uuid","items":[EntityCard…]}
event: summary    data: {"text":"找到 8 个符合条件的选择","citations":[fact_id…]}
event: done       data: {"agent_run_id":"uuid","latency_ms":812,"cost_usd":0.0042,"degraded":false}
```
`event: error` → client falls back to `POST /ai/v1/search` (deterministic).

### 7.1 Intent (canonical query-understanding object, §8)
```jsonc
{
  "raw_query": "帮我找沙田适合情侣约会的餐厅，预算500，安静一点，周六晚上",
  "intent": "discover_merchant",       // discover_merchant|discover_offering|reserve|purchase|ask_merchant|compare|plan_experience|unknown
  "category": "restaurant",            // null when not stated
  "location": { "type":"district", "value":"Sha Tin", "resolved": {"lat":22.38,"lng":114.19}, "radius_m": null },
  "time": { "type":"explicit", "starts_at":"2026-09-26T19:00:00Z", "ends_at":null },
  "budget": { "min": null, "max": 500, "currency":"HKD", "per":"party" },
  "party_size": null,
  "preferences": [ {"key":"ambience","value":"quiet","polarity":1} ],
  "constraints": [ {"key":"cuisine_avoid","value":"spicy"} ],
  "sort_preference": "relevance",      // relevance|distance|price_low|rating|trending
  "urgency": "normal",
  "language": "zh-HK",
  "confidence": { "category":0.95, "budget":0.9, "time":0.8 },
  "unknowns": ["party_size"]           // §8 — never guess; ask in one follow-up only
}
```
Conversation state merges successive turns: "太贵了" → `budget.max *= 0.7`; "近一点" → `sort_preference=distance`,
`location.radius_m` tightened; "不吃辣" → append constraint. Merge rules live in `apps/ai/app/nlu/state_merger.py`.

## 8. Growth & creator

`GET /api/v1/referrals/me` · `POST /api/v1/referrals/invite {kind,email}` · `GET /api/v1/referrals/me/stats` ·
`GET /api/v1/collections` · `POST /api/v1/collections` · `GET /api/v1/guides/{slug}` (SSR + JSON-LD) ·
`POST /api/v1/share {subject_type,subject_id}` → short link + OG payload.
Referral rewards are recorded only on genuine conversion events (§110 forbids fake growth).

## 9. Admin console (§68, §126-127)

`GET /api/v1/admin/{users|merchants|orders|reservations|reviews|reports}` ·
`GET /api/v1/admin/moderation` + `POST /api/v1/admin/moderation/{case_id}/resolve {action,note}` ·
`GET /api/v1/admin/ai/runs` · `GET /api/v1/admin/ai/costs?group_by=agent|model|day` ·
`GET /api/v1/admin/search/analytics` · `POST /api/v1/admin/merchants/{id}/suspend` ·
`GET /api/v1/admin/system/health` · `POST /api/v1/admin/ai/ask {question}` (Admin Analytics Agent, read-only tools).
All admin routes require `role IN (platform_admin, platform_ops)` and write `audit_logs`.

## 10. External agent surfaces (§43-45)

- `GET /.well-known/ucp` (host root, the path UCP discovery actually fetches) → NEXUS's own profile
  `{version, capabilities[], endpoints[], payment_handlers[]}`; `GET /api/v1/merchants/{slug}/ucp.json` → that merchant's
  delegated profile, referenced from the host document. Both are produced by `UcpAdapter` only — business code must not
  build UCP JSON, and no other route may serve these shapes.
- `/mcp` (streamable HTTP + JSON-RPC): tools `search_nexus`, `get_merchant`, `search_products`, `check_availability`,
  `create_cart`, `create_reservation`, `get_order_status`. `check_availability` is the external-facing **alias** of the
  registry tool `get_availability` (canonical name inside `apps/ai`, per AGENT_CONTRACT §3) — the alias lives only in the
  MCP adapter and is documented in the tool manifest, so no second implementation appears. Every call authenticates an `external_principals` row,
  checks scopes, and writes `agent_runs` + `audit_logs`.

## 11. Non-functional contract

- p95 `/ai/v1/search` < 250ms warm; AI search first-stream-event < 1.2s; LLM full answer < 6s.
- All list endpoints support `ETag`/`Cache-Control` except availability/inventory/price (no-store, §103).
- OpenAPI is generated from code annotations at `/v3/api-docs` and `/ai/openapi.json` — this document is the design
  input, generated specs are the build output; they must agree (contract test in CI).
