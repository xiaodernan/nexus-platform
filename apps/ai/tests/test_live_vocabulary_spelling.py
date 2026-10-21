"""D435 - the product's own word for "now", measured on the live plane, in both spellings.

The urgency cues were left out of the lexicon's import-time canonicalisation list, and
the query is canonicalised before it is compared with them - so a cue written in the
Simplified spelling was compared against a spelling it could never have. The word for
"now" set NOTHING: neither 现在 nor 現在 was understood.

The fix is measured offline (a census of the vocabulary's tables and of the locale's
markers), and the offline measurement is a MODEL of the product. This asks the live
plane the same question - through the stream the product actually answers on - and the
words are taken FROM the product's own tables, because a hand-written CJK code point is
not a reference (D409).
"""

from __future__ import annotations

import json
import os

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu.canonical import CANONICAL_FORMS

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


def _now_cues() -> tuple[str, str]:
    """The product's own word for "now", in the two spellings the user may type."""
    reverse = {value: key for key, value in CANONICAL_FORMS.items()}
    canonical_cue = next(cue for cue in L.URGENCY_NOW
                         if len(cue) == 2 and any(ch in reverse for ch in cue))
    simplified = "".join(reverse.get(ch, ch) for ch in canonical_cue)
    return simplified, canonical_cue


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _intent(client, query: str) -> dict:
    """The intent the live stream understood."""
    with client.stream("POST", "/ai/v1/search/stream",
                       json={"query": query, "limit": 4}) as resp:
        assert resp.status_code == 200, resp.status_code
        for line in resp.iter_lines():
            if not line.startswith("data:"):
                continue
            body = json.loads(line[len("data:"):].strip())
            if "urgency" in body:
                return body
    return {}


@pytest.fixture
def client():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        yield c


def test_the_live_plane_understands_now_in_both_spellings(client):
    simplified, traditional = _now_cues()

    for query, locale in ((simplified, "zh-CN"), (traditional, "zh-HK")):
        intent = _intent(client, query)
        assert intent, f"the live stream understood nothing: {query!r}"
        assert intent.get("urgency") == "now", (
            f"{query.encode('unicode_escape').decode()} set no urgency: {intent}")
        assert intent.get("language") == locale, (
            f"{query.encode('unicode_escape').decode()} was read as "
            f"{intent.get('language')}, not {locale}")
