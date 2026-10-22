# NEXUS — Database Design

Status: **the schema exists and is live.** `infra/db/migrations/V1__init.sql` … `V4__tenant_scoped_identity.sql` are
applied to the dev and test databases, and the demo tenant carries seeded data. This is the authoritative *rationale*
for those files; if the two disagree, the migration wins and this doc is corrected.
§n → `新建 文本文档.txt`; roles/shapes reference [`API_CONTRACT.md`](API_CONTRACT.md) §0/§2 and
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5.

> Path note: the migrations live at **`infra/db/migrations/V*.sql`**, which is where the kickoff brief pointed and
> where they actually are (an earlier revision of this doc claimed the brief was wrong about the path; the file has
> since been moved to the documented one). `services/platform` copies them into `db/migration` at build time so
> Flyway's `classpath:db/migration` resolves (see [ARCHITECTURE.md](ARCHITECTURE.md) §1).

## 1. Extensions & primitives

`pgcrypto` (gen_random_uuid), `citext` (case-insensitive emails), `pg_trgm` (fuzzy/keyword similarity), `vector`
(pgvector), `btree_gist` (exclusion constraints on slots). Ids are `uuid` (except `events`/`audit_logs` which are
`bigserial` append-only). Money is `numeric(12,2)` + a `currency` code — serialised as a **string decimal** over HTTP
([`API_CONTRACT.md`](API_CONTRACT.md) §1) so JSON never loses precision. Every mutable table has `created_at` /
`updated_at` (`timestamptz`, UTC) maintained by the `set_updated_at()` trigger (§11).

## 2. Tenancy model (§47)

- **`tenants`** = a market/city deployment boundary (`slug='hong-kong'`, `country_code='HK'`, `region_code`,
  `timezone`, `currency`, `locales[]`, and `config jsonb` holding jurisdiction/compliance switches — §128 legal config,
  §111 i18n). This is the unit that makes HK→GBA→global expansion a data change, not a code fork (§4, §95).
- **Row-scoping:** every tenant-owned table carries `tenant_id` (`merchants`, `offerings`, `locations`, `reviews`,
  `orders`, `carts`, `reservations`, `conversations`, `chunks`, `facts`, `recommendation_sets`, `collections`, `coupons`,
  `campaigns`, `seo_pages`, `events`, …). `users.tenant_id` is nullable (platform staff may be cross-tenant).
- **Enforcement is in code, not the DB (D5):** repositories take `TenantContext` as the *first* argument and add the
  predicate; a query without a tenant filter fails review; cross-tenant read returns 404 not 403. **No Postgres RLS is
  defined in V1** — that is an accepted phase-1 risk, revisit at 100x ([ARCHITECTURE.md](ARCHITECTURE.md) §9).
- Merchant hierarchy: `merchants` → `merchant_users` (RBAC roles) → `permission_grants` (declarative, per subject),
  all inside one tenant. Data isolation between merchants is via `merchant_id` FK + the grants layer ([SECURITY.md](SECURITY.md)).

## 3. Tables by domain

Grouped by domain; the ER overview in §10 shows relationships. "Owner role" = which DB role writes it (§9).

### 3.1 Identity & access
- **`users`** — consumers + platform staff (`role consumer|platform_admin|platform_ops|creator`; `status`,
  `marketing_opt_in`, soft `deleted_at`). Partial unique on non-null, non-deleted email **within a tenant**
  (`users_email_tenant_uniq`, V4): the address identifies a person *to one storefront*, and §2's whole premise is
  that two tenants never see each other's rows.
- **`user_identities`** — one row per `(tenant_id, provider, provider_id)` (`user_identities_tenant_uniq`, V4);
  `secret_ref` is a pointer into the secret store, **never a raw token/secret** (§131). OAuth (google/apple) and
  password coexist. Before V4 the column had no `tenant_id` and the unique key was global, which contradicted every
  tenant-scoped read on top of it — see [`DECISIONS.md`](DECISIONS.md) D29.
