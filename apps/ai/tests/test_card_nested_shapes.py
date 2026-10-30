"""D474 - the card's NESTED objects carry the contract's shapes too.

D471 checked the card's root fields against API_CONTRACT §2 - and the nested objects were
untouched: the price block, the rating, the distance, the open state, the availability, the
AI match, the actions, the facts, the image and the flags. §2 spells each of them out, so
each has a shape the service can be checked against - and each is a second copy of the
contract's shape if nobody checks it.

This gate reads the contract's own blocks (the card's inline blocks and the shared objects'
blocks) and requires every nested object on a card to carry exactly those fields, plus the
ones the gate declares - the trust primitives, the action's payload, and the two fields the
D423 unit filed (the open state's times are strings where the contract declares datetimes).
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from nexus_ai.api.app import create_app
from nexus_ai.config import Settings

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "docs" / "API_CONTRACT.md"

#: The fields a nested object carries that the contract's blocks do not spell out.
DECLARED_EXTRAS: dict[str, tuple[str, ...]] = {
    # the trust primitive (§4/§19: any AI-stated fact cites one of these) - the D423 unit
    "rating": ("fact_id",),
    "distance": ("fact_id",),
    # D619: the availability block §2 writes in prose is `{status, next_slot}`, while the
    # published JSON object (`packages/types/src/schemas/fact.json#/$defs/AvailabilityInfo`)
    # also names `fact_id` and `as_of`. The card sends those two - and no longer the
    # `source_fact_id` this gate used to declare, which is a key of the OPEN block only.
    # §2's prose naming neither is filed; the JSON is the machine-checked half of the contract.
    "availability": ("as_of", "fact_id"),
    # the flag §2 names in prose ("estimated_price on offering cards") - D472, and the
    # flag that says a fact is DISPUTED (§4: a conflict creates a `trust_signals` row
    # rather than silently picking) - D497. §2 says a new flag name belongs in §2 -
    # filed, the contract is not this lane's to change - and the gate declares it until
    # the contract names it. "verified_visit" on review cards (the reviewer transacted) -
    # D498: the contract names it but the review card is not yet implemented in the AI
    # lane (the platform owns reviews).
    "flags": ("estimated_price", "conflicting_fact", "verified_visit"),
    # the action's payload - the endpoint's own body
    "actions": ("payload",),
}

#: The fields the contract names and the card does NOT carry, and why.
DECLARED_GAPS: dict[str, tuple[str, ...]] = {}

#: The card's nested objects that the contract defines in a block of its own, and the
#: block's name (the comment's first word) - the card block writes them inline as well.
SHARED_BLOCKS: dict[str, str] = {
    "open": "Opening",
    "facts": "Fact",
}


def _section() -> str:
    text = CONTRACT.read_text(encoding="utf-8")
    start = text.find("## 2. Core shared objects")
    end = text.find("\n## 3.", start)
    return text[start:end] if end > start else text[start:start + 6000]


def _fields_of(body: str) -> set[str]:
    """The direct children of an object's braces."""
    fields: set[str] = set()
    for key in re.finditer(r'"(\w+)"\s*:', body):
        before = body[:key.start()]
        if before.count("{") - before.count("}") == 0:
            fields.add(key.group(1))
    return fields


def _object_at(text: str, start: int) -> tuple[str, int]:
    """The object that begins at `start` (its braces balanced) and where it ends."""
    depth = 0
    index = start
    while index < len(text):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:index], index + 1
        index += 1
    return text[start:], len(text)


def _strip_comments(text: str) -> str:
    """The contract's blocks are JSONC - the comments go, the JSON stays."""
    out: list[str] = []
    index = 0
    length = len(text)
    while index < length:
        char = text[index]
        if char == '"':  # a string - its contents are not comments
            end = index + 1
            while end < length:
                if text[end] == "\\":
                    end += 2
                    continue
                if text[end] == '"':
                    break
                end += 1
            out.append(text[index:end + 1])
            index = end + 1
            continue
        if text.startswith("//", index):
            end = text.find("\n", index)
            index = length if end < 0 else end
            continue
        if text.startswith("/*", index):
            end = text.find("*/", index)
            index = length if end < 0 else end + 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _json_at(text: str, start: int) -> tuple[Any, int]:
    """The JSON value at `start`, and where it ends."""
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == '"':
            index += 1
            while index < len(text):
                if text[index] == "\\":
                    index += 2
                    continue
                if text[index] == '"':
                    break
                index += 1
        elif char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
            if depth == 0:
                return json.loads(text[start:index + 1]), index + 1
        index += 1
    return None, len(text)


