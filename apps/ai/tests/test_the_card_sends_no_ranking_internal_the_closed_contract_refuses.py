"""D667 - no card sends a ranking internal the published closed card refuses.

`packages/types/src/schemas/entity_card.json` publishes `EntityCard` as a closed object: `type:
object`, `additionalProperties: false`, 43 properties, `required: [card_type, id, title, facts,
flags]`. None of those 43 names contains `organic` or `score`. Until this unit the lane sent two
anyway - `organic_rank`, the position the row held in the organic list before paid slots were
inserted, and `score_breakdown`, the eight component scores (`availability`, `distance`,
`freshness`, `personalization`, `popularity`, `price_fit`, `quality`, `relevance`) that say how
this user's ranking was computed - because `EntityCard` declared both behind a comment reading
"ranking internals, never rendered by the UI but needed by /compare + eval".

Neither reader exists, and the gate that should have caught the claim was the one declaring the
exception: `test_cards_carry_the_contract_fields.py` asserted `tuple(extra) == DECLARED_EXTRAS`,
so the two keys were a pass by definition. Measured on `65ac3ab`, the commit this unit follows, by
the full eleven-ask census on both planes (`tmp/d643_parent.py`, whose two records are
`tmp/d643_parent_before.txt` and `tmp/d643_parent_after.txt`):

  * 19 of 19 demo payloads and 54 of 54 live payloads carry both - 152 component values on the demo
    census, 432 on the live, 54 organic positions among them - and the contract package's own
    validator judges every payload one offence per key: 73 rows of `/: additionalProperties -
    property "organic_rank" is not part of the contract (closed object)` plus 73 naming
    `score_breakdown`, 146 in all, and 0 of them once the two keys are gone;
  * `git grep -nE "organic_rank|score_breakdown" -- apps/web packages/ui/src packages/types/src`
    answers **0 lines**, so no shipped client, UI package or contract type reads either, and
    `POST /ai/v1/compare` answers `CompareRow` attribute cells (`routes_discover.py`,
    `_compare_rows`), never a card dict;
  * they leave the lane twice per answer. `run_search` builds `SearchPack.items` as
    `c.model_dump(mode="json")` and `compose_summary` hands that list to the provider as the
    summary request's `records`, and `HttpLLMAdapter._user_text` serializes the payload verbatim
    when no prompt is set: 229,837 bytes of outbound text for the live census against 219,031
    without the two keys (-10,806, -4.7%), and 27,499 against 26,287 (-1,212) for the fullest
    six-card live answer.

The alternative the 2026-09-23 ledger row offered - "if it belongs anywhere it is a debug rung
behind an explicit flag" (`docs/STATUS.md`, row A1) - is not published: `debug`, `explain` and
`verbose` appear 0 times across `docs/API_CONTRACT.md` and `docs/AGENT_CONTRACT.md`, no request
model in `contract.py` names one, and every request model extends `_Strict`
(`extra="forbid"`), so a client that asked would get a 422, not internals. Inventing the rung is a
contract edit, not a lane edit.

What the card does keep is the published explanation object: `ai_match` is `oneOf` of null and
`fact.json#/$defs/AiMatchInfo`, itself closed at `{score, reasons, strategy, rank}` with
`required: [score, reasons]` - AGENT_CONTRACT §6's "paid placement ... never feeds `score`". The
rank that block allows a client to be told lives there, and the contract's cross-object rule
`entity_card_sponsored_has_no_organic_rank` (`packages/types/scripts/rules.mjs`) reads
`instance.ai_match.rank`, never the key this unit removed, so the rule is no weaker here. That
`AiMatch` cannot yet send `rank` or `strategy` - the model is `extra="ignore"` over two fields - is
filed in PLAN; it is pinned below rather than widened, because sending them is a claim about the
answer that needs its own measure.

The yardstick is `packages/types/src/schemas`, the tracked half: `git ls-files packages/types/dist`
answers 0 files, so `dist` is a build product and cannot be what a door reads.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import EntityCard, SearchRequest
from nexus_ai.models.base import HttpLLMAdapter, LLMRequest
from nexus_ai.nlu.timeparse import HK_TZ
from nexus_ai.search.cards import build_card
from nexus_ai.search.ranking import Candidate, Scored
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

CARD = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "entity_card.json")
                  .read_text(encoding="utf-8"))
FACT_BLOCKS = json.loads((REPO / "packages" / "types" / "src" / "schemas" / "fact.json")
                         .read_text(encoding="utf-8"))
MATCH = FACT_BLOCKS["$defs"]["AiMatchInfo"]
PROPS = set(CARD["properties"])
#: the two names this unit took off the card, and the eight the breakdown carried with it
INTERNALS = ("organic_rank", "score_breakdown")
COMPONENTS = ("availability", "distance", "freshness", "personalization",
              "popularity", "price_fit", "quality", "relevance")

SUBJ = UUID("33333333-3333-3333-3333-333333333333")
BREAKDOWN = {k: 0.5 for k in COMPONENTS}
ASKS = ("browse restaurant", "sha tin cafe", "ramen", "cheapest set menu")

#: the three row shapes `build_card` turns into cards. The offering rows name their owner the way
#: `search/sql.py` and `api/demo_data.py` carry it, so the card they produce is the one a browser
#: receives on the offering lane.
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


def _census(database_url: str = "") -> list[tuple[str, list[dict]]]:
    out: list[tuple[str, list[dict]]] = []
    with _client(database_url) as c:
        for ask in ASKS:
            r = c.post("/ai/v1/search", json={"query": ask, "limit": 6})
            assert r.status_code == 200, f"{ask}: HTTP {r.status_code} {r.text[:200]}"
            out.append((ask, r.json().get("items") or []))
    return out


def _built(name: str) -> tuple[dict, Candidate, Scored]:
    """The card one shape produces, as the wire sends it, plus the two rows the lane keeps."""
    subject_type, rec = SHAPES[name]
    cand = Candidate(subject_type=subject_type, subject_id=str(SUBJ), merchant_id=str(SUBJ),
                     relevance=0.9, rating=4.5, rating_count=10, price=120.0, distance_m=300)
    # the producer reads both off the candidate: the organic position from `raw`, the components
    # from the `Scored` this call also receives. Nothing here can put them back on the card.
    cand.raw = {"row": rec, "text_matched": True, "as_of": "2026-10-30T12:00:00+08:00",
                "organic_rank": 3}
    scored = Scored(candidate=cand, score=0.72, organic_score=0.72,
                    breakdown=dict(BREAKDOWN), contributions=[("relevance", 0.3)])
    card = build_card(cand, scored, FactBundle(), locale="zh-HK", query="bistro")
    return card.model_dump(mode="json"), cand, scored


def _no_internal(where: str, card: dict) -> None:
    extra = sorted(set(card) - PROPS)
    assert not extra, (f"{where} sends {extra}, and the published EntityCard sets "
                       f"additionalProperties: false over its {len(PROPS)} properties - a key it "
                       f"does not name is a schema offence on every answer, not an optional field")
    assert not (set(card) & set(INTERNALS)), (
        f"{where} sends a ranking internal again: {sorted(set(card) & set(INTERNALS))}")


def test_an_undeclared_kwarg_sends_nothing_and_raises_nothing():
    """The mechanism the closure rides on, and the price of it, pinned in one row.

    `EntityCard` is `extra="ignore"`, which `test_contract.py`'s
    `test_lenient_models_ignore_fields_a_newer_server_adds` pins on purpose: `test_search_endpoint.py`
    and `test_stream.py` validate card dicts back into this model, and a server that adds a field
    must not break the lane. The same lenience is why a builder that passed `organic_rank=` again
    (arm `G_builder_sends_again`) sends nothing rather than failing - the closure holds because the
    model names only published fields, not because anything rejects the rest. That half of the
    trade is filed in PLAN; this row is what it costs if the model is ever changed to `forbid`.
    """
    card = EntityCard(id=SUBJ, slug="lan-kwai-fong", title="Lan Kwai Fong",
                      organic_rank=3, score_breakdown=dict(BREAKDOWN))
    assert not (set(card.model_dump(mode="json")) & set(INTERNALS)), (
        "the model admitted a key the published card refuses, so the builder is the only gate")
    assert EntityCard.model_config.get("extra") == "ignore", (
        "the model no longer ignores undeclared fields - a builder kwarg outside the contract "
        "becomes a hard error at build time, and this row's premise needs re-reading")


# ------------------------------------------------------------------ the block, read not listed
def test_the_published_card_is_closed_and_names_no_ranking_field():
    """The yardstick row: what the contract actually publishes, read from its own file."""
    assert CARD["additionalProperties"] is False, (
        "the published EntityCard is no longer a closed object - every other row here reads "
        "that closure, so a schema that opened says the gate has to be re-read")
    assert CARD["required"] == ["card_type", "id", "title", "facts", "flags"], CARD["required"]
    named = sorted(k for k in PROPS if re.search(r"organic|score", k))
    assert not named, (
        f"the card now publishes {named}; a published ranking field is a contract edit and this "
        "unit's claim that the lane sends none needs re-reading against it")


def test_the_model_declares_no_field_the_published_card_refuses():
    undeclared = sorted(set(EntityCard.model_fields) - PROPS)
    assert not undeclared, (
        f"EntityCard declares {undeclared}, which the closed published object does not name - "
        "a field the model declares is a field every card sends")


def test_the_model_sends_no_key_the_lane_never_set():
    """A default-constructed card is the shape the other rows must not have to allow for."""
    card = EntityCard(id=SUBJ, slug="lan-kwai-fong", title="Lan Kwai Fong")
    dumped = card.model_dump(mode="json")
    assert not (set(dumped) & set(INTERNALS)), (
        f"a card nobody ranked still dumps {sorted(set(dumped) & set(INTERNALS))} - the pydantic "
        "defaults were what put an organic position on every answer")


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_a_built_card_carries_no_ranking_internal(name):
    card, _cand, _scored = _built(name)
    assert card["slug"] or card["title"], f"{name} produced no card at all"
    _no_internal(f"the {name} card", card)


@pytest.mark.parametrize("name", sorted(SHAPES))
def test_the_lane_keeps_what_it_stopped_sending(name):
    """The fix is a move, not a loss: the score the ranking reads is still the score it wrote."""
    _card, cand, scored = _built(name)
    assert cand.raw["organic_rank"] == 3, "the organic position left the candidate too"
    assert tuple(sorted(scored.breakdown)) == COMPONENTS, (
        f"the component scores the census measured are no longer on Scored: "
        f"{sorted(scored.breakdown)}")


def test_the_explanation_the_card_may_still_give_is_the_published_match_object():
    """`ai_match` is the contract's one explanation vehicle - closed, and not a place to park a dict."""
    card, _cand, _scored = _built("merchant")
    match = card["ai_match"]
    assert match is not None, "the card sends no ai_match, so it cites no score at all"
    assert set(MATCH["properties"]) >= {"score", "reasons"}
    extra = sorted(set(match) - set(MATCH["properties"]))
    assert not extra, f"ai_match sends {extra}, outside the closed AiMatchInfo block"
    assert {"score", "reasons"} <= set(match), (
        f"ai_match omits the keys AiMatchInfo requires: {sorted(match)}")
    assert match["score"] is None or 0.0 <= match["score"] <= 1.0, match["score"]
    assert len(match["reasons"]) <= MATCH["properties"]["reasons"]["maxItems"]