- **`permission_grants`** — declarative grants for humans **and** agents: `subject_type IN (user, merchant_user, agent,
  api_key)`, `permission`, nullable `merchant_id` (null = tenant/platform scope), `granted_by`, `expires_at`. Backs
  §48/§49/§52 ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8). Indexed by `(subject_type, subject_id)`.
- **`api_keys`** — merchant API keys (§46): stores `key_hash` (sha256; plaintext shown once), `prefix`, `scopes[]`,
  `revoked_at`.

### 3.2 Merchant & catalog
- **`merchants`** — the business profile. Key columns for our purposes:
  `data_origin` (`demo|merchant|imported|partnership`) = the honesty flag rendered as `flags.demo`/`X-Demo-Data`
  (§109, [D6](DECISIONS.md)); `status` (`draft|pending_review|published|suspended`) gates discoverability;
  denormalised ranking inputs `rating_agg`, `review_count`, `popularity_score`, `avg_price_hkd`, `price_band`;
  `attributes jsonb` / `tags[]` hold queryable traits (quiet_ambience, kid_friendly, mtr_within_5min);
  `plan` (`free|pro|enterprise`, §65); `ai_agent_enabled`; `search_tsv` (§7). Partial index on `(tenant_id, status)`.
- **`merchant_users`** — membership + role (`owner|admin|manager|staff|marketing|analyst|ai_agent`, §48).
- **`categories`** — hierarchical catalog (`parent_id`), `tenant_id` null = global catalog; `kind`
  (`merchant|product|service|experience`). `merchant_categories` = M:N.
- **`locations`** — one merchant → many; carries `lat/lng numeric(9,6)`, `district`, `area`, `mtr_station`,
  `mtr_walk_min`, `is_primary`. Geo index is plain btree `(lat,lng)` for bbox scans (§7).
- **`business_hours`** — `weekday 0=Mon..6=Sun`, `opens_at/closes_at time`, `crosses_midnight`, per `location_id`.
  Unique includes `opens_at` so multi-sitting days are allowed. Long-TTL freshness class (§20, §8).
- **`offerings`** — unified **product + service + experience** via `kind` so the Universal Cart can hold all three (§41).
  Rich price model: `price_amount`, `price_model` (`fixed|from_price|per_person|hourly|range`), `price_min/max`,
  `price_source` (`merchant|imported|observed|estimated`), and `price_updated_at` (drives price TTL, §8). Stock:
  `stock_quantity` + `stock_updated_at` (short TTL). Booking: `bookable`, `min/max_party_size`, `duration_minutes`.
  Ranking denorms `popularity_score/rating_agg/review_count`; queryable `attributes`/`constraints`/`options` jsonb;
  `search_tsv` (§7).
- **`offering_relations`** — commerce graph edges (§120): `related_to|upsell|bundle|belongs_to` with `weight`.

### 3.3 Availability & reservations (§40)
- **`resource_pools`** — the generic-resource abstraction so restaurant/hotel/beauty/fitness share one service:
  `kind` (`table|room|seat|treatment_room|class_slot|ticket`), `capacity`, `attributes`. This is *the* mechanism that
  keeps business logic out of any single vertical (§40).
- **`availability_slots`** — real-time reservable windows: `capacity_total/left`, `price_amount`, `source`,
  `updated_at` (real-time TTL, §20). CHECK `ends_at > starts_at`. Lookup indexes `(merchant_id, starts_at)`,
  `(pool_id, starts_at)`. (`btree_gist` enables an exclusion constraint to prevent double-booking a pool — add in V2
  when booking is enforced; see §10 risk.)
- **`reservations`** — human `code` (`NX-RES-xxxx`), party_size, contact jsonb, `status`
  (`pending|confirmed|cancelled|completed|no_show`), and `source` (`consumer|ai_agent|mcp|ucp|merchant`) — provenance of
  *who* created it, used by [MCP.md](MCP.md)/[UCP.md](UCP.md) attribution.

