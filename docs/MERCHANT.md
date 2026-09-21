# NEXUS — Merchant Product & AI Business Agent (§1, §21–§28, §46–§49, §56–§57, §65, §107)

Status: **to be built.** One merchant = one tenant-scoped business; merchants are strictly isolated (§47, [DATABASE.md](DATABASE.md) §2).
Ownership: `services/platform/.../merchant*` (profile, offerings, imports, memberships, billing) + `apps/ai` (agent,
marketing/seo/analytics generators) + `apps/web/(merchant)` dashboard. RBAC surface in [`API_CONTRACT.md`](API_CONTRACT.md) §5;
agent roster/grants in [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1/§8.

## 1. Onboarding funnel (§21, §91, §139)
```
Email/Google/Apple → Create Business → Business Verification → Upload Information → AI Import → Review → Publish
```
- `POST /api/v1/merchant/businesses` (creates owner membership) → `PATCH .../{id}` (`write_profile`) →
  `POST .../verification` (`write_profile`) → `POST .../imports` (`write_products`) → publish `POST .../publish`
  (`publish_listing`). Only at **publish** does `merchants.status='published'` make the business discoverable —
  the `search` agent must not return draft/suspended rows ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).
- Funnel goal (§91): the merchant sees real value (first lead) as fast as possible. §142: page in 5m, KB in 10m, agent
  enabled in 15m.

## 2. AI Merchant Import (§22) — proposals, never auto-publish
`POST /api/v1/merchant/imports {merchant_id, source:{url|files[]}}` → `202 {job_id, status:'queued'}`. Async pipeline
(crawl → extract → classify → normalize → create products/services → create knowledge base) runs in the AI service as a
**background worker** ([AI.md](AI.md) §4, [RAG.md](RAG.md) §5). `GET /imports/{job_id}` returns
`proposals: [{offering_draft, evidence_fact_ids, confidence}]`. Parsed text/URLs are **untrusted** (§51). Imported rows
carry `data_origin='imported'` (or `demo` when synthetic, §109); **nothing is published without merchant review**
([`API_CONTRACT.md`](API_CONTRACT.md) §5.1). Imported docs land in `documents`/`chunks` → the Merchant Knowledge Base
(§13, [RAG.md](RAG.md)). Merchant Knowledge Graph (§119): merchant → {product, service, location, category, review,
opening hours, policy, availability} — all present as FK'd tables in [DATABASE.md](DATABASE.md).

## 3. Dashboard (§23)
Overview · Analytics · AI Conversations · Customers · Products · Services · Orders · Reservations · Reviews · Marketing ·
SEO · AI Agent · Knowledge Base · Settings · Billing. Mobile-first, premium visual bar (§77–§79, [CONSUMER.md](CONSUMER.md) §6).
Data: `GET /api/v1/merchant/dashboard/overview`, `.../analytics?from&to&metric` (`read_analytics`); analytics from
`v_merchant_funnel` + `events` (§56: views, AI impressions, search appearances, clicks, leads, reservations, orders,
conversion, revenue, repeat customers).

## 4. Merchant AI Sales Agent (§24) + Customer Service (§25) + Human Handoff (§26)
- `POST /ai/v1/merchant-agent/chat {merchant_id, message, conversation_id}` → SSE. Grounded **only** in that merchant's
  KB (tenant+merchant retrieval filter, [RAG.md](RAG.md) §2). Flow: retrieve menu → check availability → recommend
  (§24). Handles opening hours, pricing, product details, policies, availability, reservations, order status (§25).
- **Human handoff (§26):** low confidence (below floor, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4) or can't answer →
  write `handoffs` row, flip `conversations.status='handoff'`, notify merchant ("Customer requires assistance",
  §124). Merchant replies via `POST /api/v1/merchant/conversations/{id}/reply`; resolve via `/{id}/handoff-resolve`
  (`send_message`). The agent may message and create `leads`, but **never act outside merchant grants**
  ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1). `ai_agent_enabled` gates whether the agent answers at all.

