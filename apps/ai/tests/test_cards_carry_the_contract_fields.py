"""D471 - a card carries the fields the CONTRACT's §2 names, and nothing else unnamed.

API_CONTRACT §2 is the single render contract for the consumer, AI and MCP surfaces, and it
spells the card out field by field. The service's `EntityCard` carries those fields and, until
D667, two ranking internals on top - `organic_rank` and the eight-component `score_breakdown` -
behind a model comment that said /compare and the eval needed them. Neither reader exists: the
compare route answers `CompareRow` attribute cells rather than card dicts, and no line in the
shipped client, the UI package or the contract package names either key. The published root
object is closed, so they were two schema offences on every card the lane answered, and the
summary task forwards those card dicts verbatim to a model provider. The declared-extras list
below is empty on purpose, and the gate reads the contract's block, so a contract that later
publishes a debug rung will not silently re-admit them.

The cross-lane `EntityCardBase` is RICHER than the contract: it promises ten fields §2
does not name (`description` ✓, `tenant_id` ✓, `merchant_id` ✓, `category` ✓, `tags` ✓,
`attributes` ✓, `location` ✓, `district` ✓, `transit` ✓, `as_of` ✓) and three of its own
comments cite "API_CONTRACT §2" for fields §2 does not contain ✓. That file belongs to the
types lane, so it is reported rather than edited ✓ - and the web's UI reads none of the ten ✓.

This gate reads the contract's own block (not a list of names) and requires every card the
service returns to carry its fields ✓, with the extras declared ✓.
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "docs" / "API_CONTRACT.md"

#: The fields the service's card may carry that the contract's §2 does not name. D667 emptied
#: it - the two ranking internals that used to sit behind this declaration are on no card and in
#: no field of the model, and the gate below requires that to stay true.
DECLARED_EXTRAS: tuple[str, ...] = ()


def _contract_card_fields() -> set[str]:
    """The field names of the contract's §2 EntityCard block - read, not listed."""
    text = CONTRACT.read_text(encoding="utf-8")
    start = text.find("// EntityCard")
    if start < 0:
        raise AssertionError("the contract's §2 EntityCard block was not found")
    block = text[start:]
    end = block.find("\n}\n")
    block = block[:end] if end > 0 else block[:2000]
    fields: set[str] = set()
    depth = 0
    for line in block.splitlines():
        stripped = line.strip()
        if stripped.startswith("//") or not stripped:
            continue
        match = re.match(r'"(\w+)"\s*:', stripped)
        if match and depth == 1:
            fields.add(match.group(1))
        depth += stripped.count("{") - stripped.count("}")
    if not fields:
        raise AssertionError(f"the contract's card block yielded no fields:\n{block[:400]}")
    return fields


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_contract_names_the_fields_we_expect():
    fields = _contract_card_fields()
    for expected in ("card_type", "id", "slug", "title", "facts", "flags"):
        assert expected in fields, (
            f"the contract's §2 card block does not name {expected!r}: {sorted(fields)} - the "
            f"gate reads the contract, so a block it cannot read proves nothing")


def test_every_card_carries_the_contract_fields_and_only_the_declared_extras():
    fields = _contract_card_fields()
    with _client() as c:
        r = c.post("/ai/v1/search", json={"query": "sha tin", "limit": 3})
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert items, "the search returned no card - the gate measured nothing"
        for card in items:
            keys = set(card)
            missing = sorted(fields - keys)
            assert not missing, (
                f"a card does not carry the contract's §2 fields {missing} - §2 is the single "
                f"render contract, and a card that omits one renders differently everywhere")
            extra = sorted(keys - fields)
            assert tuple(extra) == DECLARED_EXTRAS, (
                f"a card carries {extra} that the contract's §2 does not name and the gate "
                f"does not declare - every field on a card is a promise to a renderer")

        r2 = c.post("/ai/v1/recommend", json={"query": "sha tin", "limit": 3})
        assert r2.status_code == 200, r2.text
        for card in r2.json()["items"]:
            keys = set(card)
            assert not sorted(fields - keys), (
                f"a recommended card does not carry the contract's §2 fields "
                f"{sorted(fields - keys)}")