### 3.4 Commerce (§41, §42)
- **`carts`** — anonymous allowed via `session_id`; `merchant_id` soft-grouping (multi-merchant permitted); `status`
  `open|converted|abandoned`, `expires_at`.
- **`cart_items`** — `kind` (`product|service|experience|reservation`); CHECK (`offering_id` OR `reservation_id`);
  **`unit_price` + `price_source` + `priced_at`** so price is re-validated against TTL before checkout (§20, §103) —
  never silently charge stale.
- **`orders`** / **`order_items`** — status machine (`created|paid|preparing|completed|cancelled|refunded`),
  `fulfillment` (`pickup|delivery|dine_in|reservation|virtual`); items keep `name_snapshot` + price (immutable history).
- **`payments`** — `provider` (`demo|stripe|alipayhk|payme|hsbc`), `provider_ref`, **`idempotency_key` UNIQUE** (§42, §104),
  status (`pending|authorized|captured|failed|refunded|partially_refunded`), `client_secret_ref` (pointer, **no PAN /
  card data ever**, §42/D5).
- **`refunds`** — amount/status/`approved_by` (a refund is a human/permissioned action; `refund_payment` is never a
  default agent grant, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8).
- **`idempotency_keys`** — table-level idempotency store (key, scope, response, status, expires) backing the
  `Idempotency-Key` header contract.

### 3.5 Reviews & trust (§54, §55, §19, §53)
- **`reviews`** — rating CHECK 1..5, `aspects jsonb` (per-dimension scores), `verified_purchase`/`verified_reservation`,
  `data_origin` (`demo|user|imported`, §109 no fake reviews), `status`, `moderation`.
- **`review_summaries`** — per merchant (`merchant_id` PK): `praise`/`complaints` jsonb each carrying
  `[{label, evidence_count, review_ids}]` — this is the §55 "traceable to source reviews" guarantee. `model`,
  `sample_size`.
- **`facts`** — the trust-layer primitive ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4, §19): one row per material claim
  (subject_type/subject_id/attribute/value jsonb, `source`, `confidence`, `observed_at`, `expires_at`, `stale`).
  Provenance design detailed in §8. Indexed by subject, by merchant+attribute, and a partial expiry index
  `(expires_at) WHERE stale IS FALSE` for the staleness sweeper.
- **`trust_signals`** — merchant-level anomaly/detection rows (§53, `review_anomaly|price_anomaly|duplicate_listing|
  fraud_flag`, `detected_by rule|model|human`, `status`); conflicts in fact resolution write here rather than silently
  picking ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4).
- **`moderation_cases`** — human-review queue (§127): subject + reason + policy + `auto_action` (never auto-deletes
  without audit).

### 3.6 Conversations (§25, §26, §34)
- **`conversations`** — `channel` (`web|mcp|ucp|whatsapp|email`), `mode` (`ai|human|hybrid`), and `state jsonb` = the
  persisted conversation/intent/filters/preferences (§34, merged by `apps/ai/nexus_ai/nlu/state_merger.py`).
- **`messages`** — `sender_type`, `role`, `content_type` (`text|cards|comparison|form`), `payload jsonb` (structured UI
  blocks + sources), `agent_run_id` link, `confidence`, `handoff` flag.
- **`handoffs`** — §26 escalation: reason (`low_confidence|user_request|policy|refund`), status, `evidence`.
- **`user_preferences`** — preference **memory** (§32, §117, §118): `kind`, `key`, `value jsonb`, `weight` (0..1),
  `source` (`declared|inferred|transaction`), `scope` (`session|long_term`), `expires_at`. User-visible/editable/
  deletable; "reset personalization" clears `source='inferred'`. Unique `(user_id, kind, key)`.

