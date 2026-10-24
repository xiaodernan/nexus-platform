"""D548 - the outdoor style vocabulary names the word a Hong Kong user actually types.

`PREFERENCE_RULES` carries a `style/outdoor` row, and measured at HEAD it answered 戶外,
户外, outdoor, 露臺, 露台, "al fresco", 燒烤 and 烧烤 - and read NOTHING for the word a
Hong Kong user types for an open-air place:

    露天咖啡店   ->  no preference at all     (戶外咖啡店 -> style/outdoor +1)
    露天座位     ->  no preference at all
    露天         ->  no preference at all
    露天座       ->  no preference at all
    露天餐廳     ->  no preference at all

A preference the vocabulary does not read is a preference the ranking lane never asks
about, so a user who asked for an open-air cafe was answered by relevance alone. The corpus
carries the fact the row points at: `outdoor_seating` is written on a fifth of the published
merchants (measured below, on the live plane) and `outdoor_style` on a seventh by the current
seed generator.

The second hole is the same shape one row over: the INDOOR row carries 室內 / 室内, and the
outdoor row carried no standard-written counterpart at all - 室外. A row that names one half
of a pair and not the other answers a user in one spelling only, which is D416's lesson in a
table that was already half-fixed.

The gate holds both halves: the words are in the row, the sentences read the preference, and
on the live corpus the preference the row names scores the merchants that carry the fact
above the ones that do not.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.nlu.lexicon import PREFERENCE_RULES
from nexus_ai.nlu.understand import extract_intent

#: the row's own tokens, read from the table rather than retyped.
OUTDOOR_TOKENS = next(tokens for key, value, tokens, _p in PREFERENCE_RULES
                      if key == "style" and value == "outdoor")

#: every sentence measured at HEAD as reading nothing, in the spelling a user types.
SENTENCES = ("露天咖啡店", "露天座位", "露天", "露天座", "露天餐廳", "露天座位的餐廳",
             "室外咖啡店")

#: the neighbour that must keep its own row: the indoor word is not the outdoor one.
INDOOR_SENTENCE = "室內咖啡店"

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()


# ------------------------------------------------------------------ the vocabulary
@pytest.mark.parametrize("word", ("露天", "室外"), ids=["露天", "室外"])
def test_the_word_the_user_types_is_in_the_row(word):
    assert word in OUTDOOR_TOKENS, (
        f"{word!r} is not in the style/outdoor row ({OUTDOOR_TOKENS}) - a user who typed it "
        f"got no outdoor preference and the ranking lane never asked about the outdoors")


@pytest.mark.parametrize("text", SENTENCES)
def test_the_sentence_reads_the_outdoor_preference(text):
    ex = extract_intent(text)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(("style", "outdoor")) == 1, (
        f"{text!r} read the outdoors as {prefs.get(('style', 'outdoor'))} - the preference "
        f"the vocabulary does not name is a preference the ranking never asks about")


def test_the_indoor_word_keeps_its_own_row():
    """The two rows are two words, and the fix must not merge them."""
    ex = extract_intent(INDOOR_SENTENCE)
    prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
    assert prefs.get(("style", "indoor")) == 1, (
        f"{INDOOR_SENTENCE!r} no longer reads the indoor preference")
    assert prefs.get(("style", "outdoor")) is None, (
        f"{INDOOR_SENTENCE!r} reads the outdoors too - the two rows have collapsed")


# ------------------------------------------------------------------ the live corpus
@pytest.fixture
def live_settings():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _rows(live_settings) -> list[dict]:
    import asyncio

    from nexus_ai.db import pool as db_pool

    async def _go():
        db = await db_pool.connect(live_settings, force_new=True)
        try:
            return await db.readonly(
                "select slug, attributes from merchants where status = 'published' "
                "and tenant_id = $1 order by slug", _TENANT())
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _TENANT():
    from nexus_ai.search.service import DEFAULT_TENANT_ID

    return DEFAULT_TENANT_ID


def _carries(attrs: dict) -> bool:
    """Whether the corpus says the merchant is an outdoor one, in either spelling of the
    fact the seed writes (`outdoor_seating` on every plane, `outdoor_style` from the
    current generator on)."""
    return attrs.get("outdoor_seating") is True or attrs.get("outdoor_style") is True


def _scores(live_settings, rows, liked: bool) -> list[float]:
    """The personalization scores the row's own matcher gives these merchants."""
    import json

    import nexus_ai.search.service as S
    from nexus_ai.db import pool as db_pool

    class Fixed(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

        async def user_preferences(self, user_id, kinds=None):
            return [{"user_id": "u1", "kind": "style", "key": "outdoor",
                     "value": json.dumps({"value": liked}), "weight": 0.5,
                     "source": "declared", "scope": "long_term"}]

    async def _go():
        await db_pool.connect(live_settings, force_new=True)
        try:
            plan = S.SearchPlan(query_text="", limit=1000)
            _cards, _resp, _bundle, scored = await S.search(
                backend=Fixed(merchants=rows), plan=plan, user_id="u1")
            return [sc.candidate.personalization for sc in scored
                    if sc.candidate.personalization is not None]
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@pytest.mark.integration
@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_corpus_carries_the_fact_the_row_points_at(live_settings):
    """A row whose fact the corpus never writes is a row that reads a word and then does
    nothing with it - the measurement is vacuous unless the fact is there."""
    rows = _rows(live_settings)
    carriers = [r for r in rows if _carries(r["attributes"] or {})]
    assert carriers, (
        f"none of the {len(rows)} published merchants carries an outdoor fact - the row "
        f"names a word the corpus has no answer for")


@pytest.mark.integration
@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
def test_the_outdoor_preference_scores_the_merchants_that_carry_it(live_settings):
    """The end of the chain: the word is read, the preference is written, and the ranking
    lane can act on it. Before the fix the sentence produced no preference at all, so the
    ranker asked about nothing."""
    rows = _rows(live_settings)
    carriers = [r for r in rows if _carries(r["attributes"] or {})]
    others = [r for r in rows if not _carries(r["attributes"] or {})]
    assert carriers, "the corpus carries no outdoor fact - see the other check"
    yes = _scores(live_settings, carriers, True)
    rest = _scores(live_settings, others, True)
    assert yes and min(yes) > 0, (
        f"the {len(carriers)} merchants the corpus calls outdoor scored {yes} - the "
        f"preference does not reward the fact it names")
    if rest:
        assert min(yes) > max(rest), (
            f"a merchant the corpus calls outdoor scored {min(yes)} and one it does not "
            f"scored {max(rest)} - the preference rewards the wrong half of the corpus")
