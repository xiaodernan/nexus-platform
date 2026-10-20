"""D405 - a chunk answers the question when it MENTIONS what was asked.

The trigram lane (D403) widened the candidate set, and the corpus proved that the
similarity NUMBER cannot be the evidence: a real Chinese match scores **0.0063** and a
nonsense query scores **0.0093** — the noise is higher. What separates them is
containment: the chunk's text has the words or it does not.

That is the rule this unit pins, and it fixes two behaviours at once:
- the merchant agent used an absolute floor (0.35) that no corpus could reach, so it
  handed off EVERY question, including ones the merchant's KB plainly answers;
- the RAG endpoint answered a nonsense query with six arbitrary chunks.
"""

from __future__ import annotations

import os

import pytest

from nexus_ai.search.tokens import mentions, query_tokens

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


# --------------------------------------------------------------------------- the tokenizer
def test_a_latin_query_is_one_token():
    assert query_tokens("coffee") == ["coffee"]


def test_a_chinese_query_becomes_bigrams():
    # Chinese carries no spaces, so the whole run is one token and the BIGRAMS are what a
    # chunk can hold.
    tokens = query_tokens("有咩飲品？")
    assert "飲品" in tokens
    assert "有咩" in tokens


def test_a_punctuation_only_query_has_no_tokens():
    assert query_tokens("？？？") == []


def test_a_one_character_query_has_no_tokens():
    assert query_tokens("a") == []


# --------------------------------------------------------------------------- the containment
def test_a_text_mentioning_the_query_is_a_hit():
    assert mentions("全日菜單 / Full menu (12 項)", "全日菜單") is True
    assert mentions("全日菜單 / Full menu (12 項)", "menu") is True


def test_a_text_without_the_query_is_not_a_hit():
    assert mentions("SYNTHETIC DEMO DATA", "咖啡") is False
    assert mentions("SYNTHETIC DEMO DATA", "zzqxwv") is False


def test_a_chinese_question_hits_a_chunk_that_mentions_the_word():
    assert mentions("有飲品：美式咖啡、奶茶", "有咩飲品？") is True


def test_a_chinese_question_does_not_hit_an_unrelated_chunk():
    assert mentions("全日菜單 / Full menu", "有咩飲品？") is False


# --------------------------------------------------------------------------- the live plane
@pytest.mark.integration
def test_a_nonsense_query_finds_nothing(live_settings=None):
    """Before D404 the retrieval answered a nonsense query with six arbitrary chunks."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/rag/retrieve", json={"query": "zzqxwv", "filters": {},
                                                 "top_k": 6})
        assert r.status_code == 200, r.text
        assert (r.json().get("chunks") or []) == [], "a nonsense query retrieved chunks"


@pytest.mark.integration
def test_a_chinese_query_finds_its_chunk(live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/rag/retrieve", json={"query": "全日菜單", "filters": {},
                                                 "top_k": 3})
        assert r.status_code == 200, r.text
        chunks = r.json().get("chunks") or []
        assert chunks, "the corpus has 全日菜單 and the retrieval found nothing"
        for chunk in chunks:
            assert mentions(chunk.get("text") or "", "全日菜單")
