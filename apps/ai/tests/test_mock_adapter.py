"""`MockAdapter` — the deterministic heuristic provider (DECISIONS D4, AGENT_CONTRACT §9).
It is the backbone of offline / dev / CI: every §9 task has a real, deterministic
implementation built from the NLU lexicon + locale templates, and because copy is composed
*only* from records handed to it, it cannot invent a fact (§19). It was untested.

This pins the contract so the offline provider — which stands in for every live model in
CI — cannot silently change behaviour. DB-free, async.
"""

from __future__ import annotations

import json

import pytest

from nexus_ai.models.base import LLMError, norm_locale
from nexus_ai.models.mock import MockAdapter

_RECS = [
    {"title": "Sushi Zen", "price": 120, "distance": 300, "rating": 4.7,
     "ai_match": {"reasons": [{"text": "新鮮"}]}},
    {"title": "Noodle House", "price": 60, "distance": 800, "rating": 4.2},
]


# ------------------------------------------------------------- clear labelling (§105/§19)
async def test_response_is_clearly_labelled_mock_and_free():
    a = MockAdapter()
    resp = await a.complete(_summary_req(_RECS, "en"))
    assert resp.provider == "mock"
    assert resp.model == "mock-heuristic-1"
    assert resp.degraded is True          # never trusted as an authoritative live model
    assert resp.cost_usd == 0.0           # dev-only estimate; mock is free
    assert resp.purpose == "summary"


async def test_health_reports_offline_mock():
    h = await MockAdapter().health()
    assert h["provider"] == "mock" and h["ok"] is True and h.get("offline") is True


# ------------------------------------------------------------- determinism (CI repro)
async def test_complete_is_deterministic():
    a = MockAdapter()
    req = _summary_req(_RECS, "en")
    r1 = await a.complete(req)
    r2 = await a.complete(req)
    assert r1.text == r2.text
    assert r1.data == r2.data


# ------------------------------------------------------------- task routing / errors
async def test_unknown_task_class_raises():
    with pytest.raises(LLMError):
        await MockAdapter().complete(_req("nonsense", {}))


async def test_embed_is_rejected_for_the_llm_adapter():
    # embed is served by EmbeddingAdapter, not the LLM adapter (§9)
    with pytest.raises(LLMError):
        await MockAdapter().complete(_req("embed", {}))


# ------------------------------------------------------------- summary: composed, not invented (§19)
async def test_summary_zh_hk_composes_from_records():
    text = (await MockAdapter().complete(_summary_req(_RECS, "zh-HK"))).text
    assert "找到 2 個符合條件的選擇。" in text
    assert "最佳匹配：Sushi Zen（新鮮）" in text      # first record + its top reason
    assert "最化算：Noodle House" in text            # min price
    assert "最近：Sushi Zen" in text                 # min distance
    assert "最受歡迎：Sushi Zen" in text             # max rating


async def test_summary_en_composes_from_records():
    text = (await MockAdapter().complete(_summary_req(_RECS, "en"))).text
    assert "I found 2 good options." in text
    assert "Best match: Sushi Zen (新鮮)" in text


async def test_summary_empty_uses_template_not_invention():
    text = (await MockAdapter().complete(_summary_req([], "zh-HK"))).text
    assert "暫時找不到" in text        # honest empty template, not a fabricated pick
    assert "Sushi" not in text


# ------------------------------------------------------------- locale normalisation
def test_norm_locale_contract():
    assert norm_locale("en-US") == "en"
    assert norm_locale("zh-CN") == "zh-CN"
    assert norm_locale("zh-Hans") == "zh-CN"
    assert norm_locale("zh-HK") == "zh-HK"
    assert norm_locale("fr-FR") == "zh-HK"   # default fallback


# ------------------------------------------------------------- ui copy: templates only (§19)
async def test_copy_expands_known_template_with_vars():
    resp = await MockAdapter().complete(_req("generate_ui_copy",
        {"locale": "en", "template_key": "found", "vars": {"n": 3}}))
    assert resp.text == "I found 3 good options."


async def test_copy_unknown_key_or_missing_var_is_none_grounded():
    a = MockAdapter()
    unknown = await a.complete(_req("generate_ui_copy",
        {"locale": "en", "template_key": "bogus"}))
    assert unknown.text == "I could not verify that, so I will not guess."
    missing_var = await a.complete(_req("generate_ui_copy",
        {"locale": "en", "template_key": "found"}))   # found needs {n}
    assert missing_var.text == "I could not verify that, so I will not guess."


# ------------------------------------------------------------- rerank: deterministic lexical order
async def test_rerank_orders_by_token_match_then_rating():
    recs = [
        {"title": "A", "desc": "ramen noodles soup"},
        {"title": "B", "desc": "coffee shop"},
        {"title": "C", "desc": "ramen bar", "rating": 5.0},
    ]
    resp = await MockAdapter().complete(_req("rerank",
        {"query": "ramen noodles", "records": recs}))
    assert isinstance(resp.data, list) and len(resp.data) == 3
    titles = [r["title"] for r in resp.data]
    assert titles == ["A", "C", "B"]        # A: 2 token hits; C: 1 hit + rating bonus; B: 0


async def test_rerank_is_deterministic():
    recs = [
        {"title": "A", "desc": "ramen noodles soup"},
        {"title": "B", "desc": "coffee shop"},
        {"title": "C", "desc": "ramen bar", "rating": 5.0},
    ]
    a = MockAdapter()
    first = [r["title"] for r in (await a.complete(_req("rerank",
        {"query": "ramen noodles", "records": recs}))).data]
    second = [r["title"] for r in (await a.complete(_req("rerank",
        {"query": "ramen noodles", "records": recs}))).data]
    assert first == second


# ------------------------------------------------------------- intent route returns a dict
async def test_intent_extract_returns_structured_dict():
    resp = await MockAdapter().complete(_req("intent_extract",
        {"query": "推薦一間餐廳", "context": {}}))
    assert isinstance(resp.data, dict)
    assert json.loads(resp.text) == resp.data   # wire text round-trips to the data dict


# ------------------------------------------------------------- latency is a non-negative int
async def test_latency_is_non_negative_int():
    a = MockAdapter(latency_ms=5)
    resp = await a.complete(_summary_req([], "en"))
    assert isinstance(resp.latency_ms, int)
    assert resp.latency_ms >= 5


# --------------------------------------------------------------------------- helpers
def _req(task_class: str, payload: dict) -> object:
    from nexus_ai.models.base import LLMRequest
    return LLMRequest(task_class=task_class, payload=payload)


def _summary_req(records, locale: str) -> object:
    from nexus_ai.models.base import LLMRequest
    return LLMRequest(task_class="summary", payload={"locale": locale, "records": records})
