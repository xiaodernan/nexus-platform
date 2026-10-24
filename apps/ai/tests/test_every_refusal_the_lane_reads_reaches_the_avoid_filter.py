"""D546 - every refusal the refusal lane reads reaches the avoid filter, and the filter
reads the column the corpus writes the fact in.

Two defects in one lane, both the D488 shape (the same fact read by two readers, one of
them the raw string) and both measured at HEAD:

1. `plan_from_intent` mapped THREE keys into `plan.avoid` - `cuisine_avoid`, plus the
   caller's own `avoid` / `exclude` - out of the FIVE the refusal lane writes. A sentence
   the lane read therefore arrived at the plan with its refusal already dropped: measured,
   "唔食花生" wrote `diet_avoid:peanut` and the plan carried `avoid == []`; so did
   "no gluten", "唔好嘈" and "唔想排隊". The corpus carries what those words name -
   1,380 active offerings carry a `gluten` allergen tag and 57 a `peanut` one - so the
   product read the refusal and then threw it away between the Intent and the SQL.

2. Even the keys that DID reach `plan.avoid` were read by a clause that never looked at
   the column the corpus writes the fact in. `avoid_terms` expands a word into the
   taxonomy's leaves, which is right for a CUISINE (the merchant's `tags` and
   `category_primary`), but an ingredient is recorded per OFFERING, in
   `offerings.attributes->'allergens'`. Measured on the live corpus, `avoid=["gluten"]`
   excluded **0 of 470** published merchants and **0 of 4,707** active offerings, while
   269 merchants and 1,380 offerings carry the tag. The clause read the merchant's tags,
   the merchant's category and the offering's NAME - and an allergen is in none of them.

The fix is two halves of one rule: the planner DERIVES its key set from the lexicon's own
`CONSTRAINT_RULES` instead of hand-copying three of the five keys out of it (so a rule
added to the table reaches the filter by construction rather than because somebody
remembered a tuple), and both lanes' avoid clauses read the allergen column beside the
tags they already read.

Proved to fail: the three-key tuple restored reddens the census, the allergen leg deleted
reddens the column gate, and the canon call dropped reddens the surface test.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.contract import Intent
from nexus_ai.nlu.lexicon import CONSTRAINT_RULES, canon_constraint
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search import sql as S
from nexus_ai.search.service import (AVOID_CONSTRAINT_KEYS, DEFAULT_TENANT_ID,
                                     plan_from_intent)

TENANT = DEFAULT_TENANT_ID
SEED_QUERY = "\u6435\u9910\u5ef3"          # a query that is a discovery, so the intent is stable

#: every (key, surface) pair the refusal lane carries, straight from its own table.
PAIRS = [(key, surface) for key, _negations, values in CONSTRAINT_RULES for surface in values]
RULE_KEYS = [key for key, _negations, _values in CONSTRAINT_RULES]


def _plan(constraints, filters=None):
    d = extract_intent_dict(SEED_QUERY)
    d["constraints"] = constraints
    return plan_from_intent(Intent.model_validate(d), query=SEED_QUERY, filters=filters)


# ------------------------------------------------------------------ the planner
@pytest.mark.parametrize("key,surface", PAIRS, ids=[f"{k}:{s}" for k, s in PAIRS])
def test_every_key_and_surface_the_lane_carries_reaches_the_plan(key, surface):
    """The census: every refusal the lane can write lands its value in the plan's avoid
    list, under the canon's name. This is the whole table, not a sample - a key the
    planner drops is a refusal the user stated and the answer ignores."""
    plan = _plan([{"key": key, "value": surface}])
    assert canon_constraint(surface) in plan.avoid, (
        f"the lane writes {key}:{surface} and the plan carried {plan.avoid} - the refusal "
        f"was read and then dropped between the Intent and the SQL")


def test_the_planners_key_set_is_the_rules_own_and_nothing_else():
    """A hand-written tuple is a copy that goes stale; the set is the table's."""
    assert AVOID_CONSTRAINT_KEYS == frozenset({"avoid", "exclude", *RULE_KEYS}), (
        f"the planner maps {sorted(AVOID_CONSTRAINT_KEYS)} - the refusal lane writes "
        f"{sorted(RULE_KEYS)}")


def test_a_key_the_lane_never_writes_is_not_mapped():
    plan = _plan([{"key": "budget", "value": "cheap"}])
    assert plan.avoid == [], (
        f"a constraint the lane never writes reached the avoid list: {plan.avoid}")


def test_a_surface_form_is_canonicalised_by_the_planner():
    """The value goes through the ONE canon reader, so a caller who hands the planner a
    surface form gets the term set the lane's own reading writes (D545)."""
    plan = _plan([{"key": "cuisine_avoid", "value": "\u8fa3"}])
    assert plan.avoid == ["spicy"], (
        f"the planner bound the raw surface {plan.avoid} - the corpus writes its tags in "
        f"English, so a value in another script is one the avoid clause can never match")


