"""D501 - an UNKNOWN fact source is never laundered into a KNOWN one.

AGENT_CONTRACT §4: *resolving an unknown source to a known one is forbidden, because that
launders where the number came from.* And DECISIONS D25, ruling 3, calls this exact
behaviour by name: *apps/ai resolved that by clamping unknown sources to `inferred` -
provenance laundering, the opposite of §109.*

The clamping was still in `facts_from_rows`:

    source=cast(FactSource, source if source in SOURCE_RANK else "inferred")

So a row whose source the product does not know — a partner feed, a scrape, a typo — was
RELABELLED `inferred`, which is a REAL provenance: it sits at rank 1, above `demo` (0), and
it carries `inferred`'s confidence cap. The row never claimed that provenance; the product
invented it, and the invented one is better-provenanced than the synthetic bucket the
contract reserves for data whose origin is not vouchable.

D25's ruling 3 gave the answer and the product did not take it: `demo` is a first-class
source, ranked BELOW `inferred` on purpose — *"so synthetic data states where it came from
and never outranks a real observation"*. An unknown source belongs there, not above it.

This gate holds the reader to the contract:
  * a source the product KNOWS is carried through exactly ✓;
  * a source it does NOT know resolves to `demo` ✓ — the bottom of the hierarchy ✓ — and
    never to a real provenance ✓;
  * and an unknown source's confidence is capped like `demo`'s ✓, so it cannot outrank a
    real observation ✓.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from nexus_ai.trust.facts import (
    SOURCE_CONFIDENCE_CAP,
    SOURCE_RANK,
    facts_from_rows,
)

NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
SUBJECT = "22222222-2222-2222-2222-222222222222"

#: the sources the contract names - the ones a row may claim
KNOWN = ("merchant", "observed", "imported", "third_party", "inferred", "demo")

#: the sources that are a REAL provenance - the ones an unknown must never become
REAL = ("merchant", "observed", "imported", "third_party", "inferred")


def _row(source: str, fact_id: str, confidence: float = 0.99) -> dict:
    return {
        "fact_id": fact_id,
        "subject_id": SUBJECT,
        "subject_type": "merchant",
        "attribute": "price",
        "value": {"amount": "99.00", "currency": "HKD"},
        "source": source,
        "confidence": confidence,
        "observed_at": NOW,
    }


@pytest.mark.parametrize("source", KNOWN)
def test_a_known_source_is_carried_through_exactly(source: str):
    """The row's own provenance is the product's provenance."""
    fact = facts_from_rows([_row(source, "11111111-1111-1111-1111-111111111111")],
                           now=NOW)[0]
    assert fact.source == source, (
        f"the row said {source!r} and the product made it {fact.source!r} - a source the row "
        f"never claimed")


@pytest.mark.parametrize("source", ["partner_feed", "scraped", "MERCHANT", "", "user"])
def test_an_unknown_source_never_becomes_a_real_provenance(source: str):
    """§4: resolving an unknown source to a known one is forbidden."""
    fact = facts_from_rows([_row(source, "11111111-1111-1111-1111-111111111111")],
                           now=NOW)[0]
    assert fact.source not in REAL, (
        f"the row said {source!r} - a source the product does not know - and the product "
        f"resolved it to {fact.source!r}, a REAL provenance. AGENT_CONTRACT §4: resolving "
        f"an unknown source to a known one is forbidden, because that launders where the "
        f"number came from")
    assert fact.source == "demo", (
        f"the row said {source!r} and the product made it {fact.source!r} - an unknown "
        f"source belongs in `demo`, the bottom of the hierarchy, the bucket for provenance "
        f"that is not vouchable")


def test_an_unknown_source_never_outranks_a_real_observation():
    """The point of `demo` being ranked last: unknown data never wins a conflict."""
    fact = facts_from_rows([_row("partner_feed", "11111111-1111-1111-1111-111111111111")],
                           now=NOW)[0]
    for real in REAL:
        assert SOURCE_RANK[fact.source] <= SOURCE_RANK[real], (
            f"an unknown source ranks {SOURCE_RANK[fact.source]} and {real!r} ranks "
            f"{SOURCE_RANK[real]} - the unknown one must not win")


def test_an_unknown_source_is_capped_like_demo():
    """A row that claims 0.99 confidence does not get 0.99 out of an unknown source."""
    fact = facts_from_rows([_row("partner_feed", "11111111-1111-1111-1111-111111111111")],
                           now=NOW)[0]
    assert fact.confidence <= SOURCE_CONFIDENCE_CAP["demo"], (
        f"the unknown source came out with confidence {fact.confidence} - demo's cap is "
        f"{SOURCE_CONFIDENCE_CAP['demo']}")


def test_the_demo_bucket_is_where_the_seed_data_lands():
    """D25 ruling 3: the seeded rows carry `demo` and must read as `demo`."""
    fact = facts_from_rows([_row("demo", "11111111-1111-1111-1111-111111111111")],
                           now=NOW)[0]
    assert fact.source == "demo"
    assert fact.confidence <= SOURCE_CONFIDENCE_CAP["demo"]
