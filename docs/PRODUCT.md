# NEXUS — Product Spec (engineering-facing)

Status: **to be built.** This is the requirement-to-build bridge: each feature names its owning module, the data it
touches, and its acceptance test. Shapes are in [`API_CONTRACT.md`](API_CONTRACT.md)/[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md);
this file must not fork them. Section numbers `§n` map to `新建 文本文档.txt`.

## 0. Module ownership map (D2)

| Surface | Module (path) | Process / port |
|---|---|---|
| Consumer + Merchant + Admin UI | `apps/web` route groups `(consumer)` `(merchant)` `(admin)`, Next.js App Router | Next 15 / 3000, SSR+SSG |
| Commerce core (auth, merchants, offerings, carts, orders, reservations, payments, reviews, conversations, events, growth, admin) | `services/platform/.../<domain>/` Java packages in one Spring Boot monolith | Java / 8080 |
| AI (query understanding, search, RAG, agents, recommendations, compare, eval, observability) | `apps/ai/app/<subsystem>/` | FastAPI / 8000 |
| Shared types + JSON Schemas (generated) | `packages/types` | build artifact |
| Config (ranking weights, i18n) + compose + migrations | `infra/` | — |
| Synthetic data generator + loader | `data/seed` | — |
| Browser suites + evidence | `tests/e2e` | Playwright |

## 1. Consumer experience

### 1.1 Homepage (§6, §90)
Premium, single primary input ("Tell me what you need…" → ✨ AI Search), below it: Popular near you / For You / Trending /
Recommended / Recently viewed. Owner: `apps/web/(consumer)`. Data: `/api/v1/merchants`, `/ai/v1/recommend` (for you),
`trending` = `popularity_score` (§17). Acceptance: anonymous visitor sees deterministic, real-data-backed rails (empty
when no data — never fabricated, §155).

### 1.2 AI Search — natural language (§7, §8, §116)
Input is free text. Pipeline (§0, §10): intent understanding → query planning → search → retrieval → merchant/offering
matching → ranking → recommendation → reservation/cart → checkout. Query-understanding output is the canonical `Intent`
JSON ([`API_CONTRACT.md`](API_CONTRACT.md) §7.1, detail in [AI.md](AI.md)); **uncertain fields stay null — never guess**
(§8). Response is streamed with user-legible stages (`理解需求… 搜索附近商户… 找到 8 个符合条件的选择`), never chain-of-thought
(§116). Owner: `apps/ai` (understand/search/recommend) + `apps/web` (SSE UI). Acceptance: first stream event < 1.2s, full
answer < 6s (§11, [API.md](API.md)).

### 1.3 Conversation / multi-turn (§34)
Follow-ups mutate state: `太贵了` → budget down; `近一点` → distance sort + tighter radius; `不吃辣` → append constraint.
State (`conversation`, `intent`, `filters`, `preferences`) persists on `conversations.state`. Merge rules in
`apps/ai/app/nlu/state_merger.py` ([AI.md](AI.md)). Acceptance: 4-turn script returns coherent narrowing (E2E, [TESTING.md](TESTING.md)).

### 1.4 Result interface + cards (§35, §36, §37)
Result = AI summary + cards + comparison + map + actions (§36), grouped (Best match / Best value / Closest / Most
popular). The single render contract is `EntityCard` ([`API_CONTRACT.md`](API_CONTRACT.md) §2): image, title, price,
rating, distance, open/closed, ai_match+reasons, actions, facts, flags. Every number must resolve to a `fact_id` or not
render (§18, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4). Comparison table (§37) is `/ai/v1/compare` with per-cell fact
ids. Owner: `apps/web/(consumer)` shared components; card built by `apps/ai` + `services/platform`. Acceptance: no card
renders a bullet lacking `fact_id`.

### 1.5 Maps & local discovery (§38, §39)
Map: user location, merchant markers, clustering (`/api/v1/locations/geo?bbox=&zoom=`), directions link, distance,
travel time when available. "我附近有什么好玩的？" fans out across restaurant/activity/shopping/experience using location+
time+budget+preferences (§39). Geo is bbox-preferred then haversine-sorted ([DATABASE.md](DATABASE.md), [SEARCH.md](SEARCH.md)).
Acceptance: markers cluster at low zoom; precise geo used only with consent ([AGENT_CONTRACT.md](AGENT_CONTRACT.md) §1).

### 1.6 Account, favorites, saved searches, preferences memory (§31, §32, §33)
Profile, Preferences, Favorites, History, Orders, Reservations, Saved searches, AI conversations (§31). User Preference
Memory (`user_preferences`, kinds food/budget/location/brand/style/activity): the user can **view, edit, delete** and
`Forget this preference` / `Delete memory` / `Reset personalization` (§32, §33). Endpoints: `/api/v1/me/preferences[/id]`,
`/me/personalization/reset`, `/me/favorites`, `/me/saved-searches`. Acceptance: reset wipes `source='inferred'` rows;
export (`/me/export`) returns all personal data (§106).