def test_two_spellings_of_one_refusal_are_written_once():
    plan = _plan([{"key": "diet_avoid", "value": "\u82b1\u751f"},
                  {"key": "diet_avoid", "value": "peanut"}])
    assert plan.avoid == ["peanut"], (
        f"one refusal written twice under two names: {plan.avoid}")


def test_the_callers_own_avoid_still_merges_with_the_constraints():
    plan = _plan([{"key": "diet_avoid", "value": "gluten"}], filters={"avoid": ["pork"]})
    assert plan.filters.get("avoid") == ["pork", "gluten"], (
        f"the caller's hard filter and the intent's refusal did not merge: "
        f"{plan.filters.get('avoid')}")


# ------------------------------------------------------------------ the SQL
@pytest.mark.parametrize("lane,build", [
    ("merchant", S.build_merchant_query),
    ("offering", S.build_offering_query),
], ids=["merchant", "offering"])
def test_the_avoid_clause_reads_the_allergen_column(lane, build):
    """The corpus records an ingredient per offering; a clause that never reads that
    column cannot exclude a row for it."""
    kw = {"text": "", "filters": {"avoid": ["gluten"]}}
    if lane == "merchant":
        kw["embedding"] = None
    q = build(tenant_id=TENANT, **kw)
    assert "allergens" in q.sql, (
        f"the {lane} lane's avoid clause never reads the allergen column, so the one place "
        f"the corpus records an ingredient is invisible to it")


def test_the_two_lanes_read_the_same_column_and_bind_the_same_terms():
    m = S.build_merchant_query(tenant_id=TENANT, text="", embedding=None,
                               filters={"avoid": ["gluten"]})
    o = S.build_offering_query(tenant_id=TENANT, text="", filters={"avoid": ["gluten"]})
    assert [p for p in m.params if isinstance(p, list)] == \
           [p for p in o.params if isinstance(p, list)]


def test_a_word_with_no_allergen_meaning_still_binds_its_own_spellings():
    """`noise` names no tag the corpus writes; the reader must not invent one, and it
    must not drop the word either - it is still a word a merchant may carry."""
    q = S.build_merchant_query(tenant_id=TENANT, text="", embedding=None,
                               filters={"avoid": ["noise"]})
    assert ["noise"] in q.params, (
        f"the avoid clause bound {q.params} for a word the corpus does not tag")


# ------------------------------------------------------------------ the live corpus
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


@pytest.mark.integration
@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_every_allergen_the_corpus_writes_is_excluded_by_the_avoid_filter(live_settings):
    """The population is DERIVED from the corpus: every allergen tag a live offering
    carries has to be excluded by the lane that reads it, in both lanes - and the filter
    has to actually remove something, or the measurement is vacuous."""
    import asyncio

    from nexus_ai.db import pool as db_pool

    BIG = 100000

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            tags = [r["tag"] for r in await db.readonly(
                "select distinct value as tag from offerings, "
                "jsonb_array_elements_text(coalesce(attributes->'allergens','[]'::jsonb)) "
                "where tenant_id = $1 and status = 'active' order by 1", TENANT)]
            assert tags, "the corpus carries no allergen tags - this measurement is empty"
            for tag in tags:
                avoid = {"avoid": [tag]}
                m_kept = await _rows(db, S.build_merchant_query(
                    tenant_id=TENANT, text="", embedding=None, filters=avoid, limit=BIG))
                o_kept = await _rows(db, S.build_offering_query(
                    tenant_id=TENANT, text="", filters=avoid, limit=BIG))
                m_all = await _count(db, S.build_merchant_query(
                    tenant_id=TENANT, text="", embedding=None, filters={}, limit=BIG))
                o_all = await _count(db, S.build_offering_query(
                    tenant_id=TENANT, text="", filters={}, limit=BIG))
                bad_offerings = [r for r in o_kept
                                 if tag in ((r.get("attributes") or {}).get("allergens") or [])]
                ids = [r["id"] for r in m_kept]
                bad_merchants = 0
                if ids:
                    bad_merchants = int((await db.readonly(
                        "select count(*) as n from offerings where merchant_id = any($1::uuid[]) "
                        "and coalesce(attributes->'allergens','[]'::jsonb) ?| $2::text[]",
                        ids, [tag]))[0]["n"])
                assert len(m_kept) < m_all, (
                    f"avoid=[{tag!r}] excluded none of {m_all} published merchants")
                assert len(o_kept) < o_all, (
                    f"avoid=[{tag!r}] excluded none of {o_all} active offerings")
                assert not bad_offerings, (
                    f"{len(bad_offerings)} offerings survived avoid=[{tag!r}] while "
                    f"carrying the tag")
                assert bad_merchants == 0, (
                    f"{bad_merchants} merchants survived avoid=[{tag!r}] while one of "
                    f"their offerings carries the tag")
        finally:
            await db_pool.dispose()

    asyncio.run(_go())


async def _rows(db, q):
    return await db.readonly(q.sql, *q.params)


async def _count(db, q):
    rows = await db.readonly("select count(*) n from (" + q.sql + ") s", *q.params)
    return int(rows[0]["n"])