def test_the_contract_publishes_no_debug_rung_to_send_them_behind():
    """Why this is a removal and not a flag: the flag is not published, and the request forbids one."""
    words = re.compile(r"\b(debug|explain|verbose)\b", re.I)
    for doc in ("API_CONTRACT.md", "AGENT_CONTRACT.md"):
        text = (REPO / "docs" / doc).read_text(encoding="utf-8")
        hits = words.findall(text)
        assert not hits, (
            f"docs/{doc} now names a debug rung ({sorted(set(hits))}) - the A1 ledger row says "
            "the internals belong behind an explicit flag, so if the contract publishes one this "
            "unit's removal has to be re-read as a gate")
    fields = sorted(f for f in SearchRequest.model_fields
                    if words.search(f))
    assert not fields, f"SearchRequest declares {fields} but publishes no rung for it"
    assert SearchRequest.model_config.get("extra") == "forbid", (
        "the request stopped being strict, so a client could ask for a field no model names")


def test_the_rule_about_organic_rank_polices_the_field_the_contract_publishes():
    """The sponsored rule must not have been the reason the key was there."""
    text = (REPO / "packages" / "types" / "scripts" / "rules.mjs").read_text(encoding="utf-8")
    block = text[text.index("entity_card_sponsored_has_no_organic_rank"):
                 text.index("entity_card_sponsored_has_no_organic_rank") + 1400]
    assert "ai_match.rank" in block, (
        "the sponsored rule no longer reads ai_match.rank - its name mentions an organic rank, "
        "and this row is the guard that it polices the published field and not the card key")
    assert "instance.organic_rank" not in block, (
        "the sponsored rule now reads the card key this unit removed - the rule would go silent "
        "on a sponsored card carrying a rank in ai_match")


