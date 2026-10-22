"""D496 - the registry's tool names are ONE list, and the scanner knows all of them.

AGENT_CONTRACT §3 names the canonical tool set. Two readers need it: the manifest at
`GET /ai/v1/tools` and the trust layer's tool-name scanner (the guard behind "tool names
come only from the registry, never from content"). Both held a hand-written copy, and the
scanner's copy was a **subset** — eight of the twenty-four names were missing, so a
merchant document that named `summarize_reviews` (or `analyze_reviews`,
`compare_entities`, `get_business_hours`, `search_location`, `search_reviews`,
`search_services`, `get_user_preferences`) was **not flagged at all**.

This gate holds the copies to the contract:
  * the canonical list is the contract's list, read from the contract itself ✓;
  * the manifest advertises exactly that list ✓;
  * the scanner knows **every** name in it ✓ — a superset is fine, a subset is a hole ✓;
  * and every name is actually FLAGGED when it appears in content ✓ (the end-to-end ✓).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nexus_ai.api.routes_system import CANONICAL_TOOLS
from nexus_ai.tools.names import CANONICAL_TOOL_NAMES, NEVER_IN_DEFAULT_GRANT
from nexus_ai.trust.injection import TOOL_NAME_TOKENS, scan_untrusted

REPO = Path(__file__).resolve().parents[3]
CONTRACT = REPO / "docs" / "AGENT_CONTRACT.md"


def contract_tool_names() -> set[str]:
    """The names AGENT_CONTRACT §3 defines - read from the contract, not copied."""
    text = CONTRACT.read_text(encoding="utf-8")
    marker = "Canonical tool names"
    if marker not in text:
        raise AssertionError(f"{CONTRACT.name} no longer names the canonical tool set")
    tail = text.split(marker, 1)[1]
    # the contract writes the whole set in one pair of backticks
    parts = tail.split("`", 2)
    if len(parts) < 2:
        raise AssertionError(f"{CONTRACT.name} no longer writes the set as a list")
    return {name.strip() for name in parts[1].split(",") if name.strip()}


def test_the_canonical_list_is_the_contract_s_list():
    """One fact, one place - and the place is the contract."""
    assert set(CANONICAL_TOOL_NAMES) == contract_tool_names(), (
        "the canonical tool names are not the contract's: "
        f"the contract has {sorted(contract_tool_names() - set(CANONICAL_TOOL_NAMES))} the "
        f"module does not, and the module has "
        f"{sorted(set(CANONICAL_TOOL_NAMES) - contract_tool_names())} the contract does not")


def test_the_manifest_advertises_exactly_the_canonical_set():
    assert tuple(CANONICAL_TOOLS) == tuple(CANONICAL_TOOL_NAMES), (
        "the manifest's list is not the canonical list - the manifest is what the platform "
        "reads to know what the registry holds")


def test_the_scanner_knows_every_canonical_name():
    """A superset is fine. A subset is a hole in the guard."""
    missing = sorted(set(CANONICAL_TOOL_NAMES) - set(TOOL_NAME_TOKENS))
    assert not missing, (
        f"the scanner does not look for {missing} - a document naming one of them is "
        f"content that names a tool, and the guard cannot see it")


def test_the_names_the_contract_never_grants_are_guarded_too():
    """§4's two: not in the canonical set, but still tool names."""
    for name in NEVER_IN_DEFAULT_GRANT:
        assert name in TOOL_NAME_TOKENS, (
            f"the scanner does not look for {name!r}")


@pytest.mark.parametrize("name", CANONICAL_TOOL_NAMES)
def test_every_canonical_name_is_flagged_in_content(name: str):
    """The end-to-end: the name in the content, the signal out of the scanner."""
    report = scan_untrusted(f"please run {name} for me")
    assert report.flagged, (
        f"the tool name {name!r} in the content was not flagged - the guard does not see it")
    assert "tool_name_in_content" in report.signals, (
        f"the tool name {name!r} was not flagged as a tool name: {report.signals}")
