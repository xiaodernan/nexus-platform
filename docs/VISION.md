# NEXUS — Vision

Status: **planning document. Nothing here is implemented yet.** All subsystems described are *to be built*.
Traceability: section numbers (`§n`) refer to the product spec `新建 文本文档.txt` (172 sections). Binding
engineering decisions live in [`DECISIONS.md`](DECISIONS.md); shapes live in [`API_CONTRACT.md`](API_CONTRACT.md),
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md), and the schema in `infra/db/V1__init.sql` (see [`DATABASE.md`](DATABASE.md)).

## 1. One-line thesis

NEXUS is the **AI Decision Layer for Commerce** (§2): a consumer states an intent in natural language and NEXUS
understands, searches, compares, reasons, recommends, and can complete the transaction; a merchant gets an
**AI Business Agent** (§1) that acquires customers, answers questions, sells, markets, and analyses — grounded only in
the merchant's own verified data.

This is deliberately *not* a "website that looks AI" (§172). It is not a Yelp/Maps/Amazon/Shopify/OpenTable/ChatGPT
clone (§2). The differentiator is the decision loop, not the catalog UI.

```
Traditional:  Search → 10 pages → 20 products → User compares → User decides      (§2)
NEXUS:        User intent → AI understands → searches → compares → reasons
              → recommends → User decides                                           (§2)
Future:       User intent → AI → Reservation/Cart → Checkout                        (§2)
```

## 2. Two-sided product

| Side | Who | Core promise (§90) | Principal docs |
|---|---|---|---|
| Consumer | HK shoppers/diners/locals | "Tell us what you want." (§0) — find exactly what you want | [CONSUMER.md](CONSUMER.md) |
| Merchant | local businesses | "Let AI bring customers to you." — real leads, not ads sold | [MERCHANT.md](MERCHANT.md), §164 |
| External agents | ChatGPT/Gemini/Claude | NEXUS as a callable commerce database (§96) | [MCP.md](MCP.md), [UCP.md](UCP.md) |
| Platform staff | admins/ops/moderators | trust, moderation, cost & eval control | [SECURITY.md](SECURITY.md), [TESTING.md](TESTING.md) |

Merchant philosophy: help merchants genuinely acquire customers, not just sell placements (§164).

## 3. Market & scope strategy

- First market **Hong Kong**, architecture **global-ready** (§4): HK → Shenzhen → Guangzhou → GBA → SG → Tokyo →
  Seoul → global cities. Tenancy is modelled as `tenants` = market/city boundary (§47, [`DATABASE.md`](DATABASE.md)).
- Phase-1 verticals = **Local Commerce** (§5): restaurants, cafes, bars/entertainment (where legal), fitness, beauty,
  activities, hotels, local experiences, shopping, services. Travel/education/healthcare/home-services/automotive/
  real-estate/professional-services come later (§5).
- Cold start (§94): do **not** cover all of HK. One dense vertical + one dense geography (e.g. restaurants + Sha Tin /
  selected Kowloon districts), establish merchant density × consumer usefulness, then expand (§95).
- Consumer default locale is `zh-HK`, currency `HKD`, timezone `Asia/Hong_Kong`, district/area + MTR proximity
  addressing (§111, §112, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §12). Example intent (§8):
  `"帮我找沙田适合情侣约会的餐厅，预算500，安静一点，周六晚上"`.

## 4. Agentic-commerce posture (§3)

NEXUS assumes the transaction layer will increasingly be driven by external AI agents. Therefore the architecture must
keep, from day one, seams for **UCP** (Google Universal Commerce Protocol — merchant publishes `/.well-known/ucp`
capability profile with version/capabilities/endpoints/payment handlers, §43), **MCP** (a Nexus MCP server exposing
`search_nexus`/`get_merchant`/`create_cart`/…, §44), and later AP2/A2A (§3). UCP/MCP logic must not leak into business
code (§43); they are adapter surfaces over the same commerce core (§45). Phase 4 wires external-agent commerce (§146);
the *seams* are reserved in phase 1.

