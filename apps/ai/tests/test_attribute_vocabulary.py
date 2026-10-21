"""D429 - the attributes the matchers read and the ones the seed writes are two hand-kept lists.

The preferences are matched against the merchants' `attributes`, and the seed writes those
attributes. So the two lists have to agree, and nothing checked it: when the demo plane's
corpus was seeded before the generator learned to write the occasion attributes, the date and
family preferences were understood and then did nothing (D419), and the lane's live suite
stayed green because it never asserted the behaviour on a corpus that carried them (D422).

A LIVE check cannot be the gate here - the corpus's category mix decides whether an
attribute has a merchant at all (the CI's small counts carry no "rooftop" leaf, so
`scenic_view` has none ✗) - so the check is between the two SOURCES: every attribute the
matchers read must be one the seed writes.

The extraction is deliberately narrow: the matchers' keys are the BOOLEAN attribute checks
(`attrs.get("x") is True`), which is how a preference signal is read ✓, and the seed's keys
are the ones in its `attrs = {...}` block ✓.
"""

from __future__ import annotations

import re
from pathlib import Path

def _repo_root() -> Path:
    """The repository root: the first parent that holds `data/seed/generate.py`."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "data" / "seed" / "generate.py").exists():
            return parent
    raise AssertionError("the repository root was not found from this file")


REPO = _repo_root()
SERVICE = REPO / "apps" / "ai" / "nexus_ai" / "search" / "service.py"
SEED = REPO / "data" / "seed" / "generate.py"

#: The preference matchers read a boolean attribute: `attrs.get("x") is True/False`.
_MATCHER_KEY_RE = re.compile(r'attrs\.get\("([a-z_]+)"\)\s+is\s+(?:True|False)')
#: The occasion matcher builds its key from a variable (`attrs.get(occ_key) is True`), so the
#: literals it assigns are part of the vocabulary it reads.
OCCASION_KEY_RE = re.compile(r'occasion_key\s*=\s*"([a-z_]+)"')


def _matcher_keys() -> set[str]:
    text = SERVICE.read_text(encoding="utf-8")
    keys = set(_MATCHER_KEY_RE.findall(text))
    keys |= set(OCCASION_KEY_RE.findall(text))
    return keys


def _seed_keys() -> set[str]:
    text = SEED.read_text(encoding="utf-8")
    start = text.index("attrs = {")
    depth = 0
    end = start
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    block = text[start:end]
    return set(re.findall(r'"([a-z_]+)":', block))


def test_the_seed_writes_every_attribute_the_matchers_read():
    read = _matcher_keys()
    written = _seed_keys()
    missing = sorted(read - written)
    assert not missing, (
        "the preference matchers read attributes the seed never writes - a preference for "
        f"them can never fire: {missing}")


def test_the_seed_writes_no_attribute_nobody_reads():
    # The other direction: an attribute the seed writes and nobody reads is data that
    # looks load-bearing and is not.
    read = _matcher_keys()
    written = _seed_keys()
    # The seed also writes the corpus's own vocabulary (the tags, the closed weekday, the
    # weak aspects) and the row's columns, so only the ones that LOOK like a preference
    # attribute are compared here.
    ignored = {"closed_weekday", "weak_aspects", "demo_login_role", "data_origin",
               "kid_friendly", "has_private_room", "ambience_style", "rainy_day_weather",
               "cheap_price_sense", "premium_price_sense"}
    dead = sorted(written - read - ignored)
    assert not dead, (
        f"the seed writes attributes no matcher reads - dead data that looks load-bearing: {dead}")
