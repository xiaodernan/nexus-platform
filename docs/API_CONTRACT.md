# NEXUS API Contract (v1) — AUTHORITATIVE

> Every service and frontend module codes against this file. Changing a shape here means updating
> `packages/types` and re-running contract tests. Nothing else is a source of truth for HTTP shapes.

## 0. Topology & ownership

| Surface | Process | Port | Owns |
|---|---|---|---|
| `/api/v1/**` | Spring Boot platform service (`services/platform`) | 8080 | Auth, RBAC, merchants, offerings, orders, carts, reservations, payments, reviews, conversations, events, growth, admin |
| `/ai/v1/**` | FastAPI AI service (`apps/ai`) | 8000 | Query understanding, hybrid search, RAG, agent orchestration, recommendations, comparison, eval, observability |
| `/mcp` | FastAPI AI service adapters | 8000 | External-agent tool surface (§44-45) |
| `/.well-known/ucp` | Spring Boot platform (`UcpController`) | 8080 | UCP origin profile; per-merchant profiles are `/api/v1/merchants/{slug}/ucp.json` (D14). The web edge proxies this host-root path to the platform; it is never served by the AI service, because profiles are projected from `agent_profiles`, which the platform owns. |
| `/**` | Next.js (`apps/web`) | 3000 | SSR/SSG pages, BFF proxy at `/api/*`, streaming UI |

Data access rules (no `LLM → database` path, §52):
- Platform service: `nexus_app` DB role, read-write on every commerce table. It is not the *owner* of them and it
  holds no `CREATE` on the schema: the infra superuser creates objects, dev Flyway migrates as that superuser, and
  DML on tables a later migration adds reaches the runtime role through `ALTER DEFAULT PRIVILEGES`
  ([`DECISIONS.md`](DECISIONS.md) D30/D32).
