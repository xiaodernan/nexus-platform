"""D357 — request-pipeline pure helpers contract (§105, §4, §7.1).

Pins the DB-free, network-free helpers in `api/pipeline.py` that the search/recommend/
stream endpoints share (§105: the stream's fallback target must be the *same* search,
minus the model layer). The async `understand`/`run_search`/`compose_summary` paths need
`Deps` (backend/router/embeddings) and are exercised by the endpoint/integration suites;
this unit locks the pure rules so a regression in the shared trust logic is caught without
a running Postgres.

Contract points locked:
* `MAX_QUERY_LENGTH == 200` (the same BFF cap before a model call is paid for);
* `validate_intent` (§7.1): a valid dict ⇒ `Intent`; non-dict ⇒ `None`; a dict missing
  required fields ⇒ `None`; an aliased foreign location/time shape (`near_me`, `none`)
  is recovered via `_alias_intent_shape` even though raw `Intent.model_validate` rejects it
  (§105: never answer with a half-trusted intent object);
* `_alias_intent_shape` is a non-mutating copy that maps `near_me`→`nearby` and
  `none`→`unspecified`, and leaves unaliased shapes untouched;
* `card_citations` (§4 grounding): walks cards, collects `fact_id`s, de-duplicates in
  encounter order, and caps at `per_card` facts per card.
"""

from __future__ import annotations

import copy

import pytest
from pydantic import ValidationError

from nexus_ai.api import pipeline as P
from nexus_ai.contract import Intent
from nexus_ai.nlu.understand import extract_intent_dict


def _valid_intent() -> dict:
    # the rule engine emits a §7.1-conformant dict — use it as the known-valid fixture
    d = extract_intent_dict("搵尖沙咀餐延", {})
    assert P.validate_intent(d) is not None
    return d


class TestQueryLengthCap:
    def test_max_query_length(self):
        assert P.MAX_QUERY_LENGTH == 200


class TestValidateIntent:
    def test_valid_dict_returns_intent(self):
        result = P.validate_intent(_valid_intent())
        assert isinstance(result, Intent)
        assert result.raw_query == "搵尖沙咀餐延"

    def test_none_returns_none(self):
        assert P.validate_intent(None) is None

    def test_non_dict_returns_none(self):
        assert P.validate_intent("not a dict") is None

    def test_invalid_dict_returns_none(self):
        assert P.validate_intent({"bad": 1}) is None

    def test_alias_location_recovered(self):
        d = _valid_intent()
        if not d.get("location"):
            pytest.skip("fixture had no location to alias")
        d2 = copy.deepcopy(d)
        d2["location"]["type"] = "near_me"
        # raw §7.1 validation rejects the foreign shape...
        with pytest.raises(ValidationError):
            Intent.model_validate(d2)
        # ...but validate_intent recovers it via the alias map
        recovered = P.validate_intent(d2)
        assert recovered is not None
        assert recovered.location.type == "nearby"


class TestAliasIntentShape:
    def test_location_near_me_mapped(self):
        out = P._alias_intent_shape({"location": {"type": "near_me", "lat": 1.0}})
        assert out["location"]["type"] == "nearby"

    def test_time_none_mapped(self):
        out = P._alias_intent_shape({"time": {"type": "none"}})
        assert out["time"]["type"] == "unspecified"

    def test_unaliased_passthrough_and_copy(self):
        src = {"location": {"type": "district", "value": "X"}}
        out = P._alias_intent_shape(src)
        # returns an equal, top-level-distinct dict; the source is untouched by the call
        assert out == src
        assert out is not src
        assert src == {"location": {"type": "district", "value": "X"}}


class TestCardCitations:
    def test_dedup_and_per_card_cap(self):
        items = [
            {"facts": [{"fact_id": "f1"}, {"fact_id": "f2"}, {"fact_id": "f3"}]},
            {"facts": [{"fact_id": "f2"}, {"fact_id": "f4"}]},
            {"facts": []},
        ]
        assert P.card_citations(items) == ["f1", "f2", "f4"]

    def test_per_card_one(self):
        items = [
            {"facts": [{"fact_id": "f1"}, {"fact_id": "f2"}]},
            {"facts": [{"fact_id": "f2"}, {"fact_id": "f4"}]},
        ]
        assert P.card_citations(items, per_card=1) == ["f1", "f2"]

    def test_missing_facts_key_safe(self):
        assert P.card_citations([{"no_facts": True}, {"facts": None}]) == []

    def test_empty(self):
        assert P.card_citations([]) == []


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