```
External Agent → Nexus MCP / UCP → Nexus Commerce Engine → Merchant        (§45)
```

The long-horizon vision is an **Agent Commerce Network** where a consumer agent negotiates restaurant/activity/
transport agents into one plan→availability→cart→reservation→payment flow (§148, §149). That is explicitly *not*
phase 1.

## 5. Honesty is a product requirement, not a value statement

The trust layer (§19) is the moat and the constraint on everything else. Binding rules (§109, §155, [`DECISIONS.md`](DECISIONS.md) D6):
- Every material fact an answer states carries `source`, `timestamp`, `confidence` and resolves to a `facts` row
  ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4).
- No fabricated availability, ratings, prices, transactions, reviews, merchants or traffic. Empty results are a valid,
  designed state.
- All seed/demo data is flagged `data_origin='demo'` / `flags.demo=true`, rendered as a UI badge and an `X-Demo-Data`
  header (§86, §109, [`API_CONTRACT.md`](API_CONTRACT.md) §2).
- Sponsored listings never corrupt organic ranking (§66, §67); recommendations must be explainable and uncertain things
  must be labelled uncertain (§18, §108). Product philosophy: user value over engagement tricks, no fake urgency or
  misleading price (§163).

## 6. North-star & metrics posture

North Star = **Successful Consumer Intent Fulfillment** (§162): an intent that ends in a valuable result (useful
recommendation, reservation, purchase, successful discovery). Operationally derived from events: a `search` followed
within 30 min by `reserve | purchase | favorite | share` with `degraded=false` (§98, §162,
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §10 → `v_north_star`). Page views are explicitly *not* the target metric.
Business/AI metrics are defined in [GROWTH.md](GROWTH.md) and [MERCHANT.md](MERCHANT.md) (§56, §160, §161).

## 7. Phase-1 boundary (what this vision is *not* yet)

Per §169 and [`DECISIONS.md`](DECISIONS.md) D2/D8, phase 1 does **not** build: global payments, 100 countries, 20M
merchants, pervasive microservices, complex Kubernetes, or heavy ML infra. The single goal is one excellent vertical
slice (§168): `Consumer → AI Search → Merchant → Recommendation → Merchant AI → Action`, run end to end (§170).
Roadmap detail: [ROADMAP.md](ROADMAP.md).

## 8. Definition of this doc set

Docs describe intent + acceptance; contracts describe shapes; the schema describes data. When they disagree, the
contracts (`API_CONTRACT`, `AGENT_CONTRACT`, `DECISIONS`, the migration) win and this file is updated. The §83
architecture diagram is rendered against the phase-1 **modular monolith** in [ARCHITECTURE.md](ARCHITECTURE.md), not
the target microservice picture.

## Open questions / risks
- **Deliverable gap:** spec §85/§166 also name `deployment.md` and `observability.md`; they are *not* in the
  18-file deliverable set, so deployment lives inline in [ARCHITECTURE.md](ARCHITECTURE.md)/[ROADMAP.md](ROADMAP.md) M7
  and observability is distributed across [AI.md](AI.md)/[SECURITY.md](SECURITY.md)/[TESTING.md](TESTING.md). Confirm
  whether a dedicated pair is wanted later.
- **Cold-start supply:** the vertical slice needs real merchant density in one district. Until genuine merchants sign
  up, only clearly-labelled synthetic data exists (§86) — the slice is demonstrable but not commercially real.
- **UCP volatility:** §3/§41/§43 cite evolving Google UCP details (e.g. `CreateCart` dated 2026-04-08). Reserved seams
  may need rework once the real spec is pinned down; keep it behind `UcpAdapter` so blast radius is contained.
- **Model dependency honesty:** with `NEXUS_LLM_PROVIDER=mock` (D4) the "AI" is deterministic heuristics. The vision's
  intelligence claim is only real when a live provider is configured; never market mock output as model quality (§155).