- AI service: `nexus_ai` DB role, and the grant set is **exactly** the list below (enforced in
  `infra/postgres/init/00_roles.sql`, verified against the live DB — 23 tables, nothing wider):
  - **SELECT only**: merchants, offerings, locations, reviews, business_hours, availability_slots,
    tenants, user_preferences, external_principals, categories, merchant_categories
    (the last two are the taxonomy a categorised search has to resolve: an intent bucket such as
    `escape_room` names a coarse node while merchants are tagged with leaves, so the read path
    joins `merchant_categories`/`categories` instead of matching the denormalised
    `merchants.category_primary` label)
  - **read-write**: documents, chunks, facts, recommendation_sets, feedback_events, agent_runs,
    llm_calls, eval_suites/eval_cases/eval_runs, review_summaries, seo_pages, campaigns, coupons
    (`coupons` is the marketing agent's draft workspace — §27 keeps publish behind a human)
  - **INSERT only** (append-only, D19): events — note this is measured behaviour, not theory: with
    INSERT but no SELECT, `INSERT ... RETURNING` is rejected, so the event writer must not use RETURNING.
  - Everything else — users, carts, orders, payments, reservations, **conversations, messages,
    handoffs** — is unreachable for `nexus_ai` by design. Mutations there go through platform HTTP APIs
    with a scoped token (§0, D20). Web never talks to Postgres; it calls platform + AI through the BFF.

## 1. Global conventions

- JSON only; **snake_case** keys; ISO-8601 UTC timestamps; `money` as string decimal + `currency` code.
- Auth: `Authorization: Bearer <jwt>` **or** `nexus_session` HttpOnly cookie. `X-CSRF-Token` required for state-changing cookie requests.
- Tenant: `X-Tenant: hong-kong` (else derived from hostname). Every query is tenant-scoped server-side.
- Request id: `X-Request-Id` echoed and attached to logs, `agent_runs`, `audit_logs`.
- Idempotency: `Idempotency-Key` is **required** on the five writes that store their own answer for replay —
  `review`, `events`, `member`, `api_key`, `moderation_resolve`. Each is declared twice inside the same handler,
  and both halves are load-bearing (D45): `@Idempotent(scope = …)` is what makes the interceptor demand the
  header, `IdempotencyService.run(scope, …)` in the body is what makes that header decide whether the work
  executes. A route with the second half and not the first does not merely lose an optimisation — the claim row
  is keyed by scope and header together, so every caller that sent no header lands on the same row, the same
  account is handed back somebody else's stored answer, and a different account is refused until the TTL ends.
  `IdempotencyPairingTest` reads the handlers and refuses that pairing; `IdempotencyService.run` refuses a blank
  key rather than deriving one. Writes outside that list keep their replay protection elsewhere: a retried
  **reservation create** is settled by `reservations_slot_user_uniq` (V2 — one live hold per person per slot) and
  answers with the same code, at 200 rather than 201 and with a `status_note` that says so, so it demands no
  header; §8's **collection draft create** does the same, settled by `collections_tenant_id_slug_key`
  (V1's `UNIQUE (tenant_id, slug)`) and answers a retried slug with `409 slug_taken` naming the row it hit,
  so it too demands no header; **checkout**, **payment** and
  **campaign publish** are documented here while no route in this build serves them, so nothing declares them.
  The replay lasts a window, not forever: the claim row carries `expires_at = now() + nexus.idempotency.ttl-seconds`
  (86400 by default) and `run` compares that column with `now()` whenever its insert loses to a row that is
  already there. An expired claim answers nobody — it is dropped and re-claimed by whichever caller notices —
  so a retried key outside its window runs the work again, and what stops that second run from duplicating
  anything is the resource's own integrity rules, not this table. That read is also the only recovery from an
  `in_progress` claim a killed process left behind: before D46 nothing compared the deadline, so such a key
  answered `request_in_progress` on every later attempt without end.
- Rate limits: `429` + `Retry-After` + `X-RateLimit-Remaining` (+ `X-RateLimit-Limit`), over three fixed windows —
  `auth-ip` on `/api/v1/auth/**` (default 10 per address per 300s), `ai` per principal (20 per 60s) on
  `/api/v1/merchant/ai-agent` — the only AI-ish door this service serves; the scope also matched
  `/api/v1/ai/**`, a prefix §7 states outright this service never serves, and D49 deleted the line and gated the
  shape — and `write` per principal on every mutating request outside auth (60 per 60s). A request matching two
  scopes is charged to both: a `POST` to the AI-agent door spends the `ai` window and the `write` window
  together. The `dev` profile starts these at 100/300/100 so a manual curl session is not throttled, and each
  stays reachable through the same `NEXUS_RL_*` names (D48). A refused request is answered by the filter, so
  the route never runs: no handler, no audit row,
  no idempotency claim — and `error.details.retry_after` carries the same number as the header.
  **The address is the socket peer, never a header** (D47). `Req.clientIp` used to return the first
  `X-Forwarded-For` entry whenever one was sent, and `server.forward-headers-strategy: framework` made the
  container do the same to `getRemoteAddr()` underneath it — so the login brute-force budget refilled for
  whoever typed a new address, and that typed string was what `audit_logs.ip` recorded. A deployment behind a
  proxy declares the proxy instead (`server.forward-headers-strategy` + `server.tomcat.remoteip.internal-proxies`)
  and the container then rewrites the address once, for every reader. `RateLimitEnforcementTest` switches the
  limiter on to produce the first `429` this repository ever observed; `ForwardedHeaderTrustTest` keeps the
  pre-D47 configuration running as a reproduction and refuses a trust-anyone default in the shipped config
  files; `DeclaredProxyTest` is what a declared proxy still buys; `RateLimitScopeRoutesTest` asks the running
  router whether every path prefix the filter matches on is served at all (D49). `nexus.ratelimit.enabled=false`
  (which the test harness sets) skips the check entirely — that switch, not a missing route, is why the `429`
  went unseen; the `ai` scope was missing in the other direction, a prefix behind which this service serves
  nothing, and that is D49's.
- Pagination: cursor-based — request `?limit=20&cursor=...`; response `{ "items": [...], "next_cursor": "...", "total_estimate": 123 }`.
- Error envelope (always):
```json
{ "error": { "code": "merchant_not_found", "message": "...", "details": {}, "request_id": "..." } }
```
  Ladder codes: `validation_error(422) unauthorized(401) forbidden(403) not_found(404) conflict(409) rate_limited(429) ai_unavailable(503) internal(500)`.
  A ladder code may be **specialised by the resource that failed** (D27): `merchant_not_found`, `slot_not_found`,
  `idempotency_key_conflict`. The suffix is normative and fixes the status, so a client that has never heard of the
  resource still resolves the right rung (§4 uses this vocabulary, and `/api/v1/merchants/{slug}` answers with it).
  Only `not_found`, `conflict` and `forbidden` take a prefix — the other five carry their meaning in `details`
  (`Retry-After`, the ladder rung, the field map), and a prefix there would hide which `error_envelope.json` branch
  applies. `details.resource` is required for a bare `not_found` only, because that is the code that names no subject.
- Failure ladder (§105): LLM error → fallback model → deterministic search endpoint → human handoff. `ai_unavailable` must
  never break `/ai/v1/search` (pure deterministic path).

## 0.1 Web BFF surface (`/api/nexus/**`, Next.js only — never a service contract)

The browser talks to the Next server, not to :8080/:8000. These paths exist so the client can stay
same-origin (cookies, CORS, streaming) and **forward** to the routes above; they add no new semantics,
and any response shape they return is the upstream shape verbatim. `scripts/check_contract_drift.mjs`
treats a path in this table as documented.

| Method | BFF path | Forwards to | Why the hop exists |
|---|---|---|---|
| POST | `/api/nexus/ai/search` | `POST /ai/v1/search` | keeps the AI service server-side (internal token never reaches the browser) |
| POST | `/api/nexus/ai/stream` | `POST /ai/v1/search/stream` | SSE pass-through; §7 / D13 framing is unchanged by the proxy |
| POST | `/api/nexus/ai/compare` | `POST /ai/v1/compare` | same as search: server-side credentials, §105 degrade handled in the browser |
| GET/POST | `/api/nexus/platform/**` | `/api/v1/**` on the platform | generic proxy (e.g. `/api/nexus/platform/me/favorites` → `GET /api/v1/me/favorites`) |

`/api/nexus/ucp/**` additionally proxies the host-root `/.well-known/ucp` profile for the same
same-origin reason (§10). No BFF path may compute, filter, enrich or invent anything: presentation
belongs to the pages, truth belongs to the two services.


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
  "source": "merchant",          // merchant|imported|observed|third_party|inferred|demo
  "confidence": 0.98,
  "observed_at": "2026-09-22T02:00:00Z",
  "expires_at": "2026-09-22T08:00:00Z",
  "stale": false
}

// Opening state (computed, never guessed). `source_fact_id` names the merchant's hours fact —
// stored as `facts.attribute = 'opening_hours'`, which the render contract spells
// `business_hours`; the two resolve to each other (D25), and an unresolved name is why the
// badge renders 未验证.
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
  "flags": { "sponsored": false, "demo": true, "unverified": false }   // + "estimated_price" on offerings, "verified_visit" on reviews
}
```

`flags.demo` is `true` for all seeded/synthetic data and must be surfaced in the UI (§109, §155).
The three above are the card-wide set; two projections add one flag of their own:
`estimated_price` on offering cards (`offerings.price_source = 'estimated'`) and `verified_visit` on
review cards (the reviewer transacted). Consumers may ignore flags they do not render; a new flag name
belongs here, not in a private type.

## 3. Auth & account

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/register` | `{email,password,display_name,locale,accept_terms}` → `{user,access_token,refresh_token}`; password Argon2id. `409 email_taken` means taken **in this tenant** (D29): the same address is a separate account in another tenant, and a 409 must never be readable as "someone else owns this address globally". |
| POST | `/api/v1/auth/login` | `{email,password}` → same shape. The lookup is tenant-scoped, so an address registered in two tenants is not ambiguous here; which tenant you reach is decided by the `X-Tenant`/host header, not by the credentials. |
| POST | `/api/v1/auth/oauth/{provider}` | `{id_token}` verified against provider JWKS (google/apple) |
| POST | `/api/v1/auth/refresh` | `{refresh_token}` → new pair (rotation, reuse detection) |
| POST | `/api/v1/auth/logout` | Ends the **session family**, not the credential. Both cookies come back cleared (`nexus_session`, `nexus_csrf` — empty values, `Max-Age=0` and an epoch `Expires`, named in the body's `cleared` list), `TokenRegistry.revoke(sid)` removes the jti the refresh token is exchanged against so the next `/auth/refresh` answers 401 `refresh_reuse_detected` (an unknown family is refused, never adopted — fail-closed by design, so a store flush ends families rather than silently extending them), and the caller's `logout` audit row is written. **The access token keeps working until its own `exp`** — 900s by default — because no request path consults revocation state for a JWT (`AuthFilter` checks signature, expiry and the API-key case). Nothing in this build closes that window on purpose: a denylist would live in Redis when it is reachable and in one JVM's memory when it is not, which reads as security and behaves as luck; short expiry is the mechanism. An anonymous call is accepted and audits nothing, since there is no subject to attribute. |
| POST | `/api/v1/auth/session` | the caller's own **resolved** principal: `{subject_type, user_id, tenant_id, role, session_id, auth_method}`, read straight off the credentials that authenticated this request. The login response is a claim about who you were a moment ago; this is what the RBAC chain acts on now, which is the only difference that matters when a session was issued before a role changed. Read-only: it changes nothing, so it needs no `Idempotency-Key` and writes no audit row. |
| GET | `/api/v1/me` | profile + memberships + preferences summary. `memberships[].permissions` names the access (D42): that member's live `permission_grants` rows for that merchant, read through the same reader `GET /api/v1/merchant/members` uses, so the two doors cannot print a different access for one person. A grant that has lapsed (`expires_at` in the past) or been revoked appears in neither, while the membership row itself stays and reports `status`. |
| PATCH | `/api/v1/me` | profile |
| DELETE | `/api/v1/me` | creates `deletion_request` (§106) |
| GET | `/api/v1/me/export` | streaming JSON of all personal data |
| GET/POST | `/api/v1/me/preferences` | preference memory (§32-33): the list, and an appended entry. |
| PATCH/DELETE | `/api/v1/me/preferences/{id}` | one entry, by id. There is no "erase all" route on purpose: a bulk wipe would be indistinguishable, to the person who just lost their quiet-venue memory, from a bug. |
| POST | `/api/v1/notifications/read-all` | marks the caller's whole inbox read; returns `{marked_read}` — the count it reports is rows this call actually changed |
| GET/PUT | `/api/v1/notifications/preferences` | the §123-125 channel switches. The read answers `in_app`, `email`, `push` with the tenant default where nothing was ever stored, and names what the caller may change in `editable_channels`; the write takes one or more of exactly those booleans and 422s an unknown channel or a non-boolean rather than ignoring it, because a silently dropped preference is a notification that never arrives. |
| POST | `/api/v1/me/personalization/reset` | wipes inferred memory |
| GET | `/api/v1/me/favorites` · POST `/api/v1/me/favorites` · DELETE `/api/v1/me/favorites/{type}/{id}` | The saved-item door, walked for the first time in D50 — until then no test had touched it and the row said nothing. `POST` takes `{subject_type, subject_id, note}` and answers **200** with the saved row (`status: saved`); the two create doors nearby answer 201, this one never declared a status, and §45 reports the inconsistency rather than changing a code under a client. Saving the same subject again refreshes `note` on the same row — the unique index is `(user_id, subject_type, subject_id)` and the insert turns the conflict into an update — and every accepted save writes a `favorite` audit row. The subject must be the caller's to *read*: a merchant or offering from another tenant 404s, and so does any collection or guide that §8's listing filter would hide (no `published_at`, or neither an author nor a provenance token), all with the same `subject_not_found` and the same message, because D5 forbids a 404 that leaks existence. `guide` and `collection` are one table pinned by `kind`, so an id cannot be saved under a label the directory would not file it under; any other `subject_type` answers 422 from the request pattern before the validator runs. `GET` is the caller's own list, newest first; `DELETE` removes by type and subject id and, since D51, answers
`404 favorite_not_found` when no row of the caller's matched — the same message as for an id that never existed,
so the door cannot be used to ask whose favourites do. |
| GET/POST/DELETE | `/api/v1/me/saved-searches[/{id}]` | The saved-search door, walked for the first time in D51 (no test named it, and the §7 row was empty). `POST` takes `{name?, query, intent?, notify}` and answers 200 with `{id, status: "saved"}`; `query` is required and non-blank (`@NotBlank` → 422, and a refused save stores nothing), `name` caps at 120, `intent` is stored and returned as a jsonb object (an omitted one is `{}`, not null), and `notify` is the caller's own boolean — an omitted one reads back `false`, and no notification is promised by this row. `GET` is the caller's own list, newest first, per account. `DELETE /{id}` answers 200 only when a row actually went away: an id the caller never saved, or someone else's, gets `404 saved_search_not_found` with the same message either way, because the old handler threw the row count away and said `removed` regardless (§46). |
| GET | `/api/v1/me/orders` · `/me/reservations` · `/me/conversations` | |
| GET | `/api/v1/notifications` · POST `/api/v1/notifications/{id}/read` | in-app inbox for the acting subject (§123-125); merchant notifications are read through the same route with the merchant membership |
| GET | `/api/v1/users/{id}` | **admin/ops only** — consumer support tooling (§68). Merchant staff must never reach this; merchant-side customer data goes through `/api/v1/merchant/customers` and is RBAC-scoped (§46, §47). The `/api/v1/me/*` routes are the self-service surface and stay separate on purpose. |

JWT claims: `sub, tid (tenant), typ(access|refresh), sid, jti, iat, exp`, plus `role` (the *account* role —
`consumer|platform_admin`; the workspace role lives on `merchant_users`, never in the token) and `mer` — the
caller's default workspace, i.e. the `merchant_id` a console should open. `mer` is resolved from membership at
issue time **and again on every rotation**, so joining a workspace is visible without signing out and a session
does not lose its workspace at the 15-minute mark. Access 15m, refresh 30d rotating with reuse detection
(reusing a spent refresh token revokes the whole `sid` family → 401 `refresh_reuse_detected`).
Demo login (§87): `POST /api/v1/auth/demo {role: consumer|merchant|admin}` returns a scoped demo session,
flagged by `demo_notice` and the `X-Demo-Data: true` response header (§155).

## 4. Merchants (consumer-facing reads are public, cacheable)

| Method | Path |
|---|---|
| GET | `/api/v1/merchants?district=&category=&max_price=&open_now=&rating=&sort=&limit=&cursor=` |
| GET | `/api/v1/merchants/{id_or_slug}` — profile + locations + hours + top offerings + review summary |
| GET | `/api/v1/merchants/{id}/menu?kind=&sort=&limit=&cursor=` | paginated active offerings |
| GET | `/api/v1/merchants/{id}/reviews?sort=&limit=&cursor=` | published reviews + recomputed `aggregate` |
| GET | `/api/v1/merchants/{id}/reviews/summary` | AI summary **with review_ids as evidence** (§55) |
| GET | `/api/v1/merchants/{id}/availability?starts_at&ends_at&party_size&limit` | real-time, no cache (§20) |
| GET | `/api/v1/locations/geo?bbox=&zoom=` | marker clustering payload |

`{id}` and `{id_or_slug}` accept either form; a slug and an id name the same merchant. Every list above is a
`Paging` page — `{ items, next_cursor, total_estimate }` — and carries `sort` (the token actually applied, not the
one typed), plus the directory page's `as_of`, `filters` and `unit`.

- `sort` is a whitelist; a bare token is ascending and a `-` prefix descending (`-rating`, `-helpful`). Unknown
  tokens are `422 validation_error` with `details.allowed`. No sort fragment reads `plan`, campaign, coupon or
  spend (§66), and the profile deliberately does not echo `plan` either. `rating_agg`/`popularity_score` are
  `NOT NULL DEFAULT 0`, and every explicit sort appends `nulls last` so a value the data does not have cannot win.
- `district` filters the primary location's district (the column the card prints); `category` resolves the printed
  `category_primary` name, a taxonomy leaf slug/name and a parent aisle (§D23), so a chip from a card always
  returns listings. `max_price`/`rating` are `<=`/`>=` comparisons and an unknown price or rating never satisfies
  them. `open_now=true` is computed from `business_hours` at `as_of`.
- Only `published` merchants and `published` reviews are readable. Absent reads are `404`, not empty `200`s:
  `merchant_not_found` (draft, suspended, other tenant, unknown slug) and `review_summary_not_found` (the review
  agent has not run — different from "this place has no reviews", whose real answer is `review_stats.published_reviews
  = 0`).
- Cached as `public, max-age=60, s-maxage=300, stale-while-revalidate=86400` with `Vary: X-Tenant`; availability is
  `no-store`. `X-Demo-Data` badges a page as soon as one row in it is synthetic (§109).

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
| GET | `/api/v1/merchant/businesses/{id}/overview` | `read_analytics` — same funnel scoped to one business (D15; the multi-business workspace needs the per-business form) |
| GET | `/api/v1/merchant/analytics?from&to&metric` | `read_analytics` |
| GET | `/api/v1/merchant/customers?merchant_id&segment&limit&cursor` | `read_analytics`, `merchant = "param:merchant_id"` — the §56 audience list for one business: `[{customer_id, display_name, email, transactions, orders, reservations, spend:{amount,currency}, first_seen_at, last_seen_at, repeat}]` with the paging envelope. `segment` is a **filter** over `all\|repeat\|new`, not a stored label: nothing in this contract writes a customer segment, and no predictive score is claimed. The payload defines itself instead of leaving the screen to invent one — `source` says `orders + reservations (completed transactions only)`, and `definition` states that a customer is a tenant user with at least one order (not cancelled/refunded) or reservation (not cancelled) at this merchant, that `spend` is `sum(orders.total)` with reservations adding none, and that `repeat` means two or more qualifying transactions. `computed_at` is the instant the aggregates were read. Served by `com.nexus.growth`. |
| GET | `/api/v1/merchant/reservations?status&from&to&merchant_id&limit&cursor` | `read_orders` — the merchant's booking inbox (§23). Scoped to the businesses the caller is a member of (D5), `no-store`: a booking list is stale the moment one is written. Returns the holder's own rows with the contact fields needed to serve the guest, nothing wider (§46/§47). Served by `MerchantContentController#reservationInbox` on the `com.nexus.merchant` base path (the inbox is a workspace screen, so it lives with the console rather than with `com.nexus.commerce`, which holds only the checkout repositories). `user_id` is deliberately absent from the projection: it names a person to us, not to the merchant. Acceptance is served from the same resource: the next row is the route that moves a booking to `confirmed` (D26). |
| POST | `/api/v1/merchant/reservations/{id}/accept` | `manage_reservations` — the merchant's yes and the only transition out of `pending` (D26). `200` with `changed` (`false` on a second call: the answer is the state as it reads now, not a second decision), the booking projected the way the inbox projects it, the slot's `capacity_left` read after the write (accepting moves no seats — they left the pool when the guest booked), and a `status_note`. `409 reservation_not_confirmable` for a hold that is no longer live: confirming a cancelled hold would promise a table that already went back to the pool. `404` for another tenant's hold (no enumeration); `403` for a member without the grant — owners and managers only, deliberately not staff, API keys or the AI agent. Both calls audited as `reservation_accept`, the replay carrying no `before`. Served by `MerchantContentController#acceptReservation`. |
| POST | `/api/v1/merchant/ai-agent/config` | `configure_ai`, `merchant = "body:merchant_id"` — `{merchant_id, enabled}`. `enabled` must be a JSON boolean; a string is a 422 rather than a truthy guess. The write sets `merchants.ai_agent_enabled` and nothing else, because that column is the only AI setting this schema carries: the route will not accept a persona, model or temperature it has nowhere to put, and the response says so in `scope_note`. Switching the flag on does not widen what the agent may do — that stays a `permission_grants` question. Served by `com.nexus.merchant` (D40). |
| GET | `/api/v1/merchant/conversations` · POST `/{id}/reply` · POST `/{id}/handoff-resolve` | `send_message` |
| POST | `/api/v1/merchant/campaigns` (AI drafts land in `draft`) | `create_draft_campaign` |
| POST | `/api/v1/merchant/campaigns/{id}/approve-publish` | `publish_campaign` — **explicit human action** (§27) |
| POST | `/api/v1/merchant/coupons` | `create_draft_campaign` |
| GET | `/api/v1/merchant/knowledge-base` | `read_products` |
| POST | `/api/v1/merchant/knowledge-base/reindex` | `configure_ai` |
| GET | `GET /api/v1/merchant/api-keys?merchant_id` · `POST /api/v1/merchant/api-keys` · `DELETE /api/v1/merchant/api-keys/{id}` | `admin_members` — `POST {merchant_id, name, scopes[]}` returns the secret **once** (`api_key`, prefix `nx_live_`); only its SHA-256 is stored, so a key that was not copied when it was created cannot be re-shown by anything, including `GET`, which lists `prefix`, `scopes`, `last_used_at` and `revoked`. Every scope is also written as a `permission_grants` row for `subject_type='api_key'`, and `DELETE` sets `revoked_at` *and* deletes those rows — a revoked key that still authorised something would be a label over a live secret. An unknown scope is a 422 carrying the allowed list, and leaves no row. `name` is required: an unnamed key is one nobody can recognise when it has to be revoked. The `GET` is added to this row by D40 — the service already had `list()`, and a console that cannot see its keys cannot choose the right one to revoke. |
| GET | `GET /api/v1/merchant/members?merchant_id` · `POST /api/v1/merchant/members` · `PATCH /api/v1/merchant/members/{id}` · `DELETE /api/v1/merchant/members/{id}` | `admin_members` — `GET` returns `{members:[{member_id, user_id, display_name, email, role, status, joined_at, permissions}], count, roles}`. `permissions` is that person's **live `permission_grants` rows** for this merchant (the union over both spellings a human row can be filed under, because the authoriser accepts either), and `roles` prints each preset's default set read from the same table the writes use, so a screen cannot invent one. `POST {merchant_id, user_id, role}` requires `Idempotency-Key`; `user_id` must be a person in the caller's tenant (a foreign id is a 404, never a membership row) and an existing member is a 409 `member_exists` that names their current role and points at `PATCH`. All three writes — `POST`, `PATCH` and `DELETE` — answer `authorisation_basis`, naming the mechanism that let the call through (the caller's own `admin_members` grant row, checked before the write; a role is only where grant rows come from, D40); the removal carries it too since D53, and one test asserts the sentence on each door and that the removed member's grant rows really are gone, because a printed promise the payload gives and the database contradicts is the failure D42 was about. `PATCH {role?, status?}` needs at least one field, `status ∈ {active, disabled}`. `DELETE` removes the row. All three **reconcile the grants** with the row: a role change moves the rows, `disabled` deletes them while keeping the membership for the audit trail, and removal deletes them under both spellings — `permission_grants` has no foreign key to `merchant_users`, so the schema will not do this for us (D40). Demoting, disabling or deleting the last active `owner`/`admin` is refused with 409 `last_admin`. `merchant_id` in the response echoes the business the caller acted on, not a default. The audit write is inside the idempotent work block, so replaying a key is answered from the stored response and leaves one `add_workspace_member` row, not two — a trail that counts one tap twice is a trail nobody can read. |
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
| GET | `/api/v1/reservations/{id}` | the booking as it reads now — same projection the `PATCH` on this row answers with, including `updated_at`, so a caller can tell the two apart by the clock rather than by re-asking. Readable by the person the booking is on, or by a subject holding `read_orders` on its merchant (§5). **Anyone else gets `404`, not `403`** (D5): a `403` would confirm that this code exists, and a booking code is a bearer-ish capability. |
| PATCH | `/api/v1/reservations/{id}` | `status` transitions guarded — `{status:"cancelled", reason?}` by the holder only; `404` for anyone else's booking (D5), `409` once the evening is `completed`/`no_show`, seats return to the slot in the same transaction, and `reason` lands in `audit_logs.metadata`. Advancing a hold to `confirmed` is the workspace's accept route (§5, `manage_reservations`, D26) — the holder can only release. |
| POST | `/api/v1/payments/{order_id}/confirm` | demo provider; real provider via webhook |
| POST | `/api/v1/webhooks/payments/{provider}` | signature verified, idempotent |
| POST | `/api/v1/merchants/{id}/reviews` | verified purchase/reservation flags computed server-side |