# ------------------------------------------------------------------------------ the two roads
def test_the_summary_text_a_provider_reads_carries_no_component_score():
    """The second road out: the card dicts ARE the outbound user text of a summary call.

    The control half of this row re-attaches the two keys to prove the mechanism rather than
    assert an absence: `_user_text` serializes whatever the payload holds, so nothing between the
    card and the provider filters it - the closed card is the only thing keeping the internals in.
    """
    census = _census()
    items = [c for _ask, cards in census for c in cards]
    assert items, f"the demo census served no card: {census}"

    def text_of(records: list[dict]) -> str:
        req = LLMRequest(task_class="summary", payload={"records": records, "locale": "zh-HK"})
        return HttpLLMAdapter._user_text(req)

    sent = text_of(items)
    for name in INTERNALS:
        assert f'"{name}"' not in sent, (
            f"the outbound summary text names {name!r} - a provider would read this user's "
            "ranking internals")
    # the eight component WORDS are not asserted absent: `availability`, `distance`, `price`,
    # `rating` and `relevance` are published names on other parts of a card. What must not leave is
    # the scoring dict that gave each row a number for them, and that dict only ever travelled
    # under `score_breakdown`.
    injected = [{**c, "organic_rank": 1, "score_breakdown": dict(BREAKDOWN)} for c in items]
    control = text_of(injected)
    assert '"score_breakdown"' in control and '"relevance"' in control, (
        "_user_text no longer forwards the payload verbatim, so this row's control - and the "
        "claim that the card was the only gate - needs re-reading")
    assert len(control.encode("utf-8")) > len(sent.encode("utf-8")) + 200, (
        f"the two keys only cost {len(control.encode('utf-8')) - len(sent.encode('utf-8'))} "
        "bytes on this census; measured 3,824 over the 19 demo payloads of the full eleven-ask "
        "census (tmp/d643_parent_before.txt)")


