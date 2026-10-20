"""D418 - the query that is matched against the corpus is the canonical form, and the card
still shows the user's own words.

D417 canonicalised the vocabulary and the NLU's query, but the text that went to SQL was
still the RAW query, so a user who typed 餐厅 did not reach a corpus row whose Chinese text
is 餐廳. The measurement that decided it (in the STATUS entry):

    470 published merchants, 0 of them hold a character the canonical table changes, and
    the query 餐厅 reaches 0 rows raw and 52 canonicalised.

So the corpus is entirely in the standard forms, and canonicalising the text that is matched
against the index can only ADD matches.

These cases pin the two halves on the live plane: the simplified spelling now reaches the
same merchants as the traditional one, and the card's own explanation still quotes the words
the user typed.
"""

from __future__ import annotations

import json
import os

import pytest

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: (the simplified spelling, the traditional spelling)
PAIRS = [
    ("\u9910\u5385", "\u9910\u5ef3"),      # 餐厅 / 餐廳
    ("\u98df\u996d", "\u98df\u98ef"),      # 食饭 / 食飯
]


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


@pytest.mark.integration
@pytest.mark.parametrize("simple,traditional", PAIRS)
def test_both_spellings_reach_the_same_merchants(simple, traditional, live_settings=None):
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        simple_items = c.post("/ai/v1/search", json={"query": simple, "limit": 8}).json()
        traditional_items = c.post("/ai/v1/search", json={"query": traditional,
                                                         "limit": 8}).json()

    simple_slugs = {str(i.get("slug")) for i in (simple_items.get("items") or [])}
    traditional_slugs = {str(i.get("slug")) for i in (traditional_items.get("items") or [])}
    assert traditional_slugs, f"the corpus holds {traditional} and the answer was empty"
    assert simple_slugs == traditional_slugs, (
        f"{simple} reached {sorted(simple_slugs)} and {traditional} reached "
        f"{sorted(traditional_slugs)}")


@pytest.mark.integration
def test_the_card_still_shows_the_users_own_words(live_settings=None):
    """The query the user typed is not the query the card explains."""
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    typed = "\u9910\u5385"   # 餐厅 - what the user typed
    with TestClient(create_app(_settings())) as c:
        body = c.post("/ai/v1/search", json={"query": typed, "limit": 5}).json()

    items = body.get("items") or []
    assert items, "the answer was empty"
    reasons = json.dumps(items, ensure_ascii=False)
    assert typed in reasons, "the card does not quote the user's own words"
    assert "\u9910\u5ef3" not in reasons, "the card quotes the canonical form, not the query"