`POST /api/v1/merchants/{idOrSlug}/reviews` is served by `com.nexus.catalog.ReviewController` (the only
write in that module), and what it stores is decided by §55/§127 rather than by convenience: `@RequiresAuth`
plus a mandatory `Idempotency-Key`, `data_origin='user'`, **`status='pending'`**, and an open
`moderation_cases` row beside it — a pending review with no case in the queue is a review nobody will ever
read. It therefore changes **no rendered number**: `rating_agg` and the `rating` fact next to it are defined
over published rows (D35), and the response says `aggregate_changed: false` on its face. Publishing one is a
human act, and no route here performs it. `verified_purchase` / `verified_reservation` are looked up from the
caller's own order and reservation rows at this merchant (`completed`/`confirmed` and
`paid`/`preparing`/`completed` respectively), never taken from the request body, and the response prints the
predicate it used so a tick cannot come apart from its evidence. A second open review from the same account
is `409 review_exists` — one voice per person per place — unless the first was `rejected`, which is a
judgement about that text and not a permanent silence.

## 7. Conversations & AI

| Method | Path | Body / result |
|---|---|---|
| POST | `/api/v1/conversations` | `{merchant_id?, channel, mode}` → conversation |
| GET | `/api/v1/conversations/{id}` | messages + state |
| POST | `/ai/v1/search/stream` | `{query, conversation_id?, context:{geo,now,locale,party_size}}` → **SSE stream** (§116). The web BFF proxies this as `POST /api/nexus/ai/stream`; the platform service never serves `/api/v1/ai/**`. |
| POST | `/ai/v1/search` | deterministic (non-streaming) hybrid search, and the §105 degradation target: `{intent\|query, geo?, filters?, limit}` → `{items:EntityCard[], facets, took_ms, strategy, degraded:false}` |
| POST | `/ai/v1/query/understand` | `{query, context}` → `Intent` (below) |
| POST | `/ai/v1/recommend` | `{intent|conversation_id, limit}` → `{set_id, items:EntityCard[]}` with explanations + fact ids |
| POST | `/ai/v1/compare` | `{subject_ids:[...] }` → `{rows:[{attribute, cards:[{value,fact_id}]}]}` (§37) |
| POST | `/ai/v1/rag/retrieve` | `{query, merchant_id?, filters, top_k}` → `{chunks:[{id,text,score,document_id,source_uri,fact_ids}]}` |
| POST | `/ai/v1/merchant-agent/chat` | `{merchant_id, message, conversation_id}` → SSE; grounded only in merchant KB, low confidence → handoff (§24-26) |
| POST | `/ai/v1/feedback` | `{subject_type,subject_id,signal,value,session_id}` (§99) |
| GET | `/ai/v1/tools` | tool registry manifest (§11) with schema + permission |
| GET | `/ai/v1/conversations/{id}` | the §52 audit view of one conversation: `{conversation_id, agent_runs:[…], count, degraded, reason?}`. Each run is its `agent_runs` row (`agent_run_id, agent, model, provider, status, plan — the agent's execution plan, not a merchant's subscription tier — input_summary, output_summary, tool_calls, retrieval, fact_ids, tokens, cost_usd, latency_ms, error, fallback_used, started_at, finished_at, parent_run_id`) plus `persisted:true`, oldest first, capped at 100. Not a transcript: the browser reads the platform's `/api/v1/conversations/{id}` above. A non-UUID id is a 422; a failed timeline read degrades to this process's in-flight ledger rather than a 500. Note: the read is keyed on the conversation UUID alone, with no tenant predicate — acceptable for an internal audit surface, and the first thing to revisit if it is ever exposed to a browser. |
| GET | `/ai/v1/health` | liveness/readiness: `{status, service, version, provider, offline, demo_data, database:{configured,available}, embeddings:{provider,dim}, adapters, now}`. Reports only whether each dependency answered — never a row and never a query result. |
| POST | `/ai/v1/imports/extract` | service-to-service only (§7.0): `{source_type,source_ref,raw_text}` → `{proposals:[{kind,name,price,currency,category,confidence,source_span}], extractor, degraded}` (§22). Called by the platform's import worker, never by a browser. |
| POST | `/api/v1/conversations/{id}/reply` | `{content}` → persisted consumer/agent turn (the browser path; the agent path is §7.0) |
| POST | `/api/v1/conversations/{id}/handoff-resolve` | `{action?, note?}` — the merchant team closing out an escalation raised under §24-26. `action` is `accepted` or `resolved` (default `resolved`); either moves the thread's `owner_type` to `human`, and only `resolved` closes it. With no handoff waiting the route answers `409 no_open_handoff` rather than reporting a quiet success, and the act is audited as `conversation_handoff_resolve` carrying the handoff's own `reason` as the before-state. Guarded by `send_message` on the thread's merchant, so a consumer cannot end their own escalation — §5 answers the same act through the merchant inbox alias. |
| GET | `/api/v1/conversations` | the acting user's threads, newest first |
| POST | `/api/v1/internal/conversations/{id}/agent-message` | service-to-service only (§7.0): the AI service's single audited door for persisting an agent turn. |

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