### 3.7 RAG (§12, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §7)
- **`documents`** — parsed source (menu/policy/faq/review/url/pdf/xlsx), `raw_text`, `content_hash` (embedding/reindex
  dedupe key), `status` (`pending|processing|indexed|failed`).
- **`chunks`** — `document_id`, denormalised `merchant_id`/`tenant_id` (so the tenant filter runs *before* similarity,
  §7), `text`, `embedding vector(1024)` (**dim fixed at 1024, D3** — a dim change is a new migration, not a config
  edit), `embed_model`, `search_tsv`, `metadata`. HNSW cosine index + trgm + tsv indexes (§7).

### 3.8 Recommendations & feedback (§17, §18, §99)
- **`recommendation_sets`** — one stored ranking result: `intent jsonb`, `strategy` (weights versioned here, e.g.
  `hybrid_v1`, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6), `items jsonb` (`[{subject_type,subject_id,rank,score,
  explanations[],fact_ids[]}]`), `latency_ms`. This is where the `ranking`/`recommendation` agents are allowed to write.
- **`feedback_events`** — explicit + implicit signals (§99, §100): `signal` (`like|dislike|not_relevant|too_expensive|
  too_far|wrong_category|click|reserve|purchase|dwell`); combined, never sole ground truth.

### 3.9 Discovery objects (§63, §64, §115)
- **`favorites`**, **`saved_searches`** (stores the resolved `intent jsonb` + `notify`), **`collections`**
  (`kind collection|guide|itinerary`, ordered `items jsonb`, `data_origin` demo-flag for AI guides, §64 real-data rule).
  `items` is the flat array its column comment states — `[{subject_type, subject_id, note}]` — and the API resolves
  the merchant ids into cards on read; a typed block passes through unresolved rather than being deleted (D34).

### 3.10 Growth & monetization (§59–§66)
- **`coupons`** — `status` includes `draft`; `published_by`/`published_at` = the explicit human authorization for §27.
- **`campaigns`** — `goal`, `channel[]`, `audience`/`creative jsonb`, `coupon_ids[]`, `status`
  (`draft|awaiting_approval|scheduled|live|paused|ended`), `generated_by` (default `ai_marketing_agent`), `approved_by`.
- **`referrals`** — consumer|merchant|creator loops (§61, §62); `status` (`invited|signed_up|first_value|rewarded`) so
  rewards fire only on genuine conversion (§110 no fake growth).
- **`subscriptions`** — merchant plan + credits (§65).
- **`share_links`** (V7) — the short link `POST /api/v1/share` promised in §8. `code` is globally UNIQUE
  (a stranger holding the link knows nothing about tenants, so the code has to resolve on its own); a
  **partial** unique index on `(tenant_id, subject_type, subject_id) WHERE revoked_at IS NULL` makes
  "one live link per subject" a constraint rather than a lookup, so re-sharing returns the same code and
  a revoked link steps aside instead of blocking a replacement. `subject_type ∈
  merchant|offering|collection|guide`; `hits` is written by the edge, **never** by the resolver route
  (a GET that writes cannot be cached). No `updated_at` and therefore no trigger: V1 installs
  `set_updated_at()` only on the tables it lists, and a column a trigger expects but the table lacks is
  the exact shape of the `facts` incident V6 fixed. Rows are minted only for subjects that are already
  public in that tenant, so the table cannot hold an address to a page that never existed.

### 3.11 Content / SEO (§28–§30, §64)
- **`seo_pages`** — path/kind (`city|category|category_district|theme|merchant|offering|guide`), i18n `title/title_zh`,
  `jsonld`, `canonical`, `lang`, `status` (`draft|published|noindex|retired`), **`quality_score`** (the anti-spam guard §28),
  and **`data jsonb`** = the real listings backing the page (the §30 uniqueness guard that prevents "10万只有城市名不同的垃圾页面").
  Unique `(tenant_id, path, lang)`.

### 3.12 Platform / observability / security
- **`events`** — the single §58 schema (`event_id` uuid UNIQUE = dedupe key; `bigserial` PK; append-only). Indexed by
  name+time, actor, subject, tenant+time. Feeds the analytics views and the north-star derivation.
