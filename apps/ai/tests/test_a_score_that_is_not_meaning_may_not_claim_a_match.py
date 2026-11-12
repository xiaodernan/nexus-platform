"""A score that is not meaning may not claim a match.

`relevance` answers one question - does this row answer the query's words? - and the lane had two
witnesses for it: the keyword score and the vector cosine, fused as
`max(kw, vec) + 0.35*min(kw, vec)`. That fusion treats the two as the same kind of evidence, and they
are not. The offline adapter is `HashingEmbedding`, a signed bag-of-ngrams projection: its cosine
measures SHARED SURFACE TOKENS, which is precisely what the keyword lane measures - better, with
ts_rank + trigram + containment over name, description and tags, and with a `text_matched` verdict
attached. The adapter has said so in `health()` (`semantic: False`) since it was written, and nothing
in the search lane read that verdict.

Measured on the published plane (470 merchants, 11:00 HKT Thursday, `tmp/d705_measure.py`):

    request          rows with kw 0   vec on those rows   what the cosine decided
    想食日本嘢       8 of 8           0.060 - 0.100       Italian steakhouses, no japanese shop
    想食日式         8 of 8           0.073 - 0.108       Ramen 1st, four Sushi in eight
    附近有咩好推介   8 of 8           0.061 - 0.064       a different eight from the same noise

`想食日本嘢` and `想食日式` are the same request in two spellings, the same plan and the same pool -
and they answered unrelated pages, because the two spellings hash to different noise. The cosine was
worth 0.34 x 0.10 of the score; a preference the user TYPED in the same query is worth 0.06 x 0.5. So
noise outranked the user's own words.

The rule this file holds: a witness that cannot say what its score MEANS may not testify louder than
the one that can. On a non-semantic space the cosine is capped by `kw` - it refines a keyword match and
can never create one - and the candidate cut in `sql.py` reads the same rule, because that cut happens
BEFORE any preference is scored and chooses which `max(60, limit*3)` rows ever reach the scorer.

Measured after the fix (`tmp/d705_diff.py`, `tmp/d705_arms.py`): the page with the lane asked-for and
not testifying is the vector-off page on all 15 measured requests, while the old fusion moved 56-59 of
60 positions and brought in up to 30 different rows on one query. One Thai swap survives at weight
0.35*min(kw,vec), where both rows matched the keyword lane and the cosine merely agreed - the refining
role the lane keeps.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone

import pytest

import nexus_ai.search.service as S
from nexus_ai.api.pipeline import validate_intent
from nexus_ai.models.embeddings import DIM, HashingEmbedding, HttpEmbedding
from nexus_ai.nlu.understand import extract_intent
from nexus_ai.search.sql import build_merchant_query

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
NOW = datetime(2026, 11, 5, 3, 0, tzinfo=timezone.utc)   # 11:00 in Hong Kong, a Thursday
TENANT = "00000000-0000-0000-0000-000000000001"


# ------------------------------------------------------------------ what the adapters say
def test_the_hashing_adapter_declares_itself_not_semantic():
    assert HashingEmbedding().semantic is False


def test_the_http_adapter_declares_itself_semantic():
    adapter = HttpEmbedding(base_url="http://example.invalid", api_key="k")
    assert adapter.semantic is True


@pytest.mark.parametrize("adapter", [HashingEmbedding(),
                                     HttpEmbedding(base_url="http://example.invalid", api_key="k")])
def test_health_reports_the_attribute_rather_than_a_second_opinion(adapter):
    # one source of truth: the search lane reads the attribute without an await, and the
    # health endpoint must not be able to disagree with what the lane acted on.
    health = asyncio.run(adapter.health())
    assert health["semantic"] is adapter.semantic, health


# ------------------------------------------------------------------ the fusion
def test_a_semantic_cosine_may_stand_alone():
    # the paraphrase-recall path AGENT_CONTRACT §6 promises: a row whose words do not
    # match the query but whose meaning does. This unit must not touch it.
    assert S._relevance({"kw_score": 0.0, "vec_score": 0.10}, vector_lane=True,
                        semantic=True) == 0.10


def test_a_non_semantic_cosine_alone_claims_nothing():
    assert S._relevance({"kw_score": 0.0, "vec_score": 0.10}, vector_lane=True,
                        semantic=False) == 0.0


def test_a_non_semantic_cosine_may_refine_a_keyword_match():
    got = S._relevance({"kw_score": 0.333, "vec_score": 0.102}, vector_lane=True,
                       semantic=False)
    assert got == pytest.approx(0.333 + 0.35 * 0.102, abs=1e-4), got


def test_a_non_semantic_cosine_may_not_testify_louder_than_the_keyword_lane():
    # 0.9 of cosine against 0.333 of keyword: the capped reading is kw + 0.35*kw, not
    # 0.9 + 0.35*0.333.
    got = S._relevance({"kw_score": 0.333, "vec_score": 0.9}, vector_lane=True,
                       semantic=False)
    assert got == pytest.approx(0.333 + 0.35 * 0.333, abs=1e-4), got
    assert got < 0.9


def test_the_semantic_fusion_is_unchanged():
    assert S._relevance({"kw_score": 0.8, "vec_score": 0.4}, vector_lane=True) == 0.94


@pytest.mark.parametrize("semantic", [True, False])
def test_the_cosine_is_unread_outside_the_lane(semantic):
    assert S._relevance({"kw_score": 0.8, "vec_score": 0.4}, vector_lane=False,
                        semantic=semantic) == 0.8


# ------------------------------------------------------------------ the candidate cut
def _order_by(sql: str) -> str:
    return sql.split("ORDER BY", 1)[1].split("LIMIT", 1)[0]


def _query(**kw):
    base = dict(tenant_id=TENANT, text="日本嘢", embedding=[0.0] * DIM, limit=60)
    base.update(kw)
    return build_merchant_query(**base)


def test_a_semantic_cosine_orders_the_cut():
    # `kw_score` is itself a GREATEST over the keyword legs, so the discriminator is the
    # VECTOR arm of the cut, not the word GREATEST.
    assert "COALESCE(vv.vec_score" in _order_by(_query(vector_semantic=True).sql)


def test_a_non_semantic_cosine_does_not_choose_the_candidates():
    got = _order_by(_query(vector_semantic=False).sql)
    assert "COALESCE(vv.vec_score" not in got, got
    assert "vec_score" not in got, got


def test_the_lane_is_still_read_when_it_may_not_choose():
    # the row still carries `vec_score` and the join still runs: the refining role needs it.
    sql = _query(vector_semantic=False).sql
    assert "AS vec_score" in sql
    assert "chunks c" in sql


def test_the_cut_of_a_non_semantic_lane_is_the_cut_of_no_lane():
    asked = _order_by(_query(vector_semantic=False).sql)
    off = _order_by(_query(embedding=None).sql)
    assert asked == off, (asked, off)


def test_the_cut_is_ordered_by_the_cuisine_the_request_typed():
    # the cut runs before any preference is scored, so a typed cuisine has to reach it as an
    # ORDER term. Measured without this: 3 Korean shops answered 「韓式餐廳」 while the plane
    # holds 13, because `kw_score` is 0 on every row and the cap was the top-rated 60.
    q = _query(embedding=None, cuisine_slugs=["korean"])
    order = _order_by(q.sql)
    assert "merchant_categories" in order, order
    flat = [str(x) for p in q.params for x in (p if isinstance(p, list) else [p])]
    assert "korean" in flat, q.params
    # ahead of the keyword score, so the cuisine rows are inside the cap at all.
    assert order.index("merchant_categories") < order.index("search_tsv"), order


def test_an_untyped_request_pays_nothing_for_the_cuisine_leg():
    q = _query(embedding=None)
    assert "merchant_categories" not in _order_by(q.sql)
    assert q.params == _query(embedding=None, cuisine_slugs=None).params


# ------------------------------------------------------------------ the row -> Candidate map
def _cand(row, *, vector_lane, vector_semantic, typed_cuisine=None):
    return S.candidates_from_rows(
        [dict(row, subject_type="merchant", subject_id="m1", merchant_id="m1")],
        S.SearchPlan(party_size=2), bundle=None, facts_by_subject={},
        hours_by_merchant={}, slots_by_merchant={}, personalization={},
        weights=S.RankingWeights(), vector_lane=vector_lane,
        vector_semantic=vector_semantic, typed_cuisine=typed_cuisine)[0]


@pytest.mark.parametrize("vector_semantic,expected", [(True, 0.1), (False, 0.0)])
def test_the_map_hands_the_verdict_to_the_fusion(vector_semantic, expected):
    cand = _cand({"kw_score": 0.0, "vec_score": 0.1}, vector_lane=True,
                 vector_semantic=vector_semantic)
    assert cand.relevance == expected, cand.relevance


def test_a_cuisine_the_user_typed_is_request_weight_not_a_memory():
    # it landed in `personalization` - 0.06, the feedback EMA's weight - so the page needed a
    # 0.05-0.15 cosine to find a cuisine the corpus never spells (`kw` 0 on every row of
    # 泰式餐廳 / 韓式餐廳 / 日式料理, measured). At relevance it needs nothing else.
    cand = _cand({"kw_score": 0.0, "vec_score": 0.0}, vector_lane=False,
                 vector_semantic=False, typed_cuisine={"m1": 1.0})
    assert cand.relevance == 1.0, cand.relevance


def test_a_row_the_typed_cuisine_does_not_name_keeps_its_own_score():
    cand = _cand({"kw_score": 0.42, "vec_score": 0.0}, vector_lane=False,
                 vector_semantic=False, typed_cuisine={"someone-else": 1.0})
    assert cand.relevance == 0.42, cand.relevance


# ------------------------------------------------------------------ the pipeline's own verdict
class _Recording(S.StaticBackend):
    """The fixture backend, wearing the live lane's name so `vector_lane` can be true."""

    name = "postgres"

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.seen: list[dict] = []

    async def merchant_candidates(self, **kw):
        self.seen.append(dict(kw))
        return await super().merchant_candidates(**kw)


