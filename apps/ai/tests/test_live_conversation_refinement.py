"""D433 - the product's two-turn refinement, measured on the live plane, in BOTH spellings.

The product's own conversation: a user says what they want, then says "太贵了" (too
expensive) or "近一点" (a bit closer) on the second turn. §34 promises what the second
turn does, and the two units that carry it were measured OFFLINE:

* D406 wired the sort preference (`plan.sort_preference` was written and never read);
* D421 made the merge's cues answer to either spelling (the cues are a second vocabulary
  the canonical table did not cover).

This is the same question asked of the live plane, and the words are taken FROM THE
VOCABULARY rather than typed here - D421's lesson is that a writer's memory of a CJK code
point is not a reference, and a test that hard-codes one inherits the mistake.

D436 corrected the way the two spellings are taken. D421 canonicalises the cue lists at
import, so the list holds ONE spelling: reading two entries out of it measures the same
word twice, and the Simplified spelling was never run. The other spelling is therefore
taken from the CANONICAL TABLE, which holds both - and the module asserts that the two
are different, so this cannot quietly collapse again.
"""

from __future__ import annotations

import json
import os

import pytest

from nexus_ai.nlu import lexicon as L
from nexus_ai.nlu import state_merger as M
from nexus_ai.nlu.canonical import CANONICAL_FORMS
from nexus_ai.nlu.polarity import NEGATION_CUES

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: 拉麵 - the lexicon's own word for it, not a hand-typed one.
RAMEN = L.CUISINE_TERMS["japanese"][5]

#: The two spellings of the merge's own refinement cues. The canonical form is the
#: Traditional one (every pair in the canonical table points that way), and the reverse
#: map gives the Simplified one.
_CANONICAL_REVERSE = {value: key for key, value in CANONICAL_FORMS.items()}


def _other_spelling(text: str) -> str:
    """The same word in the other spelling, from the canonical table."""
    return "".join(_CANONICAL_REVERSE.get(ch, ch) for ch in text)


#: 太貴 - the merge's own cue for "too expensive", in the spelling the vocabulary holds.
CHEAPER_TRADITIONAL = M.CHEAPER_CUES[0]
CHEAPER_SIMPLIFIED = _other_spelling(CHEAPER_TRADITIONAL)
#: 近一點 - the traditional spelling of "a bit closer".
CLOSER_TRADITIONAL = M.NEARER_CUES[1]
CLOSER_SIMPLIFIED = _other_spelling(CLOSER_TRADITIONAL)

# A guard, not a hope: D421 canonicalises the cue lists, so two entries of the same list
# are the SAME word - and a test that reads "the two spellings" out of such a list
# measures one spelling twice (D436).
assert CHEAPER_TRADITIONAL != CHEAPER_SIMPLIFIED, (
    "the two spellings of the cheaper cue are the same string")
assert CLOSER_TRADITIONAL != CLOSER_SIMPLIFIED, (
    "the two spellings of the closer cue are the same string")


def _settings():
    from nexus_ai.config import Settings

    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=DB_URL, internal_token="")


def _turn(client, query: str, previous: dict | None = None):
    """One turn of the SSE stream: the intent it understood and the cards it served."""
    payload: dict = {"query": query, "limit": 8}
    if previous:
        payload["previous_intent"] = previous
    intent: dict = {}
    items: list = []
    with client.stream("POST", "/ai/v1/search/stream", json=payload) as resp:
        assert resp.status_code == 200, resp.status_code
        for line in resp.iter_lines():
            if not line.startswith("data:"):
                continue
            body = json.loads(line[len("data:"):].strip())
            if "sort_preference" in body:
                intent = body
            if "items" in body:
                items = body["items"]
    prices = [float((i.get("price") or {}).get("amount")) for i in items
               if (i.get("price") or {}).get("amount")]
    return intent, items, prices


@pytest.fixture
def client():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app

    with TestClient(create_app(_settings())) as c:
        yield c