- **`notifications`** — audience/channel/template/status/read_at (§123–§125).
- **`agent_runs`** — every agent task (§70): agent, model/provider, status, plan, tool_calls jsonb, retrieval,
  `fact_ids uuid[]`, prompt/completion tokens, `cost_usd`, latency, `fallback_used`
  (`model_fallback|deterministic_search|human`, §105), `parent_run_id` for nested agents.
- **`llm_calls`** — per model call: provider/model/purpose, tokens, cost, latency, `cache_hit` (§69, §160).
- **`eval_suites` / `eval_cases` / `eval_runs`** — the §71–§72 benchmark store: cases hold `expected jsonb`
  (intent fields, must_include/exclude, behaviour); run `metrics jsonb` holds hallucination_rate, precision@k, etc.,
  consumed by the release gate ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11).
- **`audit_logs`** — append-only security trail (§50, §69): actor, `action` (incl. `permission_denied`, `tool_call`),
  before/after, ip/inet.
- **`rate_limit_buckets`**, **`idempotency_keys`** — enforcement stores (§50, §104).
- **`agent_profiles`** (protocol ucp|mcp|a2a, capabilities, payment_handlers, status) + **`external_principals`**
  (protocol, client_id, scopes, `linked_user_id`) — the §43–§45 external-agent surface, served only via adapters.
- **`deletion_requests`** — §106 data-retention workflow (account|memory|personalization|export).

## 4. Seed & honesty plumbing (§86, §109)
`data_origin`/`data_origin` defaults are `'demo'` on `merchants`, `reviews`, `collections`. The `data/seed` generator
must produce 500+ merchants / 5000+ offerings / 10000+ reviews as **clearly synthetic** (invented names, `example.*`
domains, DEMO markers, [D6](DECISIONS.md)), all landing with `data_origin='demo'`, and never fabricate real availability
or live prices (no endpoint writes facts with source=`observed` for a value that wasn't observed).

## 5. Index strategy — WHY each index exists (D3)

Phase-1 search is **Postgres-only** behind the `SearchBackend` seam (§16, [SEARCH.md](SEARCH.md)). Four mechanisms:

1. **Keyword full-text — `tsvector` + GIN** on `merchants.search_tsv`, `offerings.search_tsv`, `chunks.search_tsv`.
   Maintained by triggers (§11) using config `'simple'`. *Why:* exact-token recall for names/tags/menu items, cheap and
   in-DB. *Caveat:* `'simple'` does no CJK segmentation — adequate to launch, likely insufficient for fluent zh-HK
   matching; flagged for `zhparser`/a search-engine swap ([ARCHITECTURE.md](ARCHITECTURE.md) §9).
2. **Fuzzy / typo & substring — `pg_trgm` GIN** (`gin_trgm_ops`) on `display_name`, `name`, `chunks.text`.
   *Why:* autocomplete and misspellings that `tsvector` misses; complements (not replaces) exact-token search.
3. **Semantic — `pgvector` HNSW** (`chunks_embedding_hnsw`, `vector_cosine_ops`) on `chunks.embedding`.
   *Why:* paraphrase/synonym recall ("下雨天穿的鞋"). Dim fixed 1024 (D3). Hybrid = tsvector ∪ trgm ∪ vector ∪ geo ∪
   metadata ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6).
4. **Geospatial — bbox + haversine, NO PostGIS.** `locations` has `(lat,lng)` numeric + btree index; queries filter a
   bounding box (indexable range scan) then sort by haversine distance in SQL.
   *Why no PostGIS:* the chosen image `pgvector/pgvector:pg16` (D1) does not ship it, and a single-city/district launch
   doesn't justify it (§169, don't over-engineer). Trade-off accepted: bbox prefilter is a rectangle (includes
   off-radius corners) and haversine-in-SQL is O(candidates) — fine at district scale, a known rewrite at 100x dense
   multi-city ([ARCHITECTURE.md](ARCHITECTURE.md) §9). When needed: add PostGIS or move geo to the search engine.

