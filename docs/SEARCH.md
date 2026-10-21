# NEXUS — Search (§13, §16, §113–§115)

Status: **to be built.** Hybrid retrieval + the `SearchBackend` seam. Ranking math lives in [RECOMMENDATION.md](RECOMMENDATION.md);
query understanding in [AI.md](AI.md); the four index mechanisms and their *why* in [DATABASE.md](DATABASE.md) §5.
Authoritative formulas: [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6; shapes: [`API_CONTRACT.md`](API_CONTRACT.md) §7.

## 1. Design principle (§13, §16)
Never vector-only. A candidate set is the union of **keyword ∪ vector ∪ metadata ∪ geo**, then ranked. The Search
Service sits behind a `SearchBackend` interface so PostgreSQL (phase 1) and OpenSearch/Elasticsearch (later) are
swappable without touching call sites (D3, [ARCHITECTURE.md](ARCHITECTURE.md) §7).

## 2. Ownership
- Interface `SearchBackend` + Postgres impl: `apps/ai/nexus_ai/search/{backend.py, sql.py}` (D3).
- Platform-side search (public merchant listing, facets): `services/platform/.../search/`.
- SQL text lives in those two places only — no scattered search queries.
- Endpoint: `POST /ai/v1/search {intent, geo?, filters?, limit}` → `{items:EntityCard[], facets, took_ms, strategy,
  degraded}` — **deterministic** (no LLM required), the failure-ladder floor ([`API_CONTRACT.md`](API_CONTRACT.md) §7,
  [AI.md](AI.md) §4).

## 3. Candidate generation
```
candidates = keyword(tsvector('simple') ∪ pg_trgm similarity)   # names, tags, menu items, fuzzy/typos
           ∪ vector (pgvector cosine on chunks.embedding, dim 1024)   # paraphrase/semantic
           ∪ geo (bbox range scan on locations(lat,lng) → haversine sort)   # §38, §39
           ∪ metadata filters (category, tags, attributes jsonb, price_band, open_now)
```
All filters applied with the **tenant predicate first** (D5) and only over `status='published'` merchants/`active`
offerings — the `search` agent must not return unpublished/suspended rows ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).

## 4. Ranking (see [RECOMMENDATION.md](RECOMMENDATION.md))
Score is a weighted linear blend (§113): relevance, quality (Bayesian-smoothed rating), distance, price fit,
availability, personalization, popularity, freshness — weights in `infra/config/ranking_weights.yaml`, versioned in
`recommendation_sets.strategy`. A **relevance floor** drops weak candidates *before* scoring so popularity never hides
irrelevance ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6).

## 5. Result types & facets (§115)
Unified result types: Merchant, Product, Service, Experience, Collection, Guide. Facets returned per request
(category, district, price_band, rating, open_now, attributes) for the filter UI.

## 6. Autocomplete (§114)
Prefix + fuzzy suggestions over `pg_trgm` indexes on `merchants.display_name` / `offerings.name` / tag vocabulary, plus
natural-language seeds ("适合带小孩的地方"). Served from `GET /api/v1/merchants?...`-style reads and cached (public,
cacheable, [`API_CONTRACT.md`](API_CONTRACT.md) §11) — but never autocomplete **availability** (§103).

## 7. Geo (§38, §39)
bbox prefilter (indexable btree on `lat,lng`) then haversine sort. **No PostGIS** in the pgvector image (D3) — see
[DATABASE.md](DATABASE.md) §5 for the trade-off and its 100x rewrite note. `search_location` and `location` agent enforce
consent before precise geo; coarse/district is the default ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).

## 8. Freshness & degradation
`/ai/v1/search` is pure SQL and must always work even when the LLM is down (failure ladder, §105). Price/availability in
cards come from `facts` with live TTL checks (§20); availability uses `cache_ttl_s=0` and is `no-store`. `degraded:true`
set whenever a fallback ran ([AI.md](AI.md) §4).

## 9. Evaluation
`search_relevance_v1` measures precision@10 and relevance nDCG against a labelled set; gate: **p95 `/ai/v1/search` <
250ms warm**, no relevance regression >3pp ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11, [AI.md](AI.md) §6). Every
change ships with a query→ground-truth→precision/relevance check (§156).

## Open questions / risks
- **Chinese full-text with `tsvector('simple')`** is the biggest known relevance risk for the primary market; the
  `SearchBackend` seam exists precisely to swap in an engine or CJK parser — decide in M2, don't discover late.
- **Union cardinality control:** combining four candidate sources can explode the candidate pool before the relevance
  floor; needs a per-source cap + merge/dedupe policy (specify in `sql.py`).
- **Embedding vs. freshness:** semantic candidates come from `chunks` (doc text), but a stale price in a chunk must not
  outrank a fresh offering fact — clarify whether vector candidates are offerings/docs or both.
- **Facet counts at scale** are expensive to compute exactly; approximate-count strategy undefined.
