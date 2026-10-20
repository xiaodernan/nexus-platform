"""The product's own non-negotiable rules, checked on the live plane.

The README's first rule: "Real data or nothing: every price, rating, hour and distance shown
to a user traces to a `facts` row with `source`, `confidence`, `observed_at`, `expires_at`.
Unverifiable = rendered as unverified." The e2e suite asserts it ("cards never render an
ungrounded number"), but only in the browser run, which needs the whole stack.

These are the same assertions against the live database, so the rule is checked by the AI
service's own suite and not only by a full-stack run.
"""

from __future__ import annotations

import os

import pytest

pytestmark = pytest.mark.integration

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

# The e2e spec's own intent for the ungrounded-number probe.
JAPANESE_INTENT = {"raw_query": "日式料理", "intent": "discover_merchant",
                    "category": "restaurant"}
SHA_TIN = {"lat": 22.3809, "lng": 114.1861}


@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _published_merchants(live_settings) -> int:
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            rows = await db.readonly(
                "select count(*) as n from merchants where status = 'published'")
            return int(rows[0]["n"])
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def test_no_card_renders_an_ungrounded_number(live_settings):
    """Every price, rating and open state on a card must have a `facts` row behind it."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        r = c.post("/ai/v1/search", json={"intent": JAPANESE_INTENT, "geo": SHA_TIN,
                                           "limit": 20})
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert items, "deterministic search returned nothing - seed not loaded?"

        for item in items:
            facts = {f["attribute"] for f in (item.get("facts") or [])}
            if item.get("price", {}).get("amount") is not None:
                assert "price" in facts, f"{item['slug']} price has no fact"
            if item.get("rating", {}).get("value") is not None:
                assert "rating" in facts, f"{item['slug']} rating has no fact"
            if item.get("open", {}).get("is_open") is not None:
                assert "opening_hours" in facts, f"{item['slug']} hours has no fact"
            # §109/§155: synthetic data must announce itself.
            assert item["flags"]["demo"] is True, f"{item['slug']} synthetic data not labelled"


def test_every_reason_carries_a_fact_id(live_settings):
    """§18: a bullet without a fact id is a claim nobody can check."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        r = c.post("/ai/v1/search", json={"intent": JAPANESE_INTENT, "geo": SHA_TIN,
                                           "limit": 20})
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert items

        seen = 0
        for item in items:
            for reason in (item.get("ai_match") or {}).get("reasons") or []:
                assert reason.get("fact_id"), \
                    f"{item['slug']} has a reason without a fact id: {reason}"
                seen += 1
        assert seen, "no reason rendered at all - the card cannot explain itself"


def test_a_sponsored_card_is_labelled(live_settings):
    """§66-67: a promoted card must say so."""
    if _published_merchants(live_settings) == 0:
        pytest.skip("no published merchants in this database - needs the demo seed")

    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(live_settings)) as c:
        r = c.post("/ai/v1/search", json={"intent": JAPANESE_INTENT, "geo": SHA_TIN,
                                           "limit": 50})
        assert r.status_code == 200, r.text
        for item in r.json()["items"]:
            if item["flags"].get("sponsored"):
                reasons = (item.get("ai_match") or {}).get("reasons") or []
                assert any(x.get("label") == "sponsored" for x in reasons), \
                    f"{item['slug']} is sponsored and does not say so"
