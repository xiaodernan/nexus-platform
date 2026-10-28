"""D584 - a cuisine the user can ask for is a cuisine they can refuse.

The ASK lane names 11 cuisines (`CUISINE_TERMS`). The REFUSE lane named 3 of them.
Measured on the live plane, surface by surface:

    japanese cantonese korean thai italian vegetarian dim_sum malaysian   -> 0 surfaces
    indian(3/8)  western(1/9)  seafood(2/9)                                -> refused

So 唔好海鮮 removed its merchants and 唔好素食, 唔好日料 and 唔好泰國菜 removed nothing.
Nothing downstream was broken: `avoid=["vegetarian"]` on this corpus takes out all 6
merchants the tags name vegetarian plus 3 more through the category, `avoid=["japanese"]`
its 28, `avoid=["seafood"]` its 14. The words had never been written down - the cuisine row
was a hand-copied list of three surfaces beside a vocabulary that kept growing.

And the sentence was not unanswered: the polarity lane read 素食唔好 as
`cuisine/vegetarian -1`, the ranking scored those merchants at 0.0, and they still came back
at ranks 1, 2 and 4 - because `personalization` carries 0.06 of the score
(`infra/config/ranking_weights.yaml`) and `relevance` carries 0.34, so a refusal written
only as a sign cannot move an answer. A refusal of a fact the corpus records is a FILTER,
the way 唔好嘈 and 唔好海鮮 already are, and that is the lane this unit closes.

Two floors, both of them the reason a row here can be red:
  * every derived value must reach the corpus's OWN vocabulary through `avoid_terms` - a
    surface whose canonical value falls through to itself is a filter that matches nothing,
    which is the defect this unit fixes, in a new costume;
  * a sentence that already refused something must refuse the same thing after, so filling
    the gap cannot silently re-point 咖哩 or 牛排 at a different value.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.nlu import lexicon as LX
from nexus_ai.nlu.understand import constraint_hits, extract_intent
from nexus_ai.search.categories import avoid_terms

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

#: A refusal cue the product itself declares, taken from the table rather than typed here.
CUE = next((c for c in LX.NEGATION_CUES if c.strip() == "唔好"), LX.NEGATION_CUES[0]).strip()


def _refuses(surface: str) -> list[tuple[str, str]]:
    return constraint_hits(f"{CUE}{surface}")


# ------------------------------------------------------- what the lane refused BEFORE
#: The (surface -> (rule, value)) pairs the hand-copied rows produced, measured on this
#: plane before the derivation. They are frozen here on purpose: this is the population a
#: fix must not move, and the sentence that used to work has to keep working the same way.
WAS_REFUSED = {
    "辣": ("cuisine_avoid", "spicy"),
    "curry": ("cuisine_avoid", "curry"),
    "咖哩": ("cuisine_avoid", "curry"),
    "咖喱": ("cuisine_avoid", "curry"),
    "海鮮": ("diet_avoid", "seafood"),
    "seafood": ("diet_avoid", "seafood"),
    "牛排": ("diet_avoid", "beef"),
    "豬": ("diet_avoid", "pork"),
    "嘈": ("noise_avoid", "noise"),
    "排隊": ("feature_avoid", "queue"),
    "煙": ("smoking_avoid", "smoking"),
}

#: The surfaces `CUISINE_TERMS['seafood']` names that no refusal row carried before the
#: derivation - measured, not chosen. 海鮮 already refused the value, so these five arrived
#: as the first NEW thing to refuse seafood and went into the cuisine row anyway.
SEAFOOD_ONLY_SURFACES = ("生蠔", "生蚝", "海魚菜", "大排档", "大排檔")


class TestTheCensusOfTheVocabulary:
    def test_every_cuisine_the_ask_lane_names_can_be_refused(self):
        missing = [value for value, surfaces in LX.CUISINE_TERMS.items()
                   if not any(_refuses(s) for s in surfaces)]
        assert not missing, (
            f"the user can ask for {len(LX.CUISINE_TERMS)} cuisines and refuse none of "
            f"{missing} - the two lanes are two vocabularies again (D493)")

    def test_a_refusal_of_a_surface_names_the_value_the_ask_lane_uses(self):
        # One word, one meaning, both directions: for every cuisine there is a surface that
        # refuses THAT value, not a third name only one of the two tables carries. Some
        # surfaces refuse at the granularity the hand-copied rows already chose - 咖哩 is a
        # surface of `indian` and a refusal of `curry` - and WAS_REFUSED below is what pins
        # those, rather than this row pretending the two granularities are one.
        for value, surfaces in LX.CUISINE_TERMS.items():
            named = [canon for s in surfaces
                     for _key, canon in _refuses(str(s).strip())]
            assert value in named, (
                f"the ask lane names {value!r} through {surfaces} and no refusal of those "
                f"surfaces produces {value!r}: the refusal reads as {named}")

    def test_the_surfaces_that_refuse_nothing_are_the_single_characters(self):
        # The floor D579 leaves in place: a one-character CJK surface completes a longer
        # word (齋 in 長齋, 蟹 in 蟹黃), so neither lane may trust it until the boundary rule
        # is in the matcher. Anything ELSE that refuses nothing is a hole, not a floor.
        for value, surfaces in LX.CUISINE_TERMS.items():
            for surface in surfaces:
                word = str(surface).strip()
                if _refuses(word):
                    continue
                assert len(word) == 1 and not word.isascii(), (
                    f"{value}'s surface {word!r} refuses nothing and is not excused by the "
                    f"one-character floor")

    def test_a_surface_that_already_refused_something_still_refuses_the_same_thing(self):
        for surface, was in WAS_REFUSED.items():
            hits = _refuses(surface)
            assert was in hits, (
                f"{CUE}{surface} refused {was} before this unit and now reads {hits} - "
                f"filling a gap may not re-point a sentence that worked")

    def test_the_derivation_adds_no_twin_row_to_the_table(self):
        keys = [key for key, _negs, _values in LX.CONSTRAINT_RULES]
        assert len(keys) == len(set(keys)), (
            f"CONSTRAINT_RULES carries the same kind twice: {keys} - a table whose rows are "
            f" distinguished only by when they were written is a table nobody can read")

    def test_no_value_is_refused_under_two_lanes(self):
        # D545's invariant, walked over the whole table: the row a value sits in is the lane
        # the fact is declared in, and the plan merges EVERY key into one `avoid` list (D546),
        # so a value carried by two rows filters exactly as well as one - which is precisely
        # why nothing downstream ever noticed the drift.
        lanes: dict[str, set[str]] = {}
        for key, _negs, values in LX.CONSTRAINT_RULES:
            for surface in values:
                lanes.setdefault(LX.canon_constraint(str(surface).strip()), set()).add(key)
        split = {value: sorted(keys) for value, keys in lanes.items() if len(keys) > 1}
        assert not split, (
            f"{split} is refused under two keys - one fact is one lane, and a vocabulary "
            f"whose contract test reads the value to a key can only say WHICH if it is one")

    @pytest.mark.parametrize("surface", SEAFOOD_ONLY_SURFACES, ids=list(SEAFOOD_ONLY_SURFACES))
    def test_a_seafood_dish_refuses_it_in_the_row_that_already_refuses_seafood(
            self, surface: str) -> None:
        hits = _refuses(surface)
        assert hits == [("diet_avoid", "seafood")], (
            f"{CUE}{surface} wrote {hits} - the ask lane files this word under the seafood "
            f"cuisine, but 海鮮 has refused that value as a diet fact since before this "
            f"lane grew, and a surface may not move the value it refuses to a second lane")


class TestTheRefusalReachesTheCorpusVocabulary:
    """A filter in a spelling the corpus does not write is the same silence as no filter."""

    def test_every_cuisine_value_reaches_the_tags_the_corpus_actually_writes(self):
        # The term set is deliberately wider than one spelling: `avoid_terms` feeds the tag
        # predicate AND an ILIKE over the offering names, so `dim sum` has a job even though
        # no tag is spelled with a space. The claim that matters is narrower - at least one
        # term has to be in the spelling the tags column uses, or the leg that removed the
        # 6 vegetarian / 28 japanese / 14 seafood merchants matches nothing, and the filter
        # is the silence this unit started out to fix, wearing a different coat.
        from nexus_ai.search.categories import canonical_tag

        for value in LX.CUISINE_TERMS:
            terms = [t for t in avoid_terms(value) if t]
            assert terms, f"avoid_terms({value!r}) is empty - the filter would match nothing"
            slug_form = [t for t in terms if t == canonical_tag(t)]
            assert slug_form, (
                f"{value} reaches the filter only as {terms}, none of it spelled the way "
                f"the tags column writes")

    def test_a_cjk_surface_never_reaches_the_filter_as_itself(self):
        # `canon_constraint` falls through to the word it was given, so a surface with no
        # canonical value would travel into `avoid` as CJK and remove nothing.
        for value, surfaces in LX.CUISINE_TERMS.items():
            for surface in surfaces:
                word = str(surface).strip()
                if not _refuses(word):
                    continue
                for _key, canon in _refuses(word):
                    assert canon.isascii(), (
                        f"{CUE}{word} refused the non-ascii value {canon!r} - the tag "
                        f"predicate compares with && and would match no row")


class TestTheTwoLanesStillAgree:
    """D582's invariant, now with the filter lane in it."""

    def test_a_refusal_filters_the_fact_and_the_ranking_points_against_it(self):
        ex = extract_intent(f"{CUE}素食")
        avoid = [v for _k, v in constraint_hits(f"{CUE}素食")]
        assert "vegetarian" in avoid, f"the refusal filtered nothing: {avoid}"
        prefs = {(p["key"], p["value"]): p["polarity"] for p in ex.preferences}
        assert prefs.get(("cuisine", "vegetarian")) == -1, (
            f"the plan filters vegetarian while the ranking calls it a want: {prefs}")

    def test_a_want_never_filters(self):
        text = "我想食素食"
        avoid = [v for _k, v in constraint_hits(text)]
        assert not avoid, f"a want filtered {avoid} - the filter would empty the answer of it"
        prefs = {(p["key"], p["value"]): p["polarity"] for p in extract_intent(text).preferences}
        assert prefs.get(("cuisine", "vegetarian")) == 1

    def test_a_question_never_filters(self):
        # 有冇素食 asks whether such a place exists (D533); answering it by removing every
        # vegetarian merchant would refuse the question instead of replying to it.
        for text in ("有冇素食", "有無素食", "有沒有素食"):
            avoid = [v for _k, v in constraint_hits(text)]
            assert not avoid, f"{text}: a question filtered {avoid}"