def test_no_demo_card_sends_a_key_the_closed_object_refuses():
    seen = 0
    for ask, cards in _census():
        for card in cards:
            seen += 1
            _no_internal(f"POST /ai/v1/search {ask!r}", card)
    assert seen >= 4, f"the demo census served {seen} card(s), so this row measured nothing"


def test_the_recommend_answer_is_closed_the_same_way():
    """`RecommendResponse.items` is the second `list[EntityCard]` the lane sends."""
    with _client() as c:
        r = c.post("/ai/v1/recommend", json={"query": "browse restaurant", "limit": 3})
        assert r.status_code == 200, r.text
        items = r.json().get("items") or []
    assert items, "the recommend answer served no card, so this row measured nothing"
    for card in items:
        _no_internal("POST /ai/v1/recommend", card)


@live_only
def test_no_live_card_sends_a_key_the_closed_object_refuses():
    seen = 0
    for ask, cards in _census(DB_URL):
        for card in cards:
            seen += 1
            _no_internal(f"live POST /ai/v1/search {ask!r}", card)
    assert seen >= 6, f"the live census served {seen} card(s) (measured 54 over 11 asks)"


def test_no_shipped_surface_reads_either_name():
    """The reader claim, re-checked on the working tree: nobody downstream asks for these two."""
    g = subprocess.run(["git", "-C", str(REPO), "grep", "-nE",
                        "organic_rank|score_breakdown", "--",
                        "apps/web", "packages/ui/src", "packages/types/src"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if g.returncode not in (0, 1):
        pytest.skip(f"git grep unavailable: {g.stderr[:120]}")
    hits = [ln for ln in g.stdout.splitlines() if ln.strip()]
    assert not hits, (
        f"a shipped surface now reads a ranking internal ({len(hits)} line(s)): {hits[:4]} - the "
        "removal needs a replacement the contract publishes, not a re-added key")