def test_the_second_turn_orders_by_price_in_either_spelling(client):
    first, items, _prices = _turn(client, RAMEN)
    assert items, "the first turn served no cards"
    assert first.get("sort_preference") == "relevance"

    for word in (CHEAPER_TRADITIONAL, CHEAPER_SIMPLIFIED):
        intent, items, prices = _turn(client, word, dict(first))
        assert intent.get("sort_preference") == "price_low", (
            f"{word.encode('unicode_escape').decode()} did not name the price order")
        assert prices == sorted(prices), (
            f"{word.encode('unicode_escape').decode()} did not reorder the answer: {prices}")
        assert items, "the refinement emptied the answer"


def test_the_second_turn_narrows_the_distance_in_both_spellings(client):
    first, items, _prices = _turn(client, RAMEN)
    assert items
    for word in (CLOSER_TRADITIONAL, CLOSER_SIMPLIFIED):
        intent, items, _prices = _turn(client, word, dict(first))
        assert intent.get("sort_preference") == "distance", (
            f"{word.encode('unicode_escape').decode()} did not name the order")
        location = intent.get("location") or {}
        assert location.get("radius_m"), "the radius was not tightened"

# ------------------------------------------------------------------ D528: changing your mind
# The words come from the product's own tables, not from this file (D409/D421/D436): a
# hand-typed CJK code point is a writer's memory, not a reference.
JAPANESE_WORD = L.CUISINE_TERMS["japanese"][1]        # the lexicon's own word for it
THAI_WORD = L.CUISINE_TERMS["thai"][0]
SCENIC_WORD = next(t for kind, key, terms, _pol in L.PREFERENCE_RULES
                   if (kind, key) == ("view", "scenic") for t in terms if len(t) == 2)
WANT_JAPANESE = f"我想食{JAPANESE_WORD}"
WANT_THAI = f"想食{THAI_WORD}"
WANT_SCENIC = f"我想要{SCENIC_WORD}"
REFUSE_SCENIC = f"{NEGATION_CUES[0]}{SCENIC_WORD}"


def _preference_labels(items) -> set[str]:
    """The `preference_match` reasons the cards actually carried."""
    out: set[str] = set()
    for item in items:
        for reason in (item.get("ai_match") or {}).get("reasons") or []:
            if reason.get("label") == "preference_match":
                out.add(str(reason.get("text") or ""))
    return out


def test_the_second_turn_serves_the_cuisine_the_user_changed_to(client):
    """D528: `_absorb` dropped a preference the state already carried, so a follow-up
    naming a different cuisine left the FIRST one in place - and the cards went on
    naming the cuisine the user had abandoned."""
    first, items, _prices = _turn(client, WANT_JAPANESE)
    assert items, "the first turn served no cards"

    intent, items, _prices = _turn(client, WANT_THAI, dict(first))
    assert items, "the follow-up emptied the answer"
    held = [(p.get("key"), p.get("value")) for p in intent.get("preferences") or []]
    assert ("cuisine", "thai") in held, (
        f"the follow-up named a different cuisine and the state still carried {held}")
    assert ("cuisine", "japanese") not in held, (
        f"the state still carries the cuisine the user abandoned: {held}")
    labels = _preference_labels(items)
    assert any("thai" in label for label in labels), (
        f"no card named the cuisine the user changed to: {sorted(labels)}")
    assert not any("japanese" in label for label in labels), (
        f"a card still names the cuisine the user abandoned: {sorted(labels)}")


def test_a_refusal_typed_in_the_follow_up_reaches_the_intent(client):
    """D528: the same drop threw away the POLARITY. "我想要海景" then "唔好海景" kept
    view=scenic at +1, so the ranking lane boosted the very thing the user refused in
    the follow-up - the D523 inversion reached from the merge lane."""
    first, items, _prices = _turn(client, WANT_SCENIC)
    assert items, "the first turn served no cards"

    intent, items, _prices = _turn(client, REFUSE_SCENIC, dict(first))
    assert items, "the follow-up emptied the answer"
    held = {(str(p.get("key")), str(p.get("value"))): int(p.get("polarity", 1))
            for p in intent.get("preferences") or []}
    assert held.get(("view", "scenic")) == -1, (
        f"the refusal typed in the follow-up left {held} - a dislike the user spoke out "
        f"loud is still a LIKE to the ranking lane")