Plus targeted: GIN on `tags[]`/`attributes`/jsonb for faceted filtering; `merchants(tenant_id,status)` for list scans;
`rating_agg DESC`, `price_amount` btree for sort/filter; events/audit time-series indexes; `facts(expires_at) WHERE
stale IS FALSE` partial index so the TTL sweeper touches only live facts; `facts(subject_id)` (V10) for the AI's
by-ids grounding read — `facts_for` filters `subject_id = ANY(uuid[])` and *cannot* name `subject_type`, because one
page mixes merchant cards and offering cards, and both indexes that mention `subject_id` lead with it (D506).

## 6. Freshness / TTL design (§20, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5)

TTL values are **policy, not schema** — they live in `infra/config/` and [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5.
The schema provides the *clocks*: `facts.expires_at` + `facts.stale` (partial-indexed); `offerings.price_updated_at`,
`stock_updated_at`; `availability_slots.updated_at` (real-time, TTL 0); `business_hours.updated_at` (long TTL). On read
the AI layer compares `now` against the per-attribute TTL to compute `stale`, surfaced as `价格可能已更新` and blocking
silent charges (§103). A background sweeper marks expired `facts.stale=true` using the partial index.

## 7. Fact provenance design (§19)

`facts` is the single source of truth a rendered number may cite. Design points:
- **Write:** every merchant edit / import / observation upserts a fact with `source`
  (`merchant|imported|observed|third_party|inferred|demo`) and `confidence`; denormalised `merchant_id` scopes it.
  `demo` is what the seed writes for synthetic rows (§109): the origin is stated, not laundered into a real one.
- **Read/conflict resolution:** source priority `merchant (fresh) > observed > imported > third_party > inferred > demo`; a
  tie/conflict writes a `trust_signals` row instead of silently choosing ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4).
- **Hours mirror:** `business_hours` (one row per weekday × location, `weekday` 0=Mon…6=Sun) is what
  `open` is computed from, and the merchant's `opening_hours` fact is the same statement in citable form.
  A write to `business_hours` must upsert that fact, or the citation goes stale on its own TTL (D25).