def _shape(value: Any) -> set[str]:
    """The field names a nested value carries - an object, or the first of an array."""
    if isinstance(value, dict):
        return set(value)
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return set(value[0])
    return set()


def _card_blocks() -> dict[str, set[str]]:
    """The card block's nested objects and the fields it spells out inline.

    API_CONTRACT §2's card block writes each nested object inline - `"price": {"amount":
    ..., "currency": ..., "model": ...}` - and the actions as an array of objects ✓, so
    the fields of a nested object are the keys of that object, read out of the contract
    here.
    """
    section = _strip_comments(_section())
    start = section.find('"card_type"')
    if start < 0:
        raise AssertionError("the contract's §2 card block was not found")
    brace = section.rfind("{", 0, start)
    card, _ = _json_at(section, brace)
    if not isinstance(card, dict):
        raise AssertionError("the contract's §2 card block is not an object")
    return {name: fields for name, value in card.items()
            if (fields := _shape(value))}


def _shared_blocks() -> dict[str, set[str]]:
    """The shared objects' blocks - `// Opening state`, `// Fact`, ..."""
    raw = _section()
    out: dict[str, set[str]] = {}
    # a block's comment starts with its name (capitalised); the wrapped continuation
    # lines of a comment start with a lower-case word and are not blocks
    for match in re.finditer(r"^// ([A-Z]\w*)", raw, re.M):
        name = match.group(1)
        body = _strip_comments(raw[match.end():])
        brace = body.find("{")
        if brace < 0:
            continue
        value, _ = _json_at(body, brace)
        fields = set(value) if isinstance(value, dict) else set()
        if fields:
            out.setdefault(name, set()).update(fields)
    return out


def _client() -> TestClient:
    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url="", internal_token="")
    return TestClient(create_app(settings))


def test_the_contract_blocks_are_readable():
    inline = _card_blocks()
    shared = _shared_blocks()
    for expected in ("price", "rating", "distance", "open", "availability", "ai_match",
                     "actions", "image", "flags"):
        assert expected in inline, (
            f"the contract's card block does not spell out {expected!r}: {sorted(inline)} - "
            f"the gate reads the contract, so a block it cannot read proves nothing")
    assert inline["price"] == {"amount", "currency", "model"}, inline["price"]
    assert inline["flags"] == {"sponsored", "demo", "unverified"}, inline["flags"]
    for block in SHARED_BLOCKS.values():
        assert block in shared, (
            f"the contract's §2 has no {block} block: {sorted(shared)} - the gate reads "
            f"the contract, so a block it cannot read proves nothing")


def test_the_nested_objects_carry_the_contract_fields():
    inline = _card_blocks()
    shared = _shared_blocks()
    with _client() as c:
        r = c.post("/ai/v1/search", json={"query": "sha tin", "limit": 3})
        assert r.status_code == 200, r.text
        cards = r.json()["items"]
        assert cards, "the search returned no card - the gate measured nothing"

        for card in cards:
            for name, value in card.items():
                expected = set(inline.get(name, set()))
                shared_name = SHARED_BLOCKS.get(name)
                if shared_name:
                    expected |= set(shared.get(shared_name, set()))
                if not expected:
                    continue  # not an object the contract spells out
                objects = value if isinstance(value, list) else [value]
                for obj in objects:
                    if not isinstance(obj, dict):
                        continue
                    keys = set(obj)
                    allowed = (expected | set(DECLARED_EXTRAS.get(name, ()))
                               - set(DECLARED_GAPS.get(name, ())))
                    missing = sorted(expected - keys
                                     - set(DECLARED_GAPS.get(name, ())))
                    assert not missing, (
                        f"the card's {name!r} does not carry the contract's fields "
                        f"{missing} - §2 spells that block out")
                    extra = sorted(keys - allowed)
                    assert not extra, (
                        f"the card's {name!r} carries {extra} that the contract's block does "
                        f"not name and the gate does not declare")


def test_the_declared_extras_and_gaps_still_exist():
    # the trust primitives, the action's payload and the two filed fields are the gate's
    # own exceptions, and an exception nobody reads is an exception nobody checks
    for name, extras in DECLARED_EXTRAS.items():
        assert extras, f"{name} is declared with no extra at all - drop the declaration"
    for name, gaps in DECLARED_GAPS.items():
        assert gaps, f"{name} is declared with no gap at all - drop the declaration"