class _StubDeps:
    def __init__(self, backend, adapter):
        self._backend, self._adapter = backend, adapter

    def backend(self):
        return self._backend

    def embeddings(self):
        return self._adapter

    def tenant_id(self):
        return TENANT

    def backend_degraded(self):
        return False


class _SemanticAdapter:
    name, dim, semantic = "http", DIM, True

    async def embed(self, texts):
        return [[0.01] * self.dim for _ in texts]

    async def health(self):
        return {"provider": self.name, "ok": True, "dim": self.dim, "semantic": self.semantic}


def _search_page(adapter, sentence="想食日本嘢"):
    backend = _Recording()
    deps = _StubDeps(backend, adapter)
    intent = validate_intent(extract_intent(sentence, {"now": NOW}).to_dict())
    asyncio.run(__import__("nexus_ai.api.pipeline", fromlist=["run_search"]).run_search(
        deps, intent, query=sentence, now=NOW, limit=8))
    return backend.seen[0]


def test_the_pipeline_carries_the_hashing_verdict_to_the_lane():
    seen = _search_page(HashingEmbedding())
    assert seen.get("vector_semantic") is False, seen.keys()


def test_the_pipeline_carries_a_semantic_verdict_to_the_lane():
    seen = _search_page(_SemanticAdapter())
    assert seen.get("vector_semantic") is True, seen.keys()


