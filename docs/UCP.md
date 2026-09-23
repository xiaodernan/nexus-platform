# NEXUS — UCP (Universal Commerce Protocol) compatibility (§3, §41, §43, §45)

Status: **seams reserved in phase 1, integration NOT built until Phase 4 (§146).** The §3/§41/§43 UCP details are evolving
external facts cited by the spec; treat specifics as provisional until pinned to the real published spec. The two
read-only endpoints are the platform's (`UcpController`, per [`API_CONTRACT.md`](API_CONTRACT.md) §1, which states the AI
service never serves them); the hand-off that would consume a profile is not built, and no publisher for
`agent_profiles` exists yet (D52). "Nothing here is live today" was true of the *adapter* plan, not of the
endpoints: an agent fetching the origin profile today gets an answer that says `not_integrated`.

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
- **What is true today (D52, walked over HTTP rather than mocked):** the platform implements the per-merchant door at
  `GET /api/v1/merchants/{slug}/ucp.json` — not the `.well-known/ucp` spelling on the bullet above, which is this
  document's own (§1 and §10 of the contract both use `ucp.json`) — plus the origin profile at
  `GET /.well-known/ucp`. The origin profile declares `status: not_integrated`,
  empty `capabilities` and empty `payment_handlers`, and points at the per-merchant path it actually serves; the
  per-merchant door answers `404 ucp_profile_not_published` with the row an agent would need. **No publisher
  exists:** no migration, seed file, service or endpoint inserts into `agent_profiles`, so the 200 branch is
  reachable only from the stubs in `UcpProfileServiceTest`. That is what "reserved seam, Phase 4 hand-off" means
  in behaviour, and `UcpDoorsTest` now asserts the emptiness so the first publisher has to notice it.
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
- **Profile discovery path:** still unreconciled, and no longer hypothetical — the platform built
  `/api/v1/merchants/{slug}/ucp.json` (§1 and §10 of the contract, and the code), while §2 above spells it
  `/api/v1/merchants/{slug}/.well-known/ucp`. An agent following **this document** would fetch a path nothing
  serves; the origin profile's own `merchant_profiles` pointer is the authoritative answer today, and a client
  that follows it lands correctly. Decide which spelling is the contract, then change the other one (D52 records
  both, and `UcpDoorsTest` binds the printed pointer to the route that exists).
- **Payment-handler mapping:** UCP's payment model vs NEXUS's `demo`/`PaymentProvider` abstraction is unmapped; real
  providers are Phase 2+ (§144), so the mapping is untestable now.
- **Identity linking vs tenancy:** how a UCP-linked external identity gets a `permission_grants` subject (read? cart-scope?
  checkout?) is undecided ([AGENTS.md](AGENTS.md) risks).
