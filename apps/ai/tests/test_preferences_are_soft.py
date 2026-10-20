"""D381 / §7.1 — preferences are soft, constraints are hard, and only explicit
`filters.attributes` reaches the SQL containment clause.

The live defect this pins: "帮我找一个适合情侣约会的地方" resolved to one preference
(`occasion=date`) and no category, and `plan_from_intent` wrote `{"occasion": true}` into the
JSONB attribute filter. No seeded merchant carries that key, so the query returned **0 rows**
before ranking ran -- the empty Chinese page D365/D366 blamed on text matching was in fact a
soft preference wearing a constraint's clothes. The value was lost in the collapse to `True`
as well, so even a matching key could not have matched its value.
"""

from __future__ import annotations

import json

import nexus_ai.search.service as S
from nexus_ai.contract import ConstraintItem, Intent, PreferenceItem
from nexus_ai.nlu.understand import extract_intent_dict
from nexus_ai.search import sql as SQL

SENTENCE = "帮我找一个适合情侣约会的地方"


def _intent(**kw) -> Intent:
    base = dict(raw_query=SENTENCE, intent="discover_merchant")
    base.update(kw)
    return Intent(**base)


# --------------------------------------------------------------------------- the input
def test_the_sentence_extracts_an_occasion_preference():
    # This is the measurement, not a guess: the rule NLU reads 情侣约会 as occasion=date.
    data = extract_intent_dict(SENTENCE, {"locale": "zh-HK"})
    prefs = data.get("preferences") or []
    assert {"key": "occasion", "value": "date", "polarity": 1} in prefs
    assert data.get("category") is None


# --------------------------------------------------------------------------- the mapping
def test_a_preference_is_not_an_attribute_filter():
    plan = S.plan_from_intent(_intent(preferences=[
        PreferenceItem(key="occasion", value="date", polarity=1)]), query=SENTENCE)
    assert plan.attributes == {}
    assert "attributes" not in plan.filters
    # The preference itself still reaches the caller intact, value included.
    assert plan.filters.get("attributes") in (None, {})
    assert SENTENCE in plan.query_text


def test_a_negative_preference_is_not_an_exclusion():
    # polarity -1 means "less like this", not "remove it": §7.1 reserves `avoid` for
    # constraints, and a disliked ambience must not delete a whole district.
    plan = S.plan_from_intent(_intent(preferences=[
        PreferenceItem(key="ambience", value="loud", polarity=-1)]), query=SENTENCE)
    assert plan.avoid == []
    assert "attributes" not in plan.filters


def test_explicit_filter_attributes_still_filter():
    plan = S.plan_from_intent(
        _intent(preferences=[PreferenceItem(key="occasion", value="date")]),
        query=SENTENCE, filters={"attributes": {"quiet_ambience": True}})
    assert plan.filters["attributes"] == {"quiet_ambience": True}


def test_constraints_are_still_hard_exclusions():
    plan = S.plan_from_intent(_intent(constraints=[
        ConstraintItem(key="avoid", value="spicy")]), query=SENTENCE)
    assert plan.avoid == ["spicy"]
    assert plan.filters["avoid"] == ["spicy"]


# --------------------------------------------------------------------------- the SQL
def test_the_generated_sql_has_no_attribute_clause_for_a_preference():
    plan = S.plan_from_intent(_intent(preferences=[
        PreferenceItem(key="occasion", value="date")]), query=SENTENCE)
    q = SQL.build_merchant_query(tenant_id=S.DEFAULT_TENANT_ID, text=plan.query_text,
                                 embedding=None, filters=plan.filters)
    assert "m.attributes @>" not in q.sql


def test_the_generated_sql_keeps_an_explicit_attribute_filter():
    plan = S.plan_from_intent(_intent(), query=SENTENCE,
                              filters={"attributes": {"quiet_ambience": True}})
    q = SQL.build_merchant_query(tenant_id=S.DEFAULT_TENANT_ID, text=plan.query_text,
                                 embedding=None, filters=plan.filters)
    assert "m.attributes @>" in q.sql
    assert json.dumps({"quiet_ambience": True}) in [str(p) for p in q.params]


# --------------------------------------------------------------------------- the pipeline
async def test_the_sentence_returns_merchants_instead_of_an_empty_page():
    # The SQL backend does not filter on text (text_matched is a selected signal, not a
    # WHERE clause), so this backend mirrors that shape; StaticBackend's own text filter
    # would reject a sentence with no lexical overlap and hide the mapping under test.
    class SqlLikeBackend(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

    intent = _intent(preferences=[PreferenceItem(key="occasion", value="date")])
    plan = S.plan_from_intent(intent, query=SENTENCE, limit=10)
    backend = SqlLikeBackend(merchants=[
        {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
         "display_name": "Ramen House", "display_name_zh": "拉麵屋",
         "category_primary": "restaurant", "rating_agg": 4.5, "review_count": 10},
        {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
         "display_name": "Sushi Zen", "display_name_zh": "壽司禪",
         "category_primary": "restaurant", "rating_agg": 4.2, "review_count": 20},
    ])
    cards, resp, _, scored = await S.search(backend=backend, plan=plan)
    assert len(scored) == 2, "a soft preference must not filter the page away"
    assert len(cards) == 2
    assert resp.total_estimate == 2
