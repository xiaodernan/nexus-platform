"""D516 - the search's `filters.tags` speaks the spelling the `tags` COLUMN is written in.

The seed is the writer and the SQL `&&` predicate is the reader: every tag in the demo
corpus is a lowercase hyphen slug (100 distinct tags, all matching `^[a-z0-9-]+$`), and
`search/sql.py` compares with an exact array overlap. The CALLER's `filters.tags` used to
pass the raw string straight through, so a caller who spelled a tag the way the product
spells it in prose got an empty page - measured on the live corpus:

    filters {"tags": ["cantonese"]}     -> 11 rows
    filters {"tags": ["Cantonese"]}     -> 0 rows
    filters {"tags": ["escape_room"]}   -> 0 rows   ("escape-room" -> 6)
    filters {"tags": ["  cantonese  "]} -> 0 rows

the D505/D508 lesson in a third place: the same fact (how a tag is spelled) had two readers,
and one of them was the raw string.

This gate holds the filter to the column's spelling:
  * every spelling of a tag the corpus carries reaches the SAME tag the column stores;
  * the reader RESPELLS and never REWORDS - it folds case and separators and resolves
    nothing, so a word the product does not know keeps its word;
  * and it reads BOTH branches of `plan_from_intent` - the intent-None early return used to
    normalise nothing at all.

It was **proved to fail**: taking the reader out of the filter path reddens these checks
(the probe was put back).
"""

from __future__ import annotations

import pytest

from nexus_ai.contract import Intent
from nexus_ai.search.categories import canonical_tag
from nexus_ai.search.service import plan_from_intent

#: tags the demo corpus actually carries, measured against the live database on 2026-10-23
#: (`select distinct unnest(tags) from merchants` -> 100 rows, every one `^[a-z0-9-]+$`).
STORED_TAGS = [
    "demo", "restaurant", "sha-tin", "mtr-5min", "tai-wai", "cafe", "bar", "beauty",
    "e-wallet", "quiet-hours", "late-night", "bubble-tea", "set-lunch", "service",
    "card-no", "experience", "ma-on-shan", "shopping", "activity", "hotel",
    "tsim-sha-tsui", "weekend-brunch", "bakery-dessert", "kwun-tong", "fitness",
    "cantonese", "escape-room", "dim-sum", "hot-pot", "vegetarian", "family-run",
]

#: the same tag, spelled the ways a caller writes it in prose
SPELLINGS = [
    ("cantonese", ["cantonese", "Cantonese", "CANTONESE", "  cantonese  ", "cantonese "]),
    ("escape-room", ["escape-room", "escape_room", "ESCAPE-ROOM", "escape room",
                     " Escape_Room "]),
    ("dim-sum", ["dim-sum", "dim_sum", "Dim Sum", "dim  sum"]),
    ("quiet-hours", ["quiet-hours", "quiet_hours", "Quiet Hours"]),
    ("mtr-5min", ["mtr-5min", "MTR-5min", " mtr_5min "]),
]


def _intent() -> Intent:
    """The smallest intent that still takes the intent branch of `plan_from_intent`."""
    return Intent(raw_query="restaurant")


def _word(tag: str) -> str:
    """How the product's own readers decide two spellings are ONE word: case-folded with the
    separators dropped (`lexicon._normalize_token`, restated here independently so the gate
    does not simply agree with the code it is gating)."""
    return "".join(ch for ch in tag.strip().lower() if ch.isalnum())


@pytest.mark.parametrize("stored,spellings", SPELLINGS, ids=[s for s, _ in SPELLINGS])
def test_every_spelling_of_a_stored_tag_reaches_the_stored_tag(stored, spellings):
    for spelling in spellings:
        assert canonical_tag(spelling) == stored, (
            f"the spelling {spelling!r} was read as {canonical_tag(spelling)!r}, but the "
            f"column stores {stored!r} - one fact, two readers")


@pytest.mark.parametrize("stored", STORED_TAGS)
def test_a_stored_tag_is_a_fixed_point_of_the_reader(stored):
    """The reader must not move what the writer wrote, and must be idempotent."""
    assert canonical_tag(stored) == stored
    assert canonical_tag(canonical_tag(stored)) == stored


@pytest.mark.parametrize("stored,spellings", SPELLINGS, ids=[s for s, _ in SPELLINGS])
def test_the_reader_respells_and_never_rewords(stored, spellings):
    for spelling in spellings:
        assert _word(canonical_tag(spelling)) == _word(spelling), (
            f"{spelling!r} was reworded into {canonical_tag(spelling)!r} - the reader may "
            f"fold case and separators, it may not resolve one word into another")


def test_an_unknown_tag_keeps_its_word():
    """The reader does not resolve a word the product does not know into one it does."""
    assert _word(canonical_tag("unknown_tag_xyz")) == _word("unknown_tag_xyz")
    assert canonical_tag("") == ""
    assert canonical_tag(None) == ""
    assert canonical_tag("   ") == ""


def test_a_lone_string_is_one_tag_not_one_tag_per_character():
    """`{"tags": "ramen"}` is one tag. Iterating the string would hand the predicate five
    tags, none of which any merchant carries - the same defect, one layer down."""
    assert canonical_tag("ramen") == "ramen"
    plan = plan_from_intent(None, filters={"tags": "Cantonese"})
    assert (plan.filters or {}).get("tags") == ["cantonese"]


@pytest.mark.parametrize("stored,spellings", SPELLINGS, ids=[s for s, _ in SPELLINGS])
def test_both_branches_of_the_plan_reader_read_the_tags(stored, spellings):
    """The intent-None early return and the intent path read the tags the same way."""
    for spelling in spellings:
        for intent in (None, _intent()):
            plan = plan_from_intent(intent, filters={"tags": [spelling]})
            assert (plan.filters or {}).get("tags") == [stored], (
                f"with an intent={'yes' if intent else 'no'}, the spelling {spelling!r} gave "
                f"the filter {(plan.filters or {}).get('tags')!r}, not [{stored!r}]")


def test_the_filter_reader_is_the_columns_reader():
    """The reader the filter uses is the reader the module exports - not a private copy."""
    for _stored, spellings in SPELLINGS:
        for spelling in spellings:
            plan = plan_from_intent(None, filters={"tags": [spelling]})
            assert (plan.filters or {}).get("tags") == [canonical_tag(spelling)]


def test_an_empty_tag_list_is_not_invented_into_a_filter():
    plan = plan_from_intent(None, filters={"tags": []})
    assert (plan.filters or {}).get("tags") == []
    plan = plan_from_intent(_intent(), filters={"tags": []})
    assert "tags" not in (plan.filters or {})
