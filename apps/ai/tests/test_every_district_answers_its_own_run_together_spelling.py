"""Every district answered "tai wai" and "tai-wai" and none answered "taiwai".

`_fold_district_aliases` (`nlu/lexicon.py:985-1016`, D-something) folds each alias through the
product's one separator rule - `categories.canonical_tag` - so "Tai Wai" is reachable as `tai wai`
and `tai-wai`. The rule replaces the SPACE with a hyphen and never removes it, so the run-together
spelling a person types on a phone was unknown: three districts carried it BY HAND (`shatin`,
`mongkok`, `wanchai`) and the other 21 did not. Measured on the published plane (`tmp/d664_counts.py`):

    query            district filter   match text     pool (both lanes)
    tai wai          Tai Wai           ""             140
    tai-wai          Tai Wai           ""             140
    taiwai           none              "taiwai"       470  <- the whole plane
    maonshan         none              "maonshan"     470
    kowloonbay       none              "kowloonbay"   470
    causewaybay      none              "causewaybay"  470

470 is the whole published plane: since D658 the text is a SCORE, so a query with no matching word
answers everything, ranked by nothing. The user who typed the district as one word got the entire
catalogue where the spaced spelling answered the district.

The fix is one line of derivation, not 21 table rows: a Latin alias also publishes its run-together
spelling (the folded slug with the separators removed), so the table states the NAME once and the
spellings follow from the one rule. The hand-written `shatin`/`mongkok`/`wanchai` aliases stay (they
are what the table already shipped) and the gate checks them too.
"""

from __future__ import annotations

import os

import pytest

import nexus_ai.search.service as S
from nexus_ai.nlu.lexicon import DISTRICTS, match_district

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _latin_multiword():
    for name, spec in DISTRICTS.items():
        for alias in spec.get("aliases") or ():
            if alias.isascii() and " " in alias:
                yield name, alias


CASES = sorted(_latin_multiword())


@pytest.mark.parametrize("name,alias", CASES)
def test_a_district_answers_its_run_together_spelling(name, alias):
    compact = alias.replace(" ", "").replace("-", "")
    assert len(compact) >= 5, (name, alias, compact)
    got = match_district(compact)
    assert got is not None, (name, alias, compact)
    assert got[0] == name, (name, alias, compact, got[0])


@pytest.mark.parametrize("name,alias", CASES)
def test_the_table_publishes_the_run_together_alias(name, alias):
    compact = alias.replace(" ", "").replace("-", "")
    aliases = DISTRICTS[name]["aliases"]
    assert compact in aliases, (name, compact, aliases)


def test_the_plan_filters_the_district_and_does_not_search_the_word():
    from nexus_ai.nlu.understand import extract_intent

    plan = S.plan_from_intent(extract_intent("taiwai"), query="taiwai")
    assert plan.filters.get("district") == "Tai Wai", plan.filters
    assert plan.match_text == "", plan.match_text


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    import asyncio

    from nexus_ai.api.deps import Deps
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="", db_statement_timeout_ms=120000)

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            merchants = [dict(r) for r in await db.fetch("""
                select m.id::text as subject_id, m.id::text as merchant_id, m.display_name,
                       m.display_name_zh, m.description, m.category_primary, m.avg_price_hkd,
                       m.rating_agg, m.review_count, m.popularity_score, m.tags, m.attributes,
                       m.data_origin, m.images, m.plan, m.ai_agent_enabled,
                       coalesce((SELECT array_agg(DISTINCT lower(coalesce(l.district, '')))
                                 FROM locations l WHERE l.merchant_id = m.id),
                                '{}'::text[]) as districts,
                       coalesce((SELECT array_agg(DISTINCT s.slug)
                                 FROM merchant_categories mc2
                                 JOIN categories c2 ON c2.id = mc2.category_id
                                 LEFT JOIN categories pc2 ON pc2.id = c2.parent_id
                                 CROSS JOIN LATERAL (VALUES (c2.slug), (pc2.slug)) AS s(slug)
                                 WHERE mc2.merchant_id = m.id AND s.slug IS NOT NULL),
                                '{}'::text[]) as category_slugs
                from public.merchants m where m.status = 'published'""")]
            from nexus_ai.nlu.understand import extract_intent

            live = Deps(st).backend()
            out = {"merchants": len(merchants), "pools": {}}
            for spelling in ("taiwai", "tai wai", "tai-wai"):
                plan = S.plan_from_intent(extract_intent(spelling), query=spelling)
                pool = {}
                for lanename, backend in (
                    ("fixture", S.StaticBackend(merchants=merchants)),
                    ("live", live),
                ):
                    _c, resp, _b, _s = await S.search(backend=backend, plan=plan)
                    pool[lanename] = getattr(resp, "total_estimate", None)
                out["pools"][spelling] = pool
            return out
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_the_three_spellings_of_one_district_answer_one_pool(plane):
    pools = plane["pools"]
    compact, spaced, hyphen = (pools[k] for k in ("taiwai", "tai wai", "tai-wai"))
    assert compact == spaced == hyphen, pools
    assert compact["fixture"] == compact["live"], pools
    assert 0 < compact["live"] < plane["merchants"], (pools, plane["merchants"])
