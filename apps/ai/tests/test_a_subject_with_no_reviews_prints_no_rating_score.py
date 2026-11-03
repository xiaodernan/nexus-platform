"""D669 - a card prints no score for a subject that has no reviews.

`packages/types/src/common.ts` publishes `RatingInfo` as `{value: number | null, count: number |
null}` and its own comment says which of the two answers the question: 「A null/0 count means "not
yet rated", and quality shrinks to the tenant mean (AGENT_CONTRACT §6)」. `infra/db/migrations/
V1__init.sql` gives both `merchants` and `offerings` the columns `rating_agg numeric(3,2) NOT NULL
DEFAULT 0` and `review_count integer NOT NULL DEFAULT 0`, so an entity nobody has ever rated does
not arrive as NULL - it arrives as the number zero, and the two meanings ("rated zero stars" and
"nobody has rated this") are the same value in the column.

`apps/ai/nexus_ai/search/cards.py` then asks the two halves of that pair different questions.
`synth_computed_facts` makes the backing fact `if cand.rating is not None and cand.rating_count` -
it reads the COUNT, so an unrated subject gets no fact. `build_card` fills the block
`if rating_value is not None` - it reads only the score, so the same subject gets
`{"value": 0.0, "count": 0}`. The card therefore states a score in the one case where its own lane
refuses to cite one, and the state it states it in is the worst state a 0-5 scale has.

Measured on `61d2b52` by the eleven-ask census on both planes, run in-process and judged by the
contract package's own validator (`tmp/d669_measure.py`, record `tmp/d669_before.txt`):

  * 0 of 19 demo cards print a zero count - the fixture rows all carry reviews;
  * **9 of 54 live cards print `rating = {"value": 0.0, "count": 0}`, and none of the 9 carries a
    `rating` fact** - its `facts[]` holds only `price` and `relevance`. Those nine are the whole of
    what `entity_card_rendered_value_backed` writes on the live plane: 9 rows reading "renders
    `rating` but no fact carries attribute rating". The other 45 live rating cards print a number
    and a non-zero count and carry the fact that states it, and stay untouched.
  * the rows behind the nine say nothing else: every one is `rating_agg=0.0 review_count=0`, so the
    printed 0.0 is the column verbatim, not a rounding of a real average. Corpus-wide the pair is
    consistent - 4,331 of 5,538 offerings have `review_count = 0` and all 4,331 have
    `rating_agg = 0`; 0 of 520 merchants has zero reviews, and no row anywhere has a non-zero
    rating with zero reviews or the reverse. So `count = 0` is a reliable statement of "nobody has
    rated this", which is what the fix keys on.

The rest of the lane already answers this correctly, which is what makes the block the bug rather
than a style choice. `_reason_text("top_rated")` returns the empty string when
`cand.rating is None or not cand.rating_count` - the card writes no sentence naming a score for an
unrated subject. `bayesian_quality` shrinks a zero-count rating onto the tenant mean, so the
ranking treats the same row as no evidence. `packages/ui/src/trust/Renderers.tsx` renders the
`unverified` label when there is no rating fact, and `apps/web/app/m/[slug]/page.tsx` publishes
`aggregateRating` only `if typeof rating.value === 'number'` - so a card that sends `null` loses a
badge and loses a structured-data claim, while a card that sends 0.0 publishes 「ratingValue: 0」 to
a search engine. Only the block itself speaks the zero.

What the fix is not: it is not a missing block. `RatingInfo` REQUIRES both keys and makes `value`
nullable, so the honest card for an unrated subject says `{value: null, count: 0}` - it still tells
the reader there are no reviews, which is a fact about the subject, and stops telling the reader it
was rated zero, which is not. Arm `E_block_gone` is the alternative that also clears the rule rows,
and the row below about the count is what refuses it.

Nine of the eleven asks reach none of the nine cards; `filters.kind = product` serves six of them
and the district-comparison ask serves three, so the two asks this door sends are those two plus a
control, and `test_the_census_still_serves_the_subjects_with_no_reviews` keeps the census honest
about it rather than letting the rows above pass by never asking.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import EntityCard
from nexus_ai.search.cards import _reason_text, build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

COMMON = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "common.json")
                    .read_text(encoding="utf-8"))
CARD = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                  .read_text(encoding="utf-8"))
RATING_BLOCK = COMMON["$defs"]["RatingInfo"]

#: the asks that answer with the cards this row is about. `gift set` + `kind: product` is six of
#: the nine; the district comparison is the other three; the last is the rated control.
PRODUCT_ASK: dict[str, Any] = {"query": "gift set", "filters": {"kind": "product"}, "limit": 6}
COMPARE_ASK: dict[str, Any] = {"query": "\u6bd4\u8f03\u4e2d\u74b0\u540c\u65fa\u89d2", "limit": 6}
CONTROL_ASK: dict[str, Any] = {"query": "cheapest set menu", "limit": 6}
ASKS = (PRODUCT_ASK, COMPARE_ASK, CONTROL_ASK)

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
SHAPES: dict[str, tuple[str, dict]] = {
    "merchant": ("merchant", {"slug": "lan-kwai-fong", "display_name": "Lan Kwai Fong",
                              "category_primary": "restaurant"}),
    "bookable offering": ("offering", {"slug": "afternoon-tea", "name": "Afternoon Tea",
                                       "kind": "experience", "merchant_slug": "lan-kwai-fong"}),
    "offering": ("offering", {"slug": "kids-cut-small", "name": "Kids Cut", "kind": "service",
                              "merchant_slug": "lan-kwai-fong"}),
}


def _client(database_url: str = "") -> TestClient:
    return TestClient(create_app(Settings(llm_provider="mock", embedding_provider="hashing",
                                          database_url=database_url, internal_token="")))


def _census(database_url: str = "") -> list[dict]:
    out: list[dict] = []
    with _client(database_url) as c:
        for body in ASKS:
            r = c.post("/ai/v1/search", json=body)
            assert r.status_code == 200, f"{body}: HTTP {r.status_code} {r.text[:200]}"
            out.extend(r.json().get("items") or [])
    return out


def _built(name: str, *, rating: float | None, rating_count: int | None) -> dict:
    subject_type, rec = SHAPES[name]
    cand = Candidate(subject_type=subject_type, subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=rating, rating_count=rating_count or 0, price=120.0,
                     distance_m=300)
    cand.raw = {"row": rec, "text_matched": True, "as_of": "2026-10-30T12:00:00+08:00"}
    scored = Scored(candidate=cand, score=0.72, organic_score=0.72, breakdown={},
                    contributions=[("relevance", 0.3)])
    return build_card(cand, scored, FactBundle(), locale="zh-HK", query="bistro",
                      open_state={"is_open": True, "text": "Open until 18:00",
                                  "closes_hhmm": "18:00", "as_of": "2026-10-30T12:00:00+08:00"},
                      availability={"status": "available",
                                    "next_slot": "2026-10-30T19:30:00+08:00"}).model_dump(mode="json")


def _candidate(name: str, *, rating: float | None, rating_count: int | None) -> Candidate:
    subject_type, _rec = SHAPES[name]
    cand = Candidate(subject_type=subject_type, subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=rating, rating_count=rating_count or 0)
    cand.raw = {}
    return cand


def _rating_facts(card: dict) -> list[Any]:
    return [f.get("value") for f in (card.get("facts") or []) if f.get("attribute") == "rating"]


def _states_a_score(block: Any) -> bool:
    return isinstance(block, dict) and block.get("value") is not None


# ------------------------------------------------------------------ the published shape
def test_the_published_block_allows_a_null_score_and_requires_the_count():
    """The yardstick row: the contract already permits the honest answer, so this is a projection
    edit and not a schema change."""
    assert RATING_BLOCK["additionalProperties"] is False, (
        "RatingInfo opened - re-read this unit against whatever the contract now accepts")
    assert set(RATING_BLOCK["properties"]) == {"value", "count", "smoothed"}, (
        f"RatingInfo's published keys moved: {sorted(RATING_BLOCK['properties'])}")
    assert "null" in json.dumps(RATING_BLOCK["properties"]["value"]["type"]), (
        f"RatingInfo.value no longer accepts null ({RATING_BLOCK['properties']['value']['type']}) - "
        "then a not-yet-rated subject has no way to say so and this unit's shape is wrong")
    assert set(RATING_BLOCK["required"]) == {"value", "count"}, (
        f"RatingInfo's required set moved: {RATING_BLOCK['required']} - `count` is the key that "
        "carries the meaning, so a fix that drops it is not this one")
    assert CARD["properties"]["rating"]["oneOf"][1] == {"type": "null"}, (
        "entity_card.json no longer offers `rating: null` as the other branch - the block is "
        "optional at the card level, which is what arm `E_block_gone` tempts a reader with")


def test_the_columns_score_arrives_as_zero_rather_than_as_nothing():
    """Where the phantom comes from, so the door says the column is not at fault."""
    ddl = (REPO / "infra" / "db" / "migrations" / "V1__init.sql").read_text(encoding="utf-8")
    both = [ln.strip() for ln in ddl.splitlines() if "rating_agg" in ln and "numeric" in ln]
    assert len(both) == 2, f"expected the merchants and offerings rating columns, got {both}"
    for line in both:
        assert "NOT NULL" in line and "DEFAULT 0" in line, (
            f"`{line}` no longer defaults a score to zero - if it became nullable the card could "
            "send the column's own absence and this unit's reading of it needs re-checking")


# ------------------------------------------------------------------ the builder's two halves
@pytest.mark.parametrize("name", sorted(SHAPES))
def test_a_subject_nobody_rated_prints_no_score_but_still_prints_its_count(name):
    card = _built(name, rating=0.0, rating_count=0)
    block = card.get("rating")
    assert isinstance(block, dict), (
        f"the {name} card sends {block!r} rather than a block - the count of reviews is a fact "
        "about the subject and the card loses it when the block goes (arm `E_block_gone`)")
    assert block.get("value") is None, (
        f"the {name} card with zero reviews prints `rating.value={block.get('value')!r}`. A count "
        "of 0 means nobody rated this subject (`common.ts`), so 0.0 is a score the answer never "
        "had evidence for - the worst value on the scale, stated about a thing nobody scored")
    assert block.get("count") == 0, (
        f"the {name} card states reviews={block.get('count')!r} for a subject whose row says 0")
    assert not _rating_facts(card), (
        f"the {name} card backs a zero-review rating with a fact: {_rating_facts(card)} - "
        "`synth_computed_facts` makes one only with a non-zero count, so a fact here is a new claim")


def test_a_subject_somebody_rated_still_prints_the_score_and_cites_it():
    """The fix is one branch of one expression, not a card that stops rating things."""
    card = _built("merchant", rating=4.2, rating_count=8)
    block = card.get("rating")
    assert isinstance(block, dict) and block.get("value") == 4.2, (
        f"a rated merchant now prints {block!r} - the lane read `rating_agg` for a real answer "
        "before this unit and must keep reading it")
    assert block.get("count") == 8, f"the review count went missing: {block!r}"
    backed = _rating_facts(card)
    assert backed, "the card prints a score no fact states"
    assert [v.get("value") for v in backed if isinstance(v, dict)] == [4.2], (
        f"the rating fact disagrees with the block: {backed}")


def test_the_lanes_own_sentence_refuses_the_number_the_block_used_to_print():
    """Internal consistency: the reason line already declines to name a score for this subject.

    Green before the fix, on purpose. It is the witness that the block was the only liar in the
    answer, so a later unit that "unifies" the two by making the sentence print 0.0 instead has to
    redden a row here rather than ship quietly.
    """
    unrated = _candidate("offering", rating=0.0, rating_count=0)
    rated = _candidate("offering", rating=4.2, rating_count=8)
    assert _reason_text("top_rated", unrated, locale="en", open_state=None, query=None) == "", (
        "the card's own `top_rated` sentence now names a score for a subject with no reviews - "
        "the two halves of `cards.py` disagreed before this unit and are not allowed to agree on "
        "the wrong answer")
    said = _reason_text("top_rated", rated, locale="en", open_state=None, query=None)
    assert "4.2" in said, f"and for a rated subject the sentence says: {said!r}"


# ------------------------------------------------------------------ the served answer
def test_no_demo_card_states_a_score_its_own_review_count_denies():
    _assert_no_phantom_score(_census(), "demo")


@live_only
def test_no_live_card_states_a_score_its_own_review_count_denies():
    _assert_no_phantom_score(_census(DB_URL), "live")


def _assert_no_phantom_score(cards: list[dict], plane: str) -> None:
    """The published rule in Python: `entity_card_rendered_value_backed` reads
    `if isObj(instance.rating) && instance.rating.value != null` and then demands a `rating` fact
    stating that number. The card that prints 0.0 for a zero-count subject fails it on both halves
    - no fact, and a number the subject never had."""
    offenders = [c for c in cards
                 if _states_a_score(c.get("rating")) and not (c["rating"].get("count") or 0)]
    assert not offenders, (
        f"{plane}: {len(offenders)} card(s) state a score while their own block says no review "
        f"was counted: {[(c.get('slug'), c['rating']) for c in offenders[:6]]}")
    unbacked = [c for c in cards if _states_a_score(c.get("rating"))
                and not _rating_facts(c)]
    assert not unbacked, (
        f"{plane}: {len(unbacked)} card(s) print a score no `facts[]` row states - §2 says the "
        f"rendered number is cited there: {[(c.get('slug'), c['rating']) for c in unbacked[:6]]}")
    for card in cards:
        if not _states_a_score(card.get("rating")):
            continue
        stated = [round(float(v["value"]), 2) for v in _rating_facts(card)
                  if isinstance(v, dict) and isinstance(v.get("value"), (int, float))]
        printed = round(float(card["rating"]["value"]), 2)
        assert printed in stated, (
            f"{card.get('slug')}: the block prints {printed} and its facts state {stated} - "
            "the card's number and the fact's number are the same measurement")


@live_only
def test_the_census_still_serves_the_subjects_with_no_reviews():
    """Non-vacuity: nine live cards print a zero count, and they are why the rows above exist.

    A door that only asserts an absence is satisfied by an answer that stops serving those cards -
    so this row requires the cards to arrive and to keep their count, which is the difference
    between this fix and the missing block.
    """
    cards = _census(DB_URL)
    zero = [c for c in cards if isinstance(c.get("rating"), dict)
            and not c["rating"].get("count")]
    assert zero, (
        "no served card has a zero review count - the asks above stopped reaching the unrated "
        "products, so the two census rows are measuring an empty set")
    assert all(c["rating"].get("value") is None for c in zero), (
        f"{sum(1 for c in zero if c['rating'].get('value') is not None)} of the "
        f"{len(zero)} zero-count cards still print a score")


def test_the_entity_card_model_carries_a_null_score_as_easily_as_a_number():
    """Why the fix has to be in the builder: the model would let any shape through."""
    for block in ({"value": None, "count": 0}, {"value": 4.2, "count": 8}):
        card = _built("merchant", rating=block["value"], rating_count=block["count"])
        card["rating"] = block
        EntityCard.model_validate(card)
    annotation = str(EntityCard.model_fields["rating"].annotation)
    assert "dict" in annotation, (
        f"EntityCard.rating is now {annotation} rather than a free dict - if it became a typed "
        "model the shape rows above need re-aiming at that model")


def test_the_two_published_readers_treat_a_null_score_as_an_absence():
    """The badge and the structured data both already decline a non-number, so `null` is the shape
    that removes the claim rather than breaking the reader."""
    badge = (REPO / "packages" / "ui" / "src" / "trust" / "Renderers.tsx").read_text(
        encoding="utf-8")
    assert "typeof rating !== 'number'" in badge, (
        "CardRating no longer refuses a non-number - it would render a star row out of `null`")
    page = (REPO / "apps" / "web" / "app" / "m" / "[slug]" / "page.tsx").read_text(
        encoding="utf-8")
    assert "typeof rating.value === 'number'" in page, (
        "the merchant page no longer refuses a non-number, so it would publish "
        "`aggregateRating: {ratingValue: 0}` for a subject nobody rated")


def test_the_builder_is_the_only_place_the_score_is_chosen():
    """`git grep` the product: no other writer puts a `value` into a card's rating block."""
    out = subprocess.run(
        ["git", "grep", "-nE", r"\[.rating.\]\s*=|rating\s*=\s*\{", "--", "apps/ai/nexus_ai"],
        cwd=str(REPO), capture_output=True, text=True, encoding="utf-8", errors="replace")
    lines = [ln for ln in (out.stdout or "").splitlines() if ln.strip()]
    writers = [ln for ln in lines if "/search/cards.py" not in ln and "/api/demo_data.py" not in ln]
    assert not writers, (
        "a second writer of the rating block appeared and this door reads only `cards.py`: "
        + "; ".join(writers))
