# @nexus/sdk

Zero-dependency, `fetch`-based TypeScript client for **NEXUS** — the platform
(`/api/v1/**`) and AI (`/ai/v1/**`) HTTP surfaces. Runs on **Node 18+** and modern
**browsers**, ships **ESM + `.d.ts`**.

It is how merchants and external agents call NEXUS. It carries *your* credential
and never elevates it: every permission is enforced server-side, state-changing
actions require an explicit call, and nothing in here fabricates a result
(see [`docs/DECISIONS.md`](../../docs/DECISIONS.md) D6). All wire shapes are
snake_case per [`docs/API_CONTRACT.md`](../../docs/API_CONTRACT.md) §1.

```ts
import { createClient } from "@nexus/sdk";

const client = createClient({
  baseUrl: "https://api.example.hk",
  // auth: bearer JWT, an API key, or a session cookie (credentials: "include")
  token: process.env.NEXUS_TOKEN,      // → Authorization: Bearer <token>
  apiKey: undefined,                   // → X-API-Key
  tenant: "hong-kong",                 // → X-Tenant (contract §1)
  locale: "zh-HK",                     // → Accept-Language
  timeoutMs: 10_000,
  retries: 2,
  // fetch, idempotencyStore — injectable for tests / custom transports
});
```

### What the client does automatically