# ------------------------------------------------------------------------ the answer
async def _tagged(terms: list[str]) -> set[str]:
    import asyncpg

    conn = await asyncpg.connect(DB_URL)
    try:
        rows = await conn.fetch(
            "select slug from merchants where status = 'published' and tags && $1::text[]",
            list(terms))
        return {str(r["slug"]) for r in rows}
    finally:
        await conn.close()


def _served(query: str, limit: int = 50) -> list[str]:
    from fastapi.testclient import TestClient

    from nexus_ai.api.app import create_app
    from nexus_ai.config import Settings

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="")
    with TestClient(create_app(settings)) as c:
        r = c.post("/ai/v1/search", json={"query": query, "limit": limit})
        assert r.status_code == 200, r.text
        body = r.json()
    return [str(i.get("slug")) for i in (body.get("items") or [])]


@pytest.mark.integration
@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("value,ask,refuse", [
    ("vegetarian", "想食素食", f"{CUE}素食"),
    ("japanese", "想食日料", f"{CUE}日料"),
])
def test_the_refused_cuisine_is_not_in_the_answer_the_asked_one_is(value, ask, refuse):
    surfaces = LX.CUISINE_TERMS[value]
    first = next((s for s in surfaces if _refuses(str(s).strip())), None)
    assert first, f"the vocabulary names {value} with no surface that refuses it"
    tagged = asyncio.run(_tagged(avoid_terms(value)))
    if not tagged:
        pytest.skip(f"this corpus carries no merchant tagged {value}")

    asked = _served(ask)
    refused = _served(refuse)
    assert tagged & set(asked[:6]), (
        f"{ask!r} served no merchant the corpus tags {value} - the control half of this "
        f"door never fired, so the refusal below would prove nothing")
    head = set(refused[:4]) & tagged
    assert not head, (
        f"{refuse!r} still leads with the merchants the user refused: {sorted(head)}")


@pytest.mark.integration
@pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")
@pytest.mark.parametrize("value", sorted(LX.CUISINE_TERMS))
def test_refusing_a_cuisine_never_empties_the_answer(value):
    # D422's objection to filtering, measured rather than argued: a hard filter on a sparse
    # corpus can answer with nothing. Here it costs at most the merchants that carry the
    # refused fact, so the page stays answerable.
    surfaces = LX.CUISINE_TERMS[value]
    first = next((s for s in surfaces if _refuses(str(s).strip())), None)
    if not first:
        pytest.skip(f"nothing to refuse for {value}")
    served = _served(f"{CUE}{first}", limit=50)
    assert served, (
        f"refusing {value} answered with nothing - the filter took the whole corpus")
