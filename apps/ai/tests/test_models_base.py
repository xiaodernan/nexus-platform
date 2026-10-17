"""Contract tests for ``nexus_ai.models.base`` — the provider abstraction's pure, DB-free core.

This module holds the wire-agnostic request/response data, pricing, token estimation, locale
normalization, JSON coercion, record-extractors, and the credentials guard on ``HttpLLMAdapter``
(AGENT_CONTRACT §9, DECISIONS D4, §2 budget, §105 degrade). None of it touches a database, so the
whole surface is pinnable offline.

Every assertion was confirmed against the running module (empirical probe), never guessed.
Where a naive premise was wrong (``LLMResponse`` requires ``text``), the premise was corrected,
not the code.
"""

from __future__ import annotations

import nexus_ai.models.base as B


class TestEstimateTokens:
    def test_empty_is_zero(self):
        assert B.estimate_tokens("") == 0

    def test_short_latin_floors_at_one(self):
        # 5 latin chars -> 5//4 = 1, floored to 1
        assert B.estimate_tokens("hello") == 1
        # single latin char still counts as 1
        assert B.estimate_tokens("a") == 1

    def test_cjk_counts_one_per_char(self):
        assert B.estimate_tokens("你好") == 2

    def test_mixed_uses_cjk_plus_quarter_latin(self):
        # "hi你": 1 cjk + 2 latin (2//4 = 0) -> 1
        assert B.estimate_tokens("hi你") == 1

    def test_eight_latin_is_two(self):
        assert B.estimate_tokens("abcdefgh") == 2


class TestCostUsd:
    def test_cheap_tier_pricing(self):
        # (1000/1000*0.00025) + (1000/1000*0.00125) = 0.0015, quantized to 6dp
        assert B.cost_usd("cheap", 1000, 1000) == 0.0015

    def test_reason_tier_pricing(self):
        assert B.cost_usd("reason", 1000, 1000) == 0.09

    def test_unknown_tier_falls_back_to_mid(self):
        # not in PRICE_PER_1K -> defaults to "mid" (0.003 in)
        assert B.cost_usd("bogus", 1000, 0) == 0.003


class TestNormLocale:
    def test_english_variants(self):
        assert B.norm_locale("en") == "en"
        assert B.norm_locale("en-US") == "en"

    def test_simplified_chinese(self):
        assert B.norm_locale("zh-CN") == "zh-CN"
        assert B.norm_locale("zh-Hans") == "zh-CN"

    def test_hong_kong_chinese(self):
        assert B.norm_locale("zh-HK") == "zh-HK"

    def test_unknown_and_empty_default_to_zh_hk(self):
        assert B.norm_locale("fr") == "zh-HK"
        assert B.norm_locale("") == "zh-HK"
        assert B.norm_locale(None) == "zh-HK"


class TestMaybeJson:
    def test_object_and_array_parse(self):
        assert B.maybe_json('{"a": 1}') == {"a": 1}
        assert B.maybe_json("[1, 2]") == [1, 2]

    def test_leading_whitespace_stripped(self):
        assert B.maybe_json('  {"a": 1}') == {"a": 1}

    def test_non_json_returns_none(self):
        assert B.maybe_json("not json") is None

    def test_malformed_json_returns_none(self):
        assert B.maybe_json('{"bad"') is None

    def test_empty_returns_none(self):
        assert B.maybe_json("") is None


class TestRecordExtractors:
    def test_title_falls_through_keys(self):
        assert B.record_title({}) == "?"
        assert B.record_title({"name": "N"}) == "N"
        assert B.record_title({"title": "T"}) == "T"
        assert B.record_title({"display_name": "D"}) == "D"

    def test_price_handles_scalar_and_nested(self):
        assert B.record_price({"price": 100}) == 100.0
        assert B.record_price({"price": {"amount": 50}}) == 50.0
        assert B.record_price({}) is None
        # un-coercible price degrades to None rather than raising
        assert B.record_price({"price": "abc"}) is None

    def test_meters_handles_scalar_and_nested(self):
        assert B.record_meters({"distance": 123}) == 123.0
        assert B.record_meters({"distance": {"meters": 456}}) == 456.0

    def test_rating_handles_scalar_and_nested(self):
        assert B.record_rating({"rating": 4.5}) == 4.5
        assert B.record_rating({"rating": {"value": 3.0}}) == 3.0
        assert B.record_rating({}) is None

    def test_top_reason_picks_first(self):
        rec = {"ai_match": {"reasons": [{"text": "good"}]}}
        assert B.record_top_reason(rec) == "good"
        assert B.record_top_reason({}) == ""


class TestBudgetFor:
    def test_known_task_class(self):
        assert B.budget_for("summary") == {"tier": "mid", "purpose": "summary"}

    def test_unknown_task_class_raises(self):
        try:
            B.budget_for("bogus")
            assert False, "expected KeyError"
        except KeyError:
            pass


class TestLLMResponseTotalTokens:
    def test_total_tokens_sums_components(self):
        r = B.LLMResponse(text="", prompt_tokens=10, completion_tokens=5)
        assert r.total_tokens == 15


class TestLLMError:
    def test_carries_provider_and_flags(self):
        err = B.LLMError("boom", provider="anthropic", retryable=True, status=503)
        assert err.provider == "anthropic"
        assert err.retryable is True
        assert err.status == 503


class TestHttpLLMAdapterGuard:
    def test_missing_credentials_raises_llm_error(self):
        # DECISIONS D4 / §131: never hardcode; absence keeps provider=mock
        try:
            B.HttpLLMAdapter(base_url="", api_key="")
            assert False, "expected LLMError"
        except B.LLMError:
            pass

    async def test_present_credentials_constructs(self):
        h = B.HttpLLMAdapter(base_url="http://x", api_key="k")
        health = await h.health()
        assert health["provider"] == "http"
        assert health["ok"] is True
