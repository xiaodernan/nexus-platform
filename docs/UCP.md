# NEXUS — UCP (Universal Commerce Protocol) compatibility (§3, §41, §43, §45)

Status: **seams reserved in phase 1, integration NOT built until Phase 4 (§146).** The §3/§41/§43 UCP details are evolving
external facts cited by the spec; treat specifics as provisional until pinned to the real published spec. Owner:
`apps/ai/app/ucp/` adapter serving `GET /.well-known/ucp`. **Nothing here is live today.**

## 1. Why (§3)
Google's Universal Commerce Protocol provides AI-Mode/Gemini-facing commerce integration: merchant profile, product
discovery, cart, checkout, order management, identity linking, payment handlers. Merchants publish a capability profile
at `.well-known/ucp` declaring **version, capabilities[], endpoints[], payment_handlers[]**. NEXUS must retain UCP /
Agentic-Commerce (MCP, AP2, A2A) reachability **from the architecture level** and "不要把架构写死" (§3).

## 2. Architectural rule (§43)
- All UCP logic lives in a **`UcpAdapter`** — business code must never build UCP JSON.
- `GET /api/v1/merchants/{slug}/.well-known/ucp` returns a profile assembled **only** from the `agent_profiles` table
  (`protocol='ucp'`: `version, capabilities[], endpoints[], payment_handlers[], status`) via the adapter
  ([DATABASE.md](DATABASE.md) §3.12, [`API_CONTRACT.md`](API_CONTRACT.md) §10). Draft/published/revoked status gates serving.
- The adapter maps NEXUS's own commerce primitives onto UCP concepts, reusing the shared objects so there is one truth:
  UCP "product discovery" ← `EntityCard`/`search` ([SEARCH.md](SEARCH.md)); UCP "cart/`CreateCart`" ← Universal Cart
  (`carts`/`cart_items`, §41); UCP "identity linking" ← `external_principals.linked_user_id`
  ([MCP.md](MCP.md) §4); UCP "payment handlers" ← `PaymentProvider` seam (D5, §42).

## 3. Cart-forwarding requirement (§41)
Spec cites UCP `CreateCart` (dated 2026-04-08) letting an AI surface move a cart into the merchant site. Therefore the
**Nexus Cart must be designed extensibly** (§41) — `cart_items` already carry `options jsonb` + `kind`
(product/service/experience/reservation), which is what a UCP cart hand-off must reproduce. The cart schema must not bake
in single-merchant assumptions that block a forwarded multi-line cart (see [PRODUCT.md](PRODUCT.md) open question).

## 4. Capability profile shape (illustrative — to be validated against the real spec)
```jsonc
{ "version": "…",                       // mirrors agent_profiles.version
  "capabilities": ["discovery","cart","checkout","order_status"],
  "endpoints": [ {"capability":"cart", "url":"https://…/ucp/cart"} ],
  "payment_handlers": [ {"provider":"…","ref":"client_secret_ref"} ] }   // never raw card data (§42)
```
Endpoint URLs resolve to existing `/api/v1/*` surfaces through the adapter; no new business logic is written for UCP — it
is a translation layer over the commerce core.

## 5. Sequencing
Phase 1: `agent_profiles` schema + adapter *seam* only. Phase 4 (§146): publish real profiles, external-agent integration,
tests against a UCP-shaped consumer. Until then **never claim UCP is supported** — say "reserved seam, to be built"
([D4/D7 honesty](DECISIONS.md)).

## Open questions / risks
- **Spec drift:** §3/§41 quote UCP details (versions, `CreateCart` date) that are outside our control and change; the
  adapter is the containment boundary so only it breaks, not the core.
- **Profile discovery path:** [`API_CONTRACT.md`](API_CONTRACT.md) §10 puts it under `GET /api/v1/merchants/{slug}/.well-known/
  ucp`, while §43 implies the standard `<host>/.well-known/ucp` origin path — reconcile (per-merchant vs per-origin) in
  the contract before building.
- **Payment-handler mapping:** UCP's payment model vs NEXUS's `demo`/`PaymentProvider` abstraction is unmapped; real
  providers are Phase 2+ (§144), so the mapping is untestable now.
- **Identity linking vs tenancy:** how a UCP-linked external identity gets a `permission_grants` subject (read? cart-scope?
  checkout?) is undecided ([AGENTS.md](AGENTS.md) risks).
