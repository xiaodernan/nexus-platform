# NEXUS — Consumer Experience (§0, §6, §31–§39, §99, §106, §108)

Status: **to be built.** Owner: `apps/web/(consumer)` (Next.js, mobile-first, SSR/SSG) + `apps/ai` (understand/search/
recommend/compare/chat). This doc focuses on the consumer journey, the render contract, and personalization/privacy
controls; feature-to-module mapping is in [PRODUCT.md](PRODUCT.md). Shapes: [`API_CONTRACT.md`](API_CONTRACT.md) §2/§3/§4/§7;
trust rules: [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4.

## 1. The promise (§0)
"Tell us what you want." No learning keywords, categories, filters, or complex sites — one natural-language box and NEXUS
handles location, time, party size, budget, scene, preferences, taboos, distance, quality, open status, reservability,
and history. Homepage (§6): premium hero, single input "Tell me what you need…" → ✨ AI Search, then rails Popular near
you / For You / Trending / Recommended / Recently viewed.

## 2. Core journey (§138)
```
Landing → Search → AI understanding → Results → Merchant → Compare → Action
```
MVP success test (§141): understand NEXUS in 30s, ask in 60s, valuable recommendation in 2m, meaningful action in 5m.

## 3. AI search UI (§7, §116)
Streaming with **user-legible stages only** — `理解需求… / 搜索附近商户… / 找到 8 个符合条件的选择…` — never chain-of-thought
(§116, [AI.md](AI.md) §4). Result interface (§36): AI summary + cards + comparison + map + actions, grouped Best match /
Best value / Closest / Most popular — **not a wall of text**.

## 4. The render contract — `EntityCard` (§35)
Single render primitive for consumer + AI + MCP surfaces ([`API_CONTRACT.md`](API_CONTRACT.md) §2):
image · title · subtitle · price · rating · distance (+ travel minutes) · open/closed · availability · `ai_match`
(score + reasons[]) · actions · facts[] · flags. Hard rules ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4):
- Every rendered number (price/rating/distance/open/availability) resolves to a `fact_id`; **no fact_id → do not render**.
- `flags.demo` seeded/synthetic rows → UI badge + `X-Demo-Data` header (§109, [D6](DECISIONS.md)). `flags.sponsored` →
  visible label, never mixed with organic (§66, [RECOMMENDATION.md](RECOMMENDATION.md) §4).
- Availability/price are `no-store` (§103); `stale=true` → "价格可能已更新", never silently charge.
- Low confidence: phrase as uncertain `<0.6`, omit + offer handoff `<0.4`; AI must say "不确定" and never pretend to be
  sure (§108).

## 5. Conversation (§34), Comparison (§37), Maps (§38), Local discovery (§39)
Multi-turn narrowing (`太贵了 / 近一点 / 不吃辣`) mutates the persisted Intent ([AI.md](AI.md) §3). "把前三家比较一下" →
`POST /ai/v1/compare` table where every cell carries a `fact_id` (§37, real sources only). Map: user location, markers,
clustering, search-area, directions link, distance, travel-time-when-available (§38). "我附近有什么好玩的？" fans across
restaurant/activity/shopping/experience using location/time/budget/preferences (§39).

## 6. Reservation / Cart / Checkout from the consumer side (§40–§42)
From a card's action the consumer can Reserve (real-time slot, `POST /api/v1/reservations`, confirmation code) or add to
the Universal Cart (product+service+reservation, §41). Checkout uses a payment provider, never stores card data (§42);
idempotent, price re-validated, stale flagged. Empty availability is a valid, designed empty state — the UI must not
fabricate a slot (§155).

## 7. Favorites, history, saved searches (§31)
`/api/v1/me/favorites`, `/me/saved-searches` (stores the resolved Intent + optional `notify`), `/me/orders`,
`/me/reservations`, `/me/conversations`. Favorites drive the network/viral loop ([GROWTH.md](GROWTH.md)).

## 8. Preference memory & personalization controls (§32, §33, §118)
`user_preferences` gives "the more you use it, the better it knows you", but the consumer **owns** it:
- **View** every stored preference; **edit**; **delete** one (`DELETE /me/preferences/{id}`);
- `Forget this preference`, **`Delete memory`** (`POST /me/memory/reset`: every stored preference, whichever `source`
  wrote it), **`Reset personalization`** (`POST /me/personalization/reset`: `source='inferred'` only, §33, §118).
Personalization feeds ranking via `w_personalization` but updates slowly (EMA, min 3 signals, [RECOMMENDATION.md](RECOMMENDATION.md) §6).

## 9. Privacy & data rights (§106)
Consumers can `GET /api/v1/me/export` (streaming JSON of all personal data), `DELETE /api/v1/me` (files a
`deletion_requests` row: kind `account`, status `pending`), `POST /api/v1/me/memory/reset` and `POST /api/v1/me/personalization/reset` (each files its own kind as `completed`, with the counts it removed), and the export records its own taking too: `GET /api/v1/me/export` files kind `export` as `completed` with the disclosure block of the very file it hands back, *after* the sections are read, so a person's file lists every earlier read and never the one that produced it (D334). Data is access-controlled, auditable, encrypted where
appropriate ([SECURITY.md](SECURITY.md)). Precise geo used only with consent; default coarse/district
([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).

## 10. Feedback loop (§99)
Per-result feedback controls — like / dislike / not relevant / too expensive / too far / wrong category — POST
`/ai/v1/feedback` → `feedback_events`; combine with implicit click/dwell + transaction outcome, never treated as sole
ground truth (§100, [RECOMMENDATION.md](RECOMMENDATION.md) §6).

## 11. UI quality bar (§77–§79)
Mobile-first responsive (Desktop/Tablet/Mobile); a single design system (colors/typography/spacing/radius/shadows/
buttons/cards/inputs/dialogs/navigation, §78) in `packages/ui` shared by all three route groups — inconsistent styles
across pages forbidden. Visual direction "Premium AI-native Commerce" (Apple/Linear/Stripe/Airbnb/Arc inspiration, no
copying, §79). Every UI change verified in a real browser with screenshot evidence ([`DECISIONS.md`](DECISIONS.md) D7,
[TESTING.md](TESTING.md)).

## Open questions / risks
- **"Meaningful action" for MVP (§141):** with `demo` payments only, define the accepted action (reserve/favorite vs a
  real paid order) or the success test can't be honestly graded.
- **Anonymous personalization:** guests get no `user_preferences`, so "For You" rails must have a non-empty, honest
  default (trending near coarse location) rather than looking broken (§33, cold start).
- **SSE failure UX (§105):** the client must transparently fall back to deterministic `/ai/v1/search` and label the
  result as non-AI when the stream errors — needs a clear degraded UI state, not a silent downgrade.
- **Consent granularity (§38, §106):** "near me" needs location; how precise (district vs exact) is a product/privacy
  decision that also changes geo query cost.
