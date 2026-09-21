# NEXUS — Growth Engine (§59–§66, §92–§98, §110, §162–§164)

Status: **to be built.** Owner: `services/platform/.../growth*` (referrals, coupons, campaigns, collections) +
`apps/ai` (SEO/guide/campaign generators, drafts only) + `apps/web` (shareable pages, SEO SSR). Integrity rule that
overrides every growth tactic: **relevance first, no fake growth, user value over engagement tricks** (§67, §110, §163).

## 1. Built-in growth systems (§59)
referral · share · favorites · collections · invite · merchant referral · creator referral · SEO · local pages · AI-generated
guides. Data: `referrals`, `favorites`, `collections`, `coupons`, `campaigns`, `seo_pages` ([DATABASE.md](DATABASE.md) §3.9–§3.11).

## 2. Viral loops (§60, §61, §62)
```
User → creates recommendation → shares → friend opens → friend becomes user → friend discovers merchant
     → merchant gets value → merchant shares NEXUS → more users            (§60)
```
- **Merchant-ref-merchant (§61):** merchants invite merchants for premium credits → merchant→merchant→merchant density.
- **Consumer referral (§62):** invite friends for credits / discount / premium features — but **not** a scammy
  pyramid/拉人头 design. `referrals.status` only rewards on genuine conversion (`invited→signed_up→first_value→rewarded`),
  so rewards can't be farmed. Endpoints `GET/POST /api/v1/referrals/*` ([`API_CONTRACT.md`](API_CONTRACT.md) §8).
- **No fake traffic (§110):** never bot traffic, fake accounts, or fake engagement to manufacture growth; rewards fire
  only on real conversion events.

## 3. Creator system & AI guides (§63, §64) — future surface
Creators publish Collections / Guides / Recommendations / Itineraries / Lists (e.g. "我的香港情侣约会地图") that carry
followers → NEXUS → merchants. `collections(kind=collection|guide|itinerary)` with ordered `items`, `data_origin`
demo-flag. **AI-generated local guides** ("Best date ideas in Sha Tin", "Best restaurants under HK$300") must be
**grounded in real data** (§64) — same facts/`EntityCard` rules as search, no fabrication.

## 4. SEO & local pages (§29, §64, §92) — consumer acquisition
Programmatic structure (§29): `/hong-kong`, `/hong-kong/restaurants`, `/hong-kong/restaurants/japanese`,
`/hong-kong/restaurants/date-night`, `/hong-kong/restaurants/sha-tin`, `/merchant/{x}`, `/product/{x}`, `/service/{x}`.
Each page: SSR/SSG + metadata + canonical + structured data (JSON-LD) + sitemap + robots + OpenGraph (§29).
**Anti-spam (§30):** every generated page must hold unique, valuable data (`seo_pages.data` = real listings,
`quality_score` gate) — no 100k pages differing only by city name. SEO content is AI-drafted and human-gated
([MERCHANT.md](MERCHANT.md) §6). Social acquisition: shareable recommendations, collections, AI itineraries (§92).

## 5. Network effect & cold start (§93, §94, §95)
```
More consumers → more merchant value → more merchants → more inventory → better recommendations
→ more consumer value → more consumers                                              (§93)
```
**Cold start (§94):** don't cover all of HK — one dense vertical + one dense geography (e.g. restaurants × Sha Tin /
selected Kowloon districts) to reach high merchant density × high consumer usefulness, then expand along §95
(restaurants/cafes → activities/fitness/beauty → shopping/services → travel → cross-city → global). Recommendation quality
is the flywheel fuel ([RECOMMENDATION.md](RECOMMENDATION.md) §6).

## 6. AI discovery & external distribution (§96, §97)
NEXUS must become **an AI-callable commerce database** (§96): external agents search→find→compare→reserve→buy via
Nexus API/MCP. Don't lock all traffic to the NEXUS site; make NEXUS data + transaction capability infrastructure for
other agents, so `consumer traffic + external AI traffic` grow together (§97). Mechanics: [MCP.md](MCP.md), [UCP.md](UCP.md).

## 7. Monetization & integrity (§65, §66, §67, §164)
- **Merchant plans (§65):** Free / Pro / Enterprise; chargeable: AI conversations, leads, analytics, marketing automation,
  CRM, API, advanced AI (`merchants.plan`, `subscriptions`).
- **Marketplace revenue (§66), future:** transaction fee, reservation fee, subscription, promoted listing, lead-gen, API,
  enterprise.
- **Ranking integrity (§66–§67):** recommendation must **not** deceive users because they paid. Sponsored is labelled
  (`flags.sponsored`), separated from organic, capped (1 in top 5), never displacing the organic best match, and the
  organic score is never a function of spend ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6). Philosophy: help merchants
  genuinely acquire customers, not just sell ads (§164).

## 8. Metrics (§161, §162)
- Consumer: DAU/WAU/MAU, retention, searches, actions, conversion. Merchant: active merchants, merchant retention, AI
  conversations, leads, reservations, GMV. AI: task success, hallucination, latency, cost ([AI.md](AI.md) §6).
- **North Star (§162):** Successful Consumer Intent Fulfillment — `search` → useful recommendation / reservation /
  purchase / successful discovery. Derived in `v_north_star`: a `search` followed within 30 min by
  `reserve|purchase|favorite|share` with `degraded=false` ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §10). Page views are
  **not** the target (§162).

## Open questions / risks
- **Attribution integrity:** referral credit must be tied to a *genuine* first-value event, not just a signup — the exact
  qualifying signal (§61/§62) and fraud rules are undefined.
- **Promoted-listing demand vs. integrity (§66/§67):** revenue pressure to loosen the sponsored cap is the predictable
  conflict; the cap must be a server-side invariant, not a tunable the growth team can flip.
- **Creator supply:** creators need merchants to already exist; before real merchants sign up, guides/collections are
  synthetic and must be visibly demo, not seeded as "top creators" on fake data (§86, §109).
- **Programmatic SEO quality bar is subjective:** `quality_score` needs a concrete, tested threshold or spam pages will
  slip through (§30).