### 1.7 Reservation, Cart, Checkout (§40, §41, §42)
- Reservation service abstracts restaurant/hotel/activity/beauty/fitness via `resource_pools` + `availability_slots`
  (§40) — no per-vertical hardcoding ([DATABASE.md](DATABASE.md)).
- Universal Cart holds product+service+reservation (§41) and must stay extensible toward UCP `CreateCart` (§41, [UCP.md](UCP.md)).
- Checkout (§42): **no card data stored**; `Nexus → PaymentProvider → Merchant`. `PaymentProvider` interface with a
  `demo` impl (D5). Idempotency mandatory; price re-validation + `stale` flags before charging (§20, §103). Owner:
  `services/platform/.../{reservation,cart,order,payment}`. Acceptance: checkout with stale price surfaces
  `价格可能已更新` and refuses silent charge; replaying `Idempotency-Key` returns the first result.

### 1.8 Reviews (§54, §55)
Consumer submits rating/text/photos; `verified_purchase`/`verified_reservation` computed server-side. AI summary of
praise/complaints must cite `review_ids` as evidence and never fabricate (§55). Owner: `services/platform/.../review`
(writes) + `apps/ai` (summary). Acceptance: summary UI links each bullet to source reviews.

## 2. Merchant experience (§1, §21–§28)

Full detail in [MERCHANT.md](MERCHANT.md); product-level contract here.
- Onboarding funnel (§21, §91): Email/Google/Apple → Create Business → Verification → Upload → AI Import → Review →
  Publish → get first lead.
- AI Import (§22): URL/PDF/menu/Excel/images → crawl → extract → classify → normalize → proposed offerings + KB.
  **Nothing publishes without merchant review.**
- Dashboard (§23): Overview/Analytics/AI Conversations/Customers/Products/Services/Orders/Reservations/Reviews/
  Marketing/SEO/AI Agent/Knowledge Base/Settings/Billing.
- AI Sales Agent (§24) + Customer Service (§25): grounded in merchant KB only; low confidence → human handoff (§26).
- Marketing Agent (§27): drafts campaign/coupon/social/email/WhatsApp/landing — **draft only; publish needs explicit
  human authorization**.
- SEO Agent (§28): generates landing/FAQ/descriptions — must clear a quality bar, no AI spam (§28, §30).

## 3. Platform capabilities (§140 MVP)

MVP must ship: consumer AI search, merchant discovery, recommendations, merchant pages, comparison, favorites, account;
merchant signup, business profile, product/service mgmt, AI knowledge base, AI customer agent, basic analytics; platform
RAG, Search, Recommendation, Agent orchestration, PostgreSQL, pgvector, Redis, authentication, E2E testing (§140).

## 4. MVP success tests (§141, §142, §170)

- Consumer (§141): new user understands NEXUS in 30s, states first need in 60s, gets a valuable recommendation in 2m,
  completes one meaningful action in 5m.
- Merchant (§142): creates own AI merchant page in 5m, finishes KB in 10m, enables AI agent in 15m, agent answers a real
  consumer question.
- Vertical slice (§168→§170): the full loop runs end to end — the acceptance bar for "MVP COMPLETE". See [ROADMAP.md](ROADMAP.md).

## 5. Prioritization (§137)

Tasks in [ROADMAP.md](ROADMAP.md) carry P0–P5 (P0 system broken, P1 core journey broken, P2 important feature, P3 UX,
P4 optimization, P5 nice-to-have). The core user journey (Landing→Search→AI→Results→Merchant→Compare→Action, §138) and
core merchant journey (Signup→Create→Import→AI understands→Publish→Interaction→Lead/Reservation, §139) are always
highest priority.

## Open questions / risks
- **Reservation depth vs. breadth:** §40 wants one generic resource model; real restaurant table-turnover vs. hotel
  room-nights vs. class seats differ enough that `resource_pools` attributes may need per-kind semantics — resolve in M4.
- **Checkout in phase 1:** payment is `demo`-only (D5). "Meaningful action" (§141) for MVP may mean reservation/favorite,
  not a real paid order — confirm the acceptance definition with the lead.
- **Comparison cost:** §37 comparison of 3+ merchants with fresh facts can blow the 3-LLM-call/request budget
  ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2); likely needs a deterministic (no-LLM) compare path.
- **Multi-merchant cart (§41):** schema allows soft grouping (`carts.merchant_id` nullable) but pricing/fulfillment
  across merchants is unspecified — deferred beyond the vertical slice (§169).