### 7.0 Service-to-service surface (never browser-reachable)

Two paths exist only between our own services. The BFF must not proxy them, they are absent from the
public OpenAPI document, and a request that arrives from an edge is rejected for missing the shared
secret. This is D20: the platform owns every commerce and conversation write, so an agent turn is
*posted to* the platform, not written *into* Postgres by the AI service.

| Method | Path | Direction | Contract |
|---|---|---|---|
| POST | `/api/v1/internal/conversations/{id}/agent-message` | AI → platform | Header `X-Internal-Token: ${NEXUS_AI_INTERNAL_TOKEN}` (≥16 chars, constant-time compare) + `X-Tenant`. Body `{role, content, agent_run_id?, fact_ids?, degraded?}` → the persisted message. Unconfigured token ⇒ **501**, never an open door (D7). |
| POST | `/ai/v1/imports/extract` | platform → AI | `{source_type,source_ref,raw_text}` → `{proposals:[{kind,name,price,currency,category,confidence,source_span}], extractor, degraded}` (§22). Extracted text is untrusted content (§51): `confidence` and `source_span` are mandatory so a human reviews every proposal before publish. |

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

There is **no `guides` table** — that is deliberate (DATABASE.md §3.9: "`collections` (`kind
collection|guide|itinerary`…)"). A guide is `collections WHERE kind = 'guide'`, so the storage rules below
apply to both objects:

| Response field | Column / derivation | Honesty rule |
| --- | --- | --- |
| `Guide.slug`, `title`, `description` | `collections.slug`, `title` (+ `title_zh` for the zh-HK locale) | direct |
| `Guide.items[]`, `Guide.cards[]` | `collections.items` jsonb — **the ordered array the column actually holds**, `[{subject_type, subject_id, note}]` (V1's own comment, and what every seeded row is). Merchant references are resolved into §2 `EntityCard`s on the same read: `items[]` keeps the stored order with each resolved card nested under `card`, and `cards[]` is that same list flattened | an id that resolves to no published merchant drops the item and is named in `dropped_item_ids`; it never renders a placeholder card, and the page never silently gets a shorter list than the author wrote. Repeats are kept: the seeded Sha Tin guide cites ten items across nine shops, and `len(cards)` tracks the items, not the shops. An element with a `type` key (a paragraph or heading block) is passed through unresolved — see D34 on why blocks are tolerated and not invented |
| `Guide.generated_by` (`ai\|editor\|creator`) | `collections.seo->>'generated_by'` | required; absent provenance is served as `creator` **only** when `author_id` is a real user, otherwise the row is not publishable |
| `Guide.reviewed_by_human` | `collections.seo->>'reviewed_by_human'` = `'true'` | this is the §27 gate, and the platform applies it: a detail read answers `reviewed_by_human` plus the derived `noindex` and `noindex_reason`, so `false` ⇒ noindex and sitemap-omitted without the view deciding anything (§30 computes the same verdict for `seo_pages`) |
| `Collection.curated_by.{type,name}` | `collections.seo->>'curated_by'` (`editorial\|creator\|model\|ai`) + `users.display_name` for `author_id`, or the model's own name for `model` | the name is a real account's name, a real model version, or the literal `"AI curation"` — never a person who did not curate it |
| `Collection.cover_image.{url,alt,credit}` | `collections.cover_url`, `collections.seo->'cover'` | `credit` is nullable and stays nullable — an uncredited photo must not gain a photographer |
| `flags.demo` | `collections.data_origin = 'demo'` | the column is the source of the badge; the UI may not decide it |
| `Guide.city`, `Guide.category` | `collections.seo->>'city'`, `collections.seo->>'category'` — `collections` has no such columns and none is being added | both are optional context for the breadcrumb and the internal links; a guide with no `city` is a real, honest state, so the web layer must not synthesise one from the slug |
| `published_at`, `updated_at` | same columns | the platform never stamps `published_at` for a row that is still a draft: `visibility = 'public' AND published_at IS NOT NULL` is the list filter |

`GET /api/v1/guides` · `GET /api/v1/referrals/me` · `POST /api/v1/referrals/invite {kind,email}` · `GET /api/v1/referrals/me/stats` ·
`GET /api/v1/collections` · `POST /api/v1/collections` · `GET /api/v1/collections/{slug}` ·
`GET /api/v1/guides/{slug}` (SSR + JSON-LD) ·
`POST /api/v1/share {subject_type,subject_id}` → short link + OG payload.

The four §8 reads above are served by `CollectionsController` (`com.nexus.catalog`): public, no session,
`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=86400`, `Vary: X-Tenant`, and every one
of them answers only rows that are `visibility='public'`, `published_at IS NOT NULL` **and** attributable (D34).
`POST /api/v1/collections` **is served, and what it serves is a draft** (D61) — and the reason it was held
open is worth keeping, because it is still exactly true of *publication*: the sentence used
to be that the write "belongs behind the workspace permission chain", but `collections` carries `tenant_id` and
`author_id` and **no merchant column** (verified against the live table), so no workspace permission can guard a
row this schema cannot attribute to a workspace. The open question is therefore which authority owns a published
guide — the platform, the author, or a merchant once the table can name one — not how to wire a door that has no
frame. `POST /api/v1/share` needs a link table that V1–V6 never created (§45 records it as a decision, not as
backlog).
**What that write does (D61).** `@RequiresAuth` and nothing more, because that is the only authority this
route needs and inventing a permission for a row the schema cannot attribute to a business would be the §27
failure in a new costume. `author_id` is the session's subject and the other five trust-bearing columns are
literals in the `INSERT` — `visibility='private'`, no `published_at`, `data_origin='user'`, `seo={}`,
`tenant_id` the request's tenant — so a body that sends `visibility`, `published_at`, `data_origin`,
`author_id`, `tenant_id` or `seo` is answered `422` naming the reason for that key, and any key the route
does not read is refused the same way with the accepted list: a silently-dropped field is how `titel` comes
back as 「the API lost my title」. `kind` is checked against the same `KINDS` list the directory filters
`?kind=` with, so a kind nobody can read cannot be created. `items` is stored as written — every element an
object, `subject_type` one of `merchant|offering|guide|collection` with a uuid `subject_id`, and a typed
`{type,text}` block passing through untouched, because §8's read is what resolves ids and it already names
the ones it could not on `dropped_item_ids`. Publication is still not a verb: no route stamps
`published_at`, and `CollectionDraftWriteTest` asks the running router for every `(method, path)` under
`/api/v1/collections` and `/api/v1/guides` and refuses anything beyond the four reads plus this create, so
§27's human decision is a checked fact about the routing table rather than a comment. The same test then walks every corner of that AND on the row it created:
dated but still private stays hidden, public-flagged but never dated stays hidden, both appears.
The favourites door is checked in the same three states, because it asks the same predicate rather than a copy of it. The audit action is `create_collection_draft`.

Referral rewards are recorded only on genuine conversion events (§110 forbids fake growth).

Programmatic SEO (§29/§30) reads the `seo_pages` projection, which the platform owns — the web edge never
decides by itself which URLs deserve an index slot:

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/v1/seo/routes?city=` | `[{city, category, subcategory, listings}]` — the route grammar a city can answer, with real listing counts |
| GET | `/api/v1/seo/page?city=&category=&subcategory=` | `ProgrammaticPage`: heading, derived facets, cards, `updated_at`, and `indexable` + `reason` (§30 quality bar computed server-side) |

Both are public, cacheable reads (`s-maxage`, `stale-while-revalidate`); they never accept a session cookie,
and they answer 404 for a city/category pair outside the grammar rather than rendering an empty page.

`indexable` is a **derived verdict, computed here and nowhere else**, from real columns:

```
indexable = status = 'published'
            AND listings >= <tenant threshold>
            AND (quality_score IS NULL OR quality_score >= 0.6)
            AND (generated_by <> 'ai_seo_agent' OR reviewed_by IS NOT NULL)
reason    = 'enough_listings' when indexable
          | 'too_few_listings' | 'below_quality_bar' | 'not_published' | 'unreviewed_ai'
```

- `listings` is `COUNT(DISTINCT merchant)` from the live catalogue for that city/category(/subcategory) — the
  number on the page and the number in the route listing are the same query, so a page cannot show three
  cards while claiming eight (§19/§155).
- `quality_score` and `reviewed_by` come from the `seo_pages` row; a missing `seo_pages` row means the page is
  **not** indexable (absence is not a pass), while the listings themselves still render.
- The listing threshold is tenant configuration, not a code constant: the web layer has its own
  `MIN_LISTINGS_FOR_INDEX = 5` **only** inside `src/lib/mock`, which is the stand-in for this endpoint. When
  this endpoint is live the web value is unused, and the two must not be reconciled by making the web layer
  compute the bar.

## 9. Admin console (§68, §126-127)

`GET /api/v1/admin/{users|merchants|orders|reservations|reviews|reports}` ·
`GET /api/v1/admin/moderation?status&subject_type&limit&cursor` ·
`POST /api/v1/admin/moderation/{case_id}/resolve {decision,note}` (D39, served).

The two moderation routes are served by `com.nexus.catalog.ModerationController` (`platform_admin` /
`platform_ops` only); build the rest of §9 around them rather than re-declaring them. A case resolves by
writing two rows at once — the case (who, when, with what note) and the subject (what it now is) — because a
queue that records decisions while the content stays pending is a log, not a control. `decision` is one of
the review's own states (`published|rejected|flagged`), not a verdict word; a closed case answers
`409 case_already_resolved`, and the close is guarded in the statement (`where status = 'open'`) so two
simultaneous reviewers cannot both win. Publishing moves an aggregate, so the same call recomputes it from
the published rows and restates the `rating` fact beside it (D35/D38); the response lists what it restated
in `aggregate_restated`. Merchant staff have no route here — a shop approving its own reviews is the
conflict §55 exists to avoid.
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
- **Telemetry ingest**: `POST /api/v1/events {events:[{name, properties, occurred_at, session_id}]}` →
  `202 {accepted, rejected, duplicates, reject_reasons, max_batch, note}`. `accepted` counts the rows now
  durable (a replayed `event_id` lands in `duplicates` and is not written twice); `reject_reasons` is
  bounded to 10 entries while `rejected` keeps the exact count. The SDK batches here (§58);
  `Idempotency-Key` is required and de-dupes a
  flushed batch, not an individual event. It appends to the `events` table through the platform only
  (`nexus_ai` keeps its INSERT-only grant, D19), never validates a business invariant, and must not be
  used as a write path for anything a user can see — an event is an observation, not a record.
  Unauthenticated calls are allowed only with an anonymous `session_id`; no free-text field is stored
  and nothing collected here may influence organic ranking (§66).
- **Liveness and readiness**: `GET /api/v1/health` → `{status, service, profiles[], request_id}` — a process
  answer, no dependency touched, so it stays 200 while the database is down. `GET /api/v1/ready` →
  `{status: ready|not_ready, database: up|down, schema_version, key_value_backend: redis|in_memory}`, where
  `schema_version` is the highest successful `flyway_schema_history` entry and `not_ready` is a real answer
  rather than a 500. Neither sets an explicit `Cache-Control` — §103's `no-store` rule is about money and
  seats, and these are neither — so a caller must not treat the answer as durable: `health` carries a fresh
  `request_id` and `ready` issues a `select 1` per call, which is the only reason it can say `down` at all.
- The generated documents themselves are part of the contract: `/v3/api-docs` is what the router registered,
  so `scripts/verify_contract_runtime.mjs` diffs it against §-tables, and
  `scripts/verify_served_reads.mjs` probes every path declared there.
- All list endpoints support `ETag`/`Cache-Control` except availability/inventory/price (no-store, §103).
- OpenAPI is generated from code annotations at `/v3/api-docs` and `/ai/openapi.json` — this document is the design
  input, generated specs are the build output; they must agree (contract test in CI).
