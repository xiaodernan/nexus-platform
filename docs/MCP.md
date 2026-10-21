# NEXUS — MCP Server (§3, §44, §45, §96, §97)

Status: **seams reserved in phase 1, server NOT built until Phase 4 (§146).** Owner: `apps/ai/nexus_ai/mcp/`, path `/mcp`
(streamable HTTP + JSON-RPC). **Nothing is live today** — the tools are the *same* registry tools used internally
([AGENTS.md](AGENTS.md) §3), so the seam exists without extra logic.

## 1. Why (§44, §45, §96, §97)
NEXUS must be usable as **commerce infrastructure for external agents** — ChatGPT/Gemini/Claude and others treat NEXUS as
a commerce tool (`External Agent → Nexus MCP/UCP → Commerce Engine → Merchant`, §45). Goal: external AI traffic and
consumer traffic grow together (§97), NEXUS as "an AI-callable commerce database" (§96).

## 2. The Nexus MCP Server (§44)
`/mcp` exposes (initial tool set named in §44):
```
search_nexus · get_merchant · search_products · create_cart · check_availability · create_reservation · get_order_status
```
These map to the internal registry canonical tools ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3) — `search_merchants`/
`search_products`/`search_services`, `get_availability`, `create_cart`, `create_reservation`, `get_order_status` — so the
MCP surface is an **adapter over the same `registry.dispatch`**, never a parallel implementation. Every MCP tool
declaration is a full `ToolSpec` (schema, validation, timeout, retry, logging, authorization, error handling, §11).

## 3. Auth, scoping, tenancy (§44, [`API_CONTRACT.md`](API_CONTRACT.md) §10)
Every MCP call:
1. authenticates an **`external_principals`** row (`protocol='mcp'`, `client_id`, `key_hash`, `name` e.g. "ChatGPT",
   `scopes[]`, optional `merchant_id` = null → platform-wide read, `linked_user_id`) — [DATABASE.md](DATABASE.md) §3.12;
2. checks scopes against `permission_grants` for that subject (per-subject, never per-model, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8);
3. writes `agent_runs` + `audit_logs` with `X-Request-Id` attribution;
4. payload is **untrusted** (§51) — an external agent's text cannot escalate its own permissions or name tools outside the
   registry.
Response uses the same `EntityCard`/`Fact` contract, so an external agent sees facts + demo flags exactly as the consumer
UI does ([CONSUMER.md](CONSUMER.md) §4). Availability/price remain real-time `no-store` (§103). Mutation tools
(`create_cart`, `create_reservation`) require `Idempotency-Key` and, where the core demands it, an explicit end-user
action ([`API_CONTRACT.md`](API_CONTRACT.md) §1).

## 4. Relationship to UCP and to the commerce core
MCP = the agent-facing RPC surface; UCP = the merchant capability/profile discovery surface ([UCP.md](UCP.md)). Both are
thin adapters over `/api/v1/*` + the tool registry; **no business logic is duplicated** in either (§43). External
`get_order_status`/`create_*` ultimately call `services/platform` HTTP with a scoped token, preserving the `nexus_ai`
"no direct commerce-core write" rule ([DATABASE.md](DATABASE.md) §9).

## 5. Sequencing
Phase 1: schema (`agent_profiles`, `external_principals`) + shared tool registry + `EntityCard`/`Intent` JSON Schemas in
`packages/types` (reusable as MCP tool schemas). Phase 4 (§146): stand up `/mcp`, register external principals, publish
the tool manifest, and add tests driving the server as an outside agent would. Until then, do **not** claim MCP support —
state "reserved seam, to be built" ([D4/D7](DECISIONS.md)).

## Open questions / risks
- **Principal→subject→grant model:** mapping an `external_principals` row to `permission_grants` (what can "ChatGPT"
  read/write, and on whose behalf when `linked_user_id` is null) is undefined and is the crux of safe external commerce.
- **Acting-user consent:** MCP `create_reservation`/`create_cart` require "an explicit user action in the same request"
  internally — how that consent is proven through an *external* agent (AP2-style mandate/authorization chain, §3) is open.
- **Tool-name collision:** §44 lists `check_availability` but the registry canonical name is `get_availability` — alias or
  rename must be reconciled in the contract, not silently duplicated.
- **Abuse & cost:** an external agent can hammer `search_nexus`; needs per-principal rate limits + cost accounting
  ([`API_CONTRACT.md`](API_CONTRACT.md) §9, [AI.md](AI.md) §5) before opening the surface.
- **MCP spec churn:** transport ("streamable HTTP + JSON-RPC") and auth are evolving standards — isolate behind
  `apps/ai/nexus_ai/mcp/` so churn doesn't reach the core.