# ------------------------------------------------------------------ the page a user sees
@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)
    JP = {"Sushi & Sashimi", "Ramen & Noodles", "Izakaya"}

    async def _page(live, deps, sentence, *, embedding=None, vector_lane=False,
                    vector_semantic=True, limit=8):
        it = validate_intent(extract_intent(sentence, {"now": NOW}).to_dict())
        plan = S.plan_from_intent(it, query=sentence, now=NOW, limit=limit)
        prefs = [p.model_dump() for p in it.preferences]
        _c, _r, _b, scored = await S.search(
            backend=live, plan=plan, intent_preferences=prefs, embedding=embedding,
            vector_lane=vector_lane, vector_semantic=vector_semantic, locale="zh-HK")
        return scored

    async def _go():
        await db_pool.connect(st, force_new=True)
        try:
            deps = Deps(st)
            live = deps.backend()
            out = {}
            for sentence in ("想食日本嘢", "想食日式", "附近有咩好推介", "素食", "想食泰國嘢"):
                it = validate_intent(extract_intent(sentence, {"now": NOW}).to_dict())
                plan = S.plan_from_intent(it, query=sentence, now=NOW, limit=8)
                vec = ((await deps.embeddings().embed([plan.match_text]))[0]
                       if plan.match_text else None)
                asked = await _page(live, deps, sentence, embedding=vec,
                                    vector_lane=bool(vec), vector_semantic=False)
                off = await _page(live, deps, sentence, embedding=None, vector_lane=False)
                old = await _page(live, deps, sentence, embedding=vec,
                                  vector_lane=bool(vec), vector_semantic=True)
                def key(rows):
                    return [s.candidate.subject_id for s in rows]
                out[sentence] = {
                    "asked": key(asked), "off": key(off), "old": key(old),
                    "first": asked[0].candidate.category if asked else None,
                    "japanese": sum(1 for s in asked if s.candidate.category in JP),
                    "old_japanese": sum(1 for s in old if s.candidate.category in JP),
                }
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_page_leads_with_the_cuisine_the_user_typed(plane):
    got = plane["想食日本嘢"]
    assert got["first"] in {"Sushi & Sashimi", "Ramen & Noodles", "Izakaya"}, got