## 5. Marketing Agent (§27) — draft-only, explicit authorization
`POST /api/v1/merchant/campaigns` + `/coupons`. Input "帮我提高周一到周三下午的客流" → agent analyses
historical data → segments → demand → competitors → offer opportunities → generates campaign/coupon/social/email/
WhatsApp/landing. **Default generate, never auto-publish** (§27): AI drafts land in `campaigns.status='draft'`;
publishing is an **explicit human action** `POST .../campaigns/{id}/approve-publish` requiring `publish_campaign`
(never in a default agent grant, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8). `coupons.published_by`/`campaigns.approved_by`
record the human. Idempotency required on campaign publish ([`API_CONTRACT.md`](API_CONTRACT.md) §1).

## 6. SEO Agent (§28) + anti-spam (§29, §30)
Analyses search demand / content / competitors / long-tail → generates landing pages / FAQ / descriptions / merchant
pages / local guides → `seo_pages(status='draft')`. Guardrails: each page must carry unique real value — `seo_pages.data`
holds the real listings backing it and `quality_score` gates publish; **no mass low-quality AI spam** ("10万只有城市名不同
的垃圾页面", §28/§30). SEO architecture (routes, SSR/SSG, canonical, JSON-LD, sitemap, robots, OpenGraph, §29) is a
platform/Next concern; page generation is the AI `seo` agent (drafts only). See [GROWTH.md](GROWTH.md) §SEO.

## 7. Analytics Agent (§57)
`POST /api/v1/admin/ai/ask` is admin-side; the merchant analytics agent answers "为什么这个月订单下降?" by reading the
merchant's own events → traffic → conversion → reviews → availability → price → campaigns → emits
Findings / Evidence / Possible causes / Recommended actions. The `analytics` agent may **not expose other merchants'
data** ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1) and is read-only.

## 8. Merchant AI API (§46) + monetization (§65) + data ownership (§107)
- `apiv1merchant`: merchant-owned agents call inventory/products/orders/customers/availability/analytics via `api_keys`
  (`key_hash`, scoped) with **strict RBAC** ([DATABASE.md](DATABASE.md) §3.1); keys managed with `admin_members`.
- Plans free/pro/enterprise (`merchants.plan`, `subscriptions`); chargeable surfaces listed in [GROWTH.md](GROWTH.md).
- **Data ownership (§107):** merchant owns business info, products, customer-relationship data;
  `GET /api/v1/merchant/export` (`read_products`) must return it — never a design where the merchant can't leave.

## 9. RBAC roles (§48, §49)
`Owner Admin Manager Staff Marketing Analyst AI Agent`. Permissions (`write_profile`, `publish_listing`, `write_products`,
`read_products`, `read_analytics`, `configure_ai`, `send_message`, `create_draft_campaign`, `publish_campaign`,
`admin_members`, §49) map to `permission_grants`. The **AI Agent is a first-class permissioned subject**, default
read-only (§49, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8). Cross-tenant merchant access returns 404 (D5).

## Open questions / risks
- **Verified-merchant trust vs. AI-imported claims (§53):** imports may create plausible-but-wrong offerings; merchant
  review is the only check — needs a clear diff UI and a "changed after review" re-confirmation before publish.
- **Sales-agent availability (§24):** "check availability" must hit real-time `availability_slots` (TTL 0); with demo
  data there are no genuine slots, so the slice can *demonstrate* but not *promise* a booking ([D6](DECISIONS.md)).
- **Marketing data access (§27):** competitor analysis needs cross-merchant signals, but the analytics/marketing agents are
  forbidden to expose other merchants' data — resolve what aggregate (if any) is permitted, privacy-safe.
- **Publish authorization UX (§27):** the human-approval step is a hard trust boundary; if it's skippable in the UI the
  guarantee is cosmetic — enforce server-side, not just button state.
