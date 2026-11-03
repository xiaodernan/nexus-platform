"""D668 - no card repeats a value's fact pointer inside the closed block that holds the value.

DECISIONS **D28** ("Where a card citation lives: `facts[]` for values, on the object for live
state", 2026-09-23) already ruled this and already named the fix: 「`rating.fact_id` is dropped at
the service」. The ruling was recorded; the projection was never edited, so the AI lane kept
sending the pointer D28 says a value block must not carry. `packages/types/src/schemas/
common.json` publishes the two value blocks as closed objects -

  * `RatingInfo`   - `additionalProperties: false` at `{value, count, smoothed}`;
  * `DistanceInfo` - `additionalProperties: false` at `{meters, text, travel_minutes, from}`;

and `apps/ai/nexus_ai/search/cards.py` filled both with a fourth key, `fact_id`. `EntityCard`
types them as `Optional[dict[str, Any]]` (`contract.py`, `rating` / `distance`), so nothing
between the builder and the wire can drop a key the model does not name: the builder is the gate.

What that cost, measured on `b33de4e` (the commit this unit follows) by the eleven-ask census on
both planes, run in-process and judged by the contract package's own validator
(`tmp/d668_measure.py`, record `tmp/d668_before.txt`):

  * 19 of 19 demo cards and 45 of 54 live cards send `rating.fact_id`; all 12 live cards that
    carry a distance send `distance.fact_id` - and these keys are the whole of what is left: the
    validator reports 19 + 45 + 12 = 76 schema rows, every one of them `oneOf - no oneOf branch
    matched` at `/rating` or `/distance`, on 19 of 19 and 54 of 54 cards;
  * removing ONLY those keys takes the schema verdict to **0 offences on both planes** - the demo
    census goes to 0 cards with any offence at all, and the live census keeps 18 cards with a
    RULE row (9 `entity_card_rendered_value_backed`, 12 `entity_card_facts_scoped`), which are the
    two classes this unit does not touch and PLAN already carries;
  * and the pointer is not lost by removing it: **19 of 19, 45 of 45 and 12 of 12** of those cards
    already carry the identical UUID as a `facts[].fact_id`, because `build_card` appends
    `computed["rating"]` and `computed["distance_m"]` to `facts` two lines before it reads their
    `fact_id` back out. The block's copy is a duplicate of the citation §2 publishes, not the
    only place the pointer lives.

The readers agree with D28 rather than with the card. `packages/ui/src/trust/Renderers.tsx`
resolves the rating badge through `findFact(card, 'rating')` and then reads `card.rating?.value`
and `.count` - the pointer it trusts is the fact row's. `CardRating` and `CardDistance` in
`packages/ui/src/trust/types.ts` publish `{value, count}` and `{meters, text, travel_minutes}`,
so the shipped UI type has no field for what the lane sends. `apps/web/src/lib/facts.ts` derives
every `factId` from a `Fact` (`factId: fact.fact_id`), and its `rating_fact_id` is a column of the
platform's own listing row, not of a card block. Inside the AI lane the only readers were two
asserts in `test_cards.py`, re-aimed at the backing fact by this unit.

What stays is the asymmetry D28 ruled, not a coincidence: `AvailabilityInfo` publishes `fact_id`
(and `as_of`), `CardOpeningState` publishes `source_fact_id`, because availability and open/closed
are states with TTL 0 whose whole claim is "as of now" and need the citation on the surface the
renderer reads. Two rows below pin that so a future tidy-up cannot "unify" the card by deleting
the two pointers the contract does publish. Widen `RatingInfo` instead of dropping the key, and
the yardstick rows here go red - D28's closing note is that the closed-object check "would have
been the thing deleted".
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
from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]


def _tracked_root() -> Path:
    """The repository whose INDEX `git grep` can read, which an arm tree is not."""
    top = subprocess.run(["git", "-C", str(REPO), "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    return Path(top.stdout.strip()) if top.returncode == 0 else REPO


TRACKED = _tracked_root()

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

COMMON = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "common.json")
                    .read_text(encoding="utf-8"))
CARD = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                  .read_text(encoding="utf-8"))
FACT = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "fact.json")
                  .read_text(encoding="utf-8"))
RATING_BLOCK = COMMON["$defs"]["RatingInfo"]
DISTANCE_BLOCK = COMMON["$defs"]["DistanceInfo"]
#: every card key the published schema resolves to a closed object with no citation field of its
#: own: a value, which §2 says `facts[]` cites.
VALUE_BLOCKS: dict[str, dict[str, Any]] = {"rating": RATING_BLOCK, "distance": DISTANCE_BLOCK}
#: and the two states that DO carry their own pointer, published that way on purpose (D28). The
#: blocks live in different schema docs, so each entry names its own doc and its pointer field.
STATE_BLOCKS: dict[str, tuple[dict[str, Any], str]] = {
    "availability": (FACT["$defs"]["AvailabilityInfo"], "fact_id"),
    "open": (CARD["$defs"]["CardOpeningState"], "source_fact_id"),
}

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
ASKS = ("browse restaurant", "sha tin cafe", "ramen", "cheapest set menu")

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
        for ask in ASKS:
            r = c.post("/ai/v1/search", json={"query": ask, "limit": 6})
            assert r.status_code == 200, f"{ask}: HTTP {r.status_code} {r.text[:200]}"
            out.extend(r.json().get("items") or [])
    return out


def _built(name: str) -> dict:
    subject_type, rec = SHAPES[name]
    cand = Candidate(subject_type=subject_type, subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=4.5, rating_count=10, price=120.0, distance_m=300)
    cand.raw = {"row": rec, "text_matched": True, "as_of": "2026-10-30T12:00:00+08:00"}
    scored = Scored(candidate=cand, score=0.72, organic_score=0.72, breakdown={},
                    contributions=[("relevance", 0.3)])
    # both STATE blocks are filled on purpose: the row that pins a value block's shape is only
    # honest if the neighbouring blocks the contract does cite kept their pointers.
    return build_card(cand, scored, FactBundle(), locale="zh-HK", query="bistro",
                      open_state={"is_open": True, "text": "Open until 18:00",
                                  "closes_hhmm": "18:00", "as_of": "2026-10-30T12:00:00+08:00"},
                      availability={"status": "available",
                                    "next_slot": "2026-10-30T19:30:00+08:00"}).model_dump(mode="json")


def _inside_block(where: str, card: dict) -> None:
    for key, block in VALUE_BLOCKS.items():
        value = card.get(key)
        if not isinstance(value, dict):
            continue
        published = set(block["properties"])
        extra = sorted(set(value) - published)
        assert not extra, (
            f"{where} sends {key}.{extra[0]}={value[extra[0]]!r}, and the published "
            f"{block.get('$id', key)} is `additionalProperties: false` over {sorted(published)}. "
            "DECISIONS D28: a rendered VALUE is cited by `facts[]`, not by a pointer inside the "
            "value the card renders")


@pytest.mark.parametrize("key", sorted(VALUE_BLOCKS))
def test_the_published_value_block_is_closed_and_names_no_pointer(key):
    """The yardstick rows: read the block, do not recite it."""
    block = VALUE_BLOCKS[key]
    assert block["additionalProperties"] is False, (
        f"{key}'s block opened - this unit's claim that the card must not add a field to it has "
        "to be re-read against whatever the contract now accepts")
    named = sorted(set(block["properties"]) | set(block.get("required", [])))
    assert not [n for n in named if "fact" in n], (
        f"{key}'s block now publishes a citation ({named}); D28 says values are cited by "
        "`facts[]`, so this is a contract edit that needs the ruling revisited, not a licence")
    branch = CARD["properties"][key]["oneOf"][0]["$ref"]
    assert branch.endswith("RatingInfo" if key == "rating" else "DistanceInfo"), (
        f"entity_card.json no longer points `{key}` at the closed block this row reads: {branch}")


def test_the_state_blocks_keep_their_own_pointers():
    """The asymmetry IS the ruling: a STATE with TTL 0 cites on the surface the renderer reads.

    Without this row the unit is only an absence, and the tidy-up that "makes the card
    consistent" - delete `availability.fact_id` and `open.source_fact_id` too - would pass it.
    """
    for word, (block, pointer) in STATE_BLOCKS.items():
        assert block["additionalProperties"] is False, f"{word}'s block is no longer closed"
        assert pointer in block["properties"], (
            f"the contract stopped publishing {word}.{pointer} - D28 lets a live STATE carry its "
            "own citation, so this row is the guard that the removal did not reach it")
    card = _built("merchant")
    for word, (_block, pointer) in STATE_BLOCKS.items():
        assert isinstance(card.get(word), dict), (
            f"the built card sends no {word} block, so this row could not see its pointer")
        # presence is not enough (arm `F_over_removal` showed it): `AvailabilityBrief` dumps a
        # `fact_id` key even when the builder never filled it, so a card that cites nothing still
        # has the word on the wire. The claim is that the pointer names a fact.
        assert card[word].get(pointer), (
            f"the card's {word} block carries no real pointer - the fix is two keys off two value "
            "blocks, not a card that cites nothing")


def test_the_pointer_the_card_still_gives_is_the_facts_own_row():
    """The fix is a move, not a loss: every value the card renders stays citable."""
    card = _built("merchant")
    assert card.get("rating") and card.get("distance"), (
        f"the built card renders neither a rating nor a distance: {sorted(card)}")
    backed = [(str(f.get("fact_id")), f.get("attribute")) for f in (card.get("facts") or [])]
    assert backed, "the card sends no facts at all, so nothing it prints is citable"
    attributes = {a for _fid, a in backed}
    assert "rating" in attributes, (
        f"the card prints a rating no fact backs ({sorted(attributes)}) - `facts[]` is where D28 "
        "says a value's citation lives, so removing the block's copy has to leave this one")
    assert "distance_m" in attributes, (
        f"the card prints a distance no fact backs ({sorted(attributes)})")
    for fid, _attribute in backed:
        UUID(fid)


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_a_built_card_of_either_subject_type_sends_no_value_pointer(name):
    _inside_block(f"the {name} card", _built(name))


def test_the_model_cannot_be_the_gate_because_it_types_both_blocks_as_free_dicts():
    """Why the builder is the only place this can be fixed, and what a re-added key would cost."""
    for key in sorted(VALUE_BLOCKS):
        annotation = str(EntityCard.model_fields[key].annotation)
        assert "dict" in annotation, (
            f"EntityCard.{key} is now {annotation} rather than a free dict - if it became a typed "
            "model the schema rows above would need re-aiming at that model's fields")
    readded = EntityCard(id=SUBJ, slug="lan-kwai-fong", title="Lan Kwai Fong",
                         rating={"value": 4.5, "count": 10, "fact_id": str(SUBJ)})
    assert readded.model_dump(mode="json")["rating"]["fact_id"] == str(SUBJ), (
        "the model started refusing an undeclared key inside `rating`, so the builder is no "
        "longer the only gate - and this unit's premise needs re-reading")


def test_no_demo_card_sends_a_pointer_the_value_block_refuses():
    cards = _census()
    assert cards, "the demo census served no card, so this row measured nothing"
    seen = 0
    for card in cards:
        if isinstance(card.get("rating"), dict):
            seen += 1
        _inside_block(f"a demo card ({card.get('slug')})", card)
    assert seen >= 4, f"only {seen} of {len(cards)} demo cards print a rating"


def test_the_recommend_answer_cites_the_same_way():
    with _client() as c:
        r = c.post("/ai/v1/recommend", json={"query": "browse restaurant", "limit": 3})
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []
    assert items, "the recommend answer served no card, so this row measured nothing"
    for card in items:
        _inside_block(f"POST /ai/v1/recommend card {card.get('slug')}", card)


@live_only
def test_no_live_card_sends_a_pointer_the_value_block_refuses():
    cards = _census(DB_URL)
    rated = [c for c in cards if isinstance(c.get("rating"), dict)]
    distanced = [c for c in cards if isinstance(c.get("distance"), dict)]
    assert len(cards) >= 6, f"the live census served {len(cards)} card(s) (measured 54 over 11 asks)"
    assert len(rated) >= 6 and len(distanced) >= 1, (
        f"the live census served {len(rated)} rating and {len(distanced)} distance blocks; "
        "measured 45 and 12 - too few here means the census measured nothing")
    for card in cards:
        _inside_block(f"a live card ({card.get('slug')})", card)


def test_no_shipped_reader_asks_for_a_pointer_inside_a_value_block():
    """The reader claim, re-checked against the tracked shipped surfaces.

    `git grep` reads the repository's index, so it runs at `git rev-parse --show-toplevel`: an arm
    tree is a `git archive` extraction inside a gitignored `tmp/`, and a pathspec taken there would
    resolve under `tmp/` and match nothing - a row that can only pass is a row that proves nothing.
    """
    g = subprocess.run(["git", "-C", str(TRACKED), "grep", "-nE",
                        r"(rating|distance)\s*[?.]+\s*fact_id", "--",
                        "apps/web", "packages/ui/src", "packages/types/src"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if g.returncode not in (0, 1):
        pytest.skip(f"git grep unavailable: {g.stderr[:120]}")
    hits = [ln for ln in g.stdout.splitlines() if ln.strip()]
    assert not hits, (
        f"a shipped surface now reads a citation out of a value block ({len(hits)} line(s)): "
        f"{hits[:4]} - the removal needs the reader moved to `facts[]` first")
    u = subprocess.run(["git", "-C", str(TRACKED), "grep", "-n", "-e", "findFact(card, 'rating')",
                        "--", "packages/ui/src/trust/Renderers.tsx"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    assert u.returncode == 0, (
        "the trust badge no longer resolves the rating through a fact - D28's ruling rests on "
        "that renderer reading `facts[]`, so the whole premise needs re-reading")
