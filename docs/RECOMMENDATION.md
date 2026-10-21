# NEXUS — Recommendation & Ranking (§17, §18, §66–§67, §98–§100, §113)

Status: **to be built.** Owner: `apps/ai/nexus_ai/recommend/**` (agents `ranking`, `recommendation` write
`recommendation_sets`; role `nexus_ai`). Authoritative scoring/sponsored rules: [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6;
trust/fact linkage: §4. Retrieval feeding candidates: [SEARCH.md](SEARCH.md); feedback→memory: [CONSUMER.md](CONSUMER.md),
[GROWTH.md](GROWTH.md).

## 1. Pipeline (§17)
```
candidate generation → filtering → ranking → LLM reasoning → recommendation
```
Candidate generation reuses hybrid search ([SEARCH.md](SEARCH.md) §3). Filtering applies hard constraints from the
`Intent` (budget, avoid-constraints, open-now, party_size fit). Ranking computes the score below. LLM reasoning writes the
explanation layer **only** — it may not invent ranking signals.

## 2. Scoring model (§17, §113, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6)
```
score = w_relevance*rel + w_quality*quality + w_distance*dist + w_price*price_fit
      + w_availability*avail + w_personalization*pers + w_popularity*pop + w_freshness*fresh
```
- Weights are **data**, in `infra/config/ranking_weights.yaml`, and the exact version is stamped into
  `recommendation_sets.strategy` (`hybrid_v1`) so any run is reproducible.
- **Quality = Bayesian-smoothed rating**, shrunk to the tenant mean by `n/(n+15)`, so a 5.0 with 2 reviews does not beat
  a 4.6 with 200 ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6). Backed by `merchants.rating_agg`/`review_count`.
- **Relevance floor** before scoring: candidates below the floor are dropped — popularity never ranks an irrelevant
  merchant higher (§67 "relevance first", [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6).
- Distance/price/availability/personalization/freshness come from `facts` + `locations` + `user_preferences`, not guesses.

## 3. Explanations (§18, §108)
Every recommendation must be explainable and traceable: `MatchExplanation{label, text, value, fact_id}`
([`API_CONTRACT.md`](API_CONTRACT.md) §2). Bullets are generated from the **top contributing features**, e.g.
`✓ 距離你 700m · ✓ 符合預算 HK$500 · ✓ 評分 4.7(200+) · ✓ 週六 19:00 有位`. The `recommendation` agent may not emit a bullet
without a `fact_id` ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1); if `fact_id` is missing the UI must not render it (§4).
Do not generate unverifiable reasons (§18).

## 4. Ranking integrity — sponsored separation (§66, §67)
Organic score is computed and **stored first**, and is **never** a function of plan or spend. Promoted slots are inserted
**afterwards** with `flags.sponsored=true`, visibly labelled, capped at **1 in the top 5**, and can never displace the
organic best match ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6). Monetization [GROWTH.md](GROWTH.md) may add placement;
it may not touch the organic formula (§67: paid promotion is separate from natural ranking).

## 5. Storage & surfaces
`POST /ai/v1/recommend {intent|conversation_id, limit}` → `{set_id, items:EntityCard[]}` with explanations + fact ids
([`API_CONTRACT.md`](API_CONTRACT.md) §7). Persisted to `recommendation_sets` (`intent jsonb`, `strategy`, `items
[{subject_type,subject_id,rank,score,explanations[],fact_ids[]}]`, `latency_ms`). Rails on the homepage (For You,
Trending, Recommended, Recently viewed, §6) read stored sets / denormalised `popularity_score`.

## 6. Learning loop & data flywheel (§98, §99, §100)
```
user intent → search → interaction → transaction → outcome → feedback → ranking improvement → recommendation improvement
```
Signals combine **explicit** (like/dislike/not_relevant/too_expensive/too_far/wrong_category) + **implicit** (click/
dwell) + **transaction outcome**, written to `feedback_events` and `events` ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §10).
Feedback updates personalization weights **slowly (EMA, min 3 signals)** and is **never** treated as ground truth alone
(§100, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §6). `user_preferences` (`source=inferred|transaction`) carry the durable
per-user model; the user can inspect/delete them (§32, §33).

## 7. Evaluation
`personalization_v1` + `search_relevance_v1` measure task success, precision@10, relevance nDCG and **hallucination rate**
(explanations citing non-existent facts count as hallucinations). Gate: hallucination < 2%, no task-success regression
>3pp ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11).

## Open questions / risks
- **Cold-start personalization:** with no `user_preferences` and no feedback, `w_personalization` contributes nothing;
  need an explicit default-fallback so "For You" isn't empty for new users (§33, §94).
- **Trending/popularity fairness:** `popularity_score` risks a rich-get-richer loop that suppresses new merchants in the
  launch district; needs freshness/boost control (§94 cold start).
- **Weight tuning is unvalidated** against real HK behaviour; `ranking_weights.yaml` v1 is a prior, and A/B via
  `recommendation_sets.strategy` (`hybrid_v2`) is the intended path — needs an experimentation harness not yet specced.
- **Feedback gaming:** `feedback_events` is user-writable via `/ai/v1/feedback`; needs abuse/rate limits so likes can't
  buy ranking (§53, [SECURITY.md](SECURITY.md)).