| Behavior | Detail |
|---|---|
| Auth injection | `Authorization: Bearer` (auto-adopted after `auth.login`/`refresh`), `X-API-Key`, session cookie via `credentials: "include"`. |
| `X-Request-Id` | Generated once per logical request (survives retries), or honored if you pass one. Echoed onto `NexusApiError.requestId`. |
| Tenant / locale | `X-Tenant`, `Accept-Language` on every request. |
| Idempotency | `Idempotency-Key` on checkout / payment / reservation / review / campaign-publish (auto-generated if you don't pass one) + a replay cache. |
| Retries | Exponential backoff + full jitter **only** for safe/idempotent requests; honors `Retry-After` on `429`; captures rate-limit headers. |
| Timeout | Per-request `AbortSignal` that **composes** with your own signal. |
| Errors | The contract error envelope → typed `NexusApiError` (`code`, `status`, `details`, `requestId`, `retryAfterMs`, `rateLimit`). |
| Pagination | Cursor lists are awaitable *and* async-iterable via `.paginate()` / `.all()`. |
| Events | `client.events` batches `POST /api/v1/events`, de-duped by `event_id`. |
| AI stream | `ai.searchStream()` yields typed SSE events and **degrades** to deterministic search on failure (never a fake success). |

Namespaced resources: `auth`, `me`, `merchants`, `merchant` (workspace),
`discovery`, `carts`, `orders`, `reservations`, `payments`, `reviews`,
`conversations`, `events`, `collections`, `admin`, `ai`.

---

## Cursor pagination

```ts
// Await a single page:
const { items, next_cursor } = await client.merchants.list({ open_now: true, limit: 20 });

// Or stream every merchant across pages:
for await (const m of client.merchants.list({ district: "Tsim Sha Tsui" }).paginate()) {
  console.log(m.id, m.name);
}
```

---

## Example 1 — Merchant onboarding: AI import flow (§5.1)

`POST /imports` is asynchronous and **nothing publishes without merchant review**.
Poll the job, inspect the proposals and their evidence `fact_ids`, then create
offerings explicitly.

```ts
import { NexusApiError } from "@nexus/sdk";

async function importMenu(client: ReturnType<typeof createClient>, merchantId: string, url: string) {
  // 202 { job_id, status: "queued" }
  const job = await client.merchant.imports.create({
    merchant_id: merchantId,
    source: { type: "url", value: url },
    // files: [{ name: "menu.pdf", content_base64: "<...>" }],
  });

  // Poll to a terminal state (running → done|failed|partial). Never hangs.
  const finished = await client.merchant.imports.wait(job.job_id, { pollMs: 1500, timeoutMs: 60_000 });
  if (finished.status !== "done") throw new Error(`import ${finished.status}: ${finished.error ?? "n/a"}`);

  // A human merchant reviews every draft. Confidence is the model's, not a green light.
  for (const p of finished.proposals ?? []) {
    console.log(p.offering_draft.name, "confidence", p.confidence, "evidence", p.evidence_fact_ids);
    if (p.confidence < 0.6) continue; // surface as uncertain / omit (AGENT_CONTRACT §4)
    await client.merchant.offerings.create({ merchant_id: merchantId, ...p.offering_draft });
  }
  // Publishing the listing is a separate, explicit human action:
  // await client.merchant.businesses.publish(merchantId);
}
```

---

## Example 2 — Availability query → reservation

Availability is **real-time, never cached** (§20). The SDK never fabricates a
held slot: an empty list is a valid, honest result. Reservation create requires an
`Idempotency-Key` (auto-supplied; pass your own to control retries).

```ts
const slots = await client.merchants.availability("lung-yuen-kitchen", {
  starts_at: "2026-09-26T11:00:00Z",
  ends_at: "2026-09-26T14:00:00Z",
  party_size: 2,
});

const slot = slots.slots.find((s) => s.status === "available");
if (!slot) {
  console.log("No tables in that window — pick another time."); // honest empty state
} else {
  const idemKey = "res-" + crypto.randomUUID();
  const res = await client.reservations.create(
    { merchant_id: "m1", slot_id: slot.slot_id!, party_size: 2, contact: { phone: "+852 1234 5678" } },
    idemKey,
  );
  console.log("Reserved:", res.status, "code", res.code);
}
```

---

## Example 3 — Cart → checkout with idempotency replay

Price-check first and honor `stale` flags (§20/§103 — never silently charge a
stale price). Pass a **stable** `Idempotency-Key` across retries so a crash +
retry can never double-charge: the SDK replays the first result from cache, and
the server also dedupes by the key.

```ts
const cart = await client.carts.create();
await client.carts.addItem({ offering_id: "off_1", quantity: 2 });

// Surface staleness before checkout.
const check = await client.carts.priceCheck();
if (check.items.some((i) => i.stale)) throw new Error("价格可能已更新 — re-confirm before paying");

const idemKey = "checkout-" + cart.id;      // STABLE: reuse this exact key on any retry
const { order } = await client.carts.checkout({ cart_id: cart.id }, idemKey);

// A retry after a network blip is safe — it returns the same order, creates no second one:
const again = await client.carts.checkout({ cart_id: cart.id }, idemKey); // replayed, no new order
console.log(order.id === again.order.id ? "idempotent replay ✔" : "BUG");
```

---

## Example 4 — Consuming an AI search stream

`ai.searchStream()` yields typed events: `status | intent | results | summary |
done | error | degraded`. Status text is user-legible, never chain-of-thought
(§116). If the stream breaks, the SDK falls back to the deterministic
`POST /ai/v1/search` and emits `degraded` — it never pretends the AI answered.

```ts
try {
  for await (const ev of client.ai.searchStream({ query: "適合情侶約會的安靜餐廳", limit: 8 })) {
    switch (ev.type) {
      case "status":  renderSpinner(ev.text); break;                 // 理解需求… / 搜索附近商户…
      case "intent":  showUnderstanding(ev.data); break;
      case "results": showCards(ev.items); break;                    // each card carries flags + facts
      case "summary": showSummary(ev.text, ev.citations); break;
      case "done":    telemetry(ev.latency_ms, ev.cost_usd, ev.degraded); break;
      case "degraded":
        // We could NOT get a real AI answer. Show deterministic results + say so.
        banner("AI 暫時無法回應，以下為精準搜尋結果");
        showCards(ev.result?.items ?? []);
        break;
      case "error":   banner(`AI search unavailable: ${ev.message ?? ev.code}`); break;
    }
  }
} catch (err) {
  // Thrown only if BOTH the stream AND the deterministic fallback failed.
  if (err instanceof NexusApiError && err.code === "ai_unavailable") fallbackToSearchPage();
}
```

---

## Tracking events

`client.events.track()` buffers, de-dupes by `event_id`, and flushes in batches
(`POST /api/v1/events`) on a size or age trigger, retrying safely so a crash
cannot lose or double-count an event.

```ts
const tracker = client.events.createTracker({ maxBufferSize: 20, flushIntervalMs: 5000 });
tracker.track({ name: "search", subject_type: "search_result", properties: { q: "ramen" } });
tracker.track({ name: "click", subject_type: "merchant", subject_id: "m1" });
window.addEventListener("beforeunload", () => void tracker.flush());
await tracker.close(); // flush on shutdown
```

---

## Demo environment & degraded responses — read this before shipping

NEXUS ships with **clearly-labelled synthetic (demo) data** (§109/§155, DECISIONS D6).
Do not mistake it for production truth:

- **`flags.demo`** — every EntityCard/merchant from the seeded dataset has
  `flags.demo === true`. Synthetic merchants use invented names and `example.*`
  domains. **Surface it as a visible badge.** If you render a `flags.demo` entity
  without the badge, you are misrepresenting demo data as real inventory.

  ```ts
  card.flags?.demo && renderBadge("DEMO");
  ```

- **Payment is demo-only** in phase 1 (DECISIONS D5). `payments.confirm` talks to
  a demo provider. No card data is ever handled by this SDK.

- **`X-Nexus-Degraded`** — a response header the AI service sets when it answered
  from a **degraded** path (LLM down → fallback model → deterministic search,
  per §105). The SDK reflects this two ways:
  - the `done` event's `degraded: true`, and
  - a synthetic **`degraded`** event with `via: "server"` (flagged response) or
    `via: "deterministic_search"` (the client fell back after a stream failure,
    carrying `result` = the deterministic items).

  **A `degraded` event means: this is not a full AI answer.** Present the
  deterministic results honestly — do not relabel them as AI-generated, and do
  not treat `degraded` data as the north-star "fulfilled intent" (§10/§162).

- **`flags.sponsored`** is always separate from organic ranking (§66/§67). Sponsored
  cards are inserted after organic scoring and capped; never re-rank organic results
  by spend.

---

## Install / build / test

```bash
npm install
npm run build     # tsc → dist/ (ESM + .d.ts)
npm test          # compiles + runs node:test against an in-process fake API
```

Zero runtime dependencies; `typescript` and `@types/node` are dev-only.

## Errors

```ts
import { isNexusApiError } from "@nexus/sdk";
try { await client.merchants.get("nope"); }
catch (e) { if (isNexusApiError(e)) console.error(e.code, e.status, e.requestId); }
```

Codes (contract §1): `validation_error(422) unauthorized(401) forbidden(403)
not_found(404) conflict(409) rate_limited(429) ai_unavailable(503) internal(500)`,
plus client-side `network_error / timeout / aborted`.