- **Rating mirror:** `merchants.rating_agg` / `offerings.rating_agg` are what the card prints, and a `rating` fact
  is the same mean in citable form — `source='observed'` (the platform's arithmetic over its own published review
  rows, not a merchant's claim), `confidence` banded by sample size, `value` carrying `count`, `max_score`,
  `method` and `reviewed_through` (the newest review inside the window). Both sides must be the number a
  `round(avg(rating), 2)` over the published reviews returns, which pins the rounding convention: `numeric` rounds
  half away from zero and Python's `round` rounds half to even, and seventeen seeded ratings once sat a cent apart
  because of it (D35). A subject with no published review has no aggregate to print and no fact — a rating of
  `0.00` is a claim, not an absence.
- **One row per claim.** `facts (subject_type, subject_id, attribute)` is unique (V5): an re-observation
  updates that row — value, source, confidence, `observed_at`, a fresh `expires_at`, `stale=false` — because
  every reader takes `order by observed_at desc limit 1`, and two live rows about one claim is two truths with
  a tie-break. V1 put a `BEFORE UPDATE … set_updated_at()` trigger on `facts` without giving it an
  `updated_at` column, so no fact could be updated at all until V6 supplied the column the trigger assumed;
  D38 is the discovery, `FactWriteTest` the guard. Three clocks, not one: `observed_at` is when the value was
  true of the world, `updated_at` when this row was last restated, `expires_at` its deadline.
- **The attribute is part of the contract.** A fact is found by `(subject, attribute)`, so a write under a
  name no reader joins is invisible rather than wrong: `MerchantService` filed merchant price edits as
  `avg_price` while `MerchantCards`, the seed, `quality.sql` and `FactAttribute` all use `price`, which left
  the card citing a superseded number as its own provenance. `avg_price` is retired; `price` carries
  `{amount, currency, model[, band]}`.
- **Render contract:** `EntityCard.facts[]` and `ai_match.reasons[].fact_id` must resolve here; a bullet without a
  `fact_id` does not render.
- **Post-validation:** generated text is checked so each numeric/entity claim maps back to a fact; unmatched claims are
  stripped and counted in `hallucination_rate` (the top quality gate).
- Confidence floors: `<0.6` phrase as uncertain, `<0.4` omit + offer handoff; never upgraded for presentation.

## 8. Trigger-maintained full-text (§11)
`merchant_tsv`, `offering_tsv`, `chunk_tsv` BEFORE INSERT/UPDATE build `search_tsv` from name/description/tags fields
(`'simple'` config). `set_updated_at()` fires on the listed mutable tables. These guarantees mean callers never hand-
maintain indexes.

## 9. Two DB roles — the grant split ([`API_CONTRACT.md`](API_CONTRACT.md) §0, §52)

| Role | Used by | Rights |
|---|---|---|
| **`nexus_app`** | `services/platform` | full read-write on commerce tables (users, merchants, offerings, carts, orders, reservations, payments, reviews, conversations, events, notifications, growth, admin). **Sole writer** of cart/order/reservation/payment/merchant state. |
| **`nexus_ai`** | `apps/ai` | **SELECT** on merchants/offerings/locations/reviews/facts/business_hours/availability_slots; **read-write** only on `documents, chunks, facts, recommendation_sets, feedback_events, agent_runs, llm_calls, eval_*, review_summaries, seo_pages, campaigns`. |

Rule: the AI service cannot mutate commerce-core rows directly. When an agent must create a cart / reservation / order,
it calls the platform HTTP API with a scoped token ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3). This is the structural
guarantee behind "no `LLM → database`" (§52): the *role* makes the forbidden path physically impossible, not just
discouraged.

**Correction (2026-09-23):** the paragraph this section used to carry said the split was "currently only a
documented convention" and that `nexus_app`/`nexus_ai` had to be created by a future `V2__roles_grants.sql`. Both
halves were stale. `infra/postgres/init/00_roles.sql` creates the roles, revokes everything from `nexus_ai`, then
grants the §0 SELECT set and the read-write set table by table (fail-closed: an unknown table gets nothing), and
`db_apply_migrations.sh` re-applies it. The `V2` migration is `V2__integrity.sql` — constraints, not grants.

**Third credential: the one that migrates.** `nexus_app` used to hold `CREATE` on the schema while owning no table,
so it could make a new object but not `ALTER` one — `42501 must be owner of table …`. V3 got through only because
`db_apply_migrations.sh` hands *view* ownership to the app role. `V4__tenant_scoped_identity.sql` was the first
migration that had to change a table, and it failed the boot in both the host launcher and `infra/docker-compose.yml`,
which had `SPRING_FLYWAY_USER: nexus_app`. Flyway now runs as the infra superuser in dev (`NEXUS_MIGRATION_DB_*`,
defaulting to `postgres` + `NEXUS_DB_ROOT_PASSWORD` from the gitignored `.env`) while the runtime datasource stays
`nexus_app`: the credential that changes schema is not the credential that serves requests
([`DECISIONS.md`](DECISIONS.md) D30). And since the runtime role never needed that `CREATE` for anything the split
did not already remove, it is revoked (`USAGE` only, matching `nexus_ai`) — the grant and the revoke both live in
`00_roles.sql`, which `db_apply_migrations.sh` re-applies, so fresh and existing databases land in the same place
(D32).