def test_two_spellings_of_one_request_no_longer_diverge(plane):
    # the sharpenest statement of the defect: same plan, same pool, different noise.
    assert plane["想食日本嘢"]["asked"] == plane["想食日式"]["asked"], (
        plane["想食日本嘢"]["asked"], plane["想食日式"]["asked"])


#: every request measured. The first four are the ones where the keyword lane matched
#: NOTHING (every row `kw` 0); 想食泰國嘢 is the one where it DID (0.333 on the Thai rows)
#: and the typed cuisine lifts those rows to relevance 1.0.
MEASURED = ["想食日本嘢", "想食日式", "附近有咩好推介", "素食", "想食泰國嘢"]


@pytest.mark.parametrize("sentence", MEASURED)
def test_a_lane_that_cannot_testify_does_not_move_the_page(plane, sentence):
    got = plane[sentence]
    assert got["asked"] == got["off"], (got["asked"], got["off"])


def test_a_cuisine_the_user_typed_orders_the_page_and_the_cosine_does_not(plane):
    # 想食泰國嘢: the typed cuisine puts the Thai rows at relevance 1.0, so the page is the
    # same one the vector-off lane answers. The unit legs above still pin the refining role
    # (a capped cosine may lift a keyword match); what died here is the cosine's vote on a
    # page the request itself can order.
    got = plane["想食泰國嘢"]
    assert got["first"] == "Thai", got
    assert got["asked"] == got["off"], (got["asked"], got["off"])


class _VecFixture(S.StaticBackend):
    """Rows with kw=0 and a hand-set vec, wearing the vector lane's name."""

    VEC: dict = {}

    async def merchant_candidates(self, **kwargs):
        out = await super().merchant_candidates(**kwargs)
        return [dict(r, vec_score=self.VEC.get(r["subject_id"], 0.0)) for r in out]


def test_the_old_fusion_is_what_moved_these_pages():
    """Falsification with a witness that cannot tie.

    Measured before the fix (`tmp/d780_fusion.py`, 2026-11-12): on every measured sentence the
    live (HashingEmbedding) lane produced 0.0 cosine for every row, so the capped and the
    ignoring lanes ordered the page identically and this leg could never fail - the exact law
    this file exists for. On a fixture where cosine is real and keyword is absent, the same
    query MUST order differently between "the verdict is carried" (non-semantic cosine capped
    by kw=0) and "the verdict is ignored" (semantic cosine stands alone and orders on noise).
    """
    import asyncio

    rows = [
        {"subject_id": rid, "merchant_id": rid, "display_name": rid, "display_name_zh": rid,
         "category_primary": "cafe", "avg_price_hkd": 50.0, "rating_agg": rating,
         "review_count": 5, "tags": [], "attributes": {}, "data_origin": "demo"}
        for rid, rating in (("r-a", 4.0), ("r-b", 4.4), ("r-c", 4.8))
    ]
    # Cosine strictly ANTI-correlated with rating in ascending order of marker id: with the
    # verdict carried, relevance is 0.0 everywhere and the page orders by rating (r-c, r-b, r-a);
    # with it ignored, relevance orders by the cosine (r-a, r-b, r-c) and the pages must differ.
    backend = _VecFixture(merchants=rows)
    backend.VEC = {"r-a": 0.14, "r-b": 0.09, "r-c": 0.06}

    def _page(vector_semantic):
        plan = S.SearchPlan(query_text="zzqxy", filters={}, limit=10,
                            subject_types=("merchant",))
        _cards, _resp, _b, scored = asyncio.run(S.search(
            backend=backend, plan=plan, vector_lane=True,
            vector_semantic=vector_semantic, locale="zh-HK"))
        return [s.candidate.subject_id for s in scored]

    ignored = _page(True)
    carried = _page(False)
    assert ignored == ["r-a", "r-b", "r-c"], (
        f"with the verdict ignored the cosine orders the page: {ignored}")
    assert carried == ["r-c", "r-b", "r-a"], (
        f"with the verdict carried no cosine may stand on its own: {carried}")