**Two ledgers, and a third state that has neither.** `schema_migrations` (written by `db_apply_migrations.sh`) and
`flyway_schema_history` (written by the service at boot) are independent, and `nexus_test` has *neither* — it runs
with `spring.flyway.enabled=false`, so whatever built its schema did so by hand. A database in that state used to
abort the infra script on `relation "tenants" already exists`, which also skipped the role grants further down. The
script now distinguishes the two failure classes and, for the first, prints the repair: `--record V<n>__<name>`
declares one migration applied without executing anything, after comparing the content against a database that is
genuinely migrated. That is how `nexus_test`'s four rows were obtained — 334 of 334 indexes and constraints match
`nexus` one for one, the only three deltas being Flyway's own bookkeeping objects — and D32 records why the
comparison stays manual instead of becoming an auto-detect.

## 10. ER overview (text, `PK`·`FK`)

```
tenants ─┬─< users ─┬─< user_identities
         │          ├─< user_preferences
         │          ├─< favorites / saved_searches
         │          └─< conversations >── messages ── agent_runs
         ├─< merchants ─┬─< merchant_users ── users
         │              ├─< permission_grants (subject_type=…)
         │              ├─< api_keys
         │              ├─< locations ─< business_hours
         │              ├─< merchant_categories >─ categories
         │              ├─< offerings ─┬─< offering_relations (graph)
         │              │              ├─< resource_pools ─< availability_slots
         │              │              └─< documents ─< chunks(embedding vector(1024), search_tsv)
         │              ├─< facts ── trust_signals
         │              ├─< reviews ── review_summaries
         │              ├─< reservations >─ availability_slots
         │              ├─< carts ─< cart_items ─┬─ offerings
         │              │                        └─ reservations
         │              ├─< orders ─< order_items ── offerings
         │              │      └─< payments ─< refunds
         │              ├─< coupons / campaigns / subscriptions
         │              ├─< collections / guides (as kind)
         │              ├─< agent_profiles / external_principals
         │              └─< seo_pages
         ├─< recommendation_sets ── feedback_events
         ├─< events (bigserial, event_id uniq)
         ├─< notifications
         └─< moderation_cases / audit_logs / rate_limit_buckets / idempotency_keys / deletion_requests
eval_suites ─< eval_cases ; eval_runs >─ eval_suites
agent_runs ─< llm_calls ; agent_runs.parent_run_id ──> agent_runs
```

Analytics **views** (§56, §161–§162): `v_merchant_funnel` (views/clicks/actions/reservations/orders/revenue per merchant
from `events` + `reservations` + `orders`) and `v_north_star` (searches vs fulfilled_intents per day/tenant from
`events`). These are live Postgres views in phase 1 and a first candidate to pre-aggregate / move to a warehouse at scale
([ARCHITECTURE.md](ARCHITECTURE.md) §9, §121).

## 11. Constraints deliberately *not* in V1 (deferred, tracked)
Pool double-booking exclusion constraint on `availability_slots` (needs `btree_gist` — present as extension but unused);
RLS policies; a real CJK text-search config; CHECK constraints on money > 0. All are intentional to keep V1 reviewable;
each is a M0/M2 task.

## Open questions / risks
- **Roles/grants unprovisioned** (§9) — the security model depends on them; must land in V2.
- **No RLS** — tenancy correctness rests entirely on disciplined repository code; single-miss = leak at scale.
- **`tsvector('simple')` for Chinese** — likely weak zh-HK recall; decide in M2 whether to ship a CJK parser or a
  `SearchBackend` engine before the vertical slice is "real".
- **`recommendation_sets.items` jsonb vs. facts:** storing explanations/fact_ids as jsonb is fast but cannot enforce that
  every cited `fact_id` still exists; consider an FK-checked join table if integrity drifts.
- **Availability exclusion constraint absent** → phase-1 booking may oversell a pool; add before real reservations (§40).
- **Embedding dim 1024 is baked** into the HNSW index; any model swap is a migration, not config (D3) — verify the chosen
  embedder is available under `NEXUS_LLM_PROVIDER=mock`/real before committing at scale.
