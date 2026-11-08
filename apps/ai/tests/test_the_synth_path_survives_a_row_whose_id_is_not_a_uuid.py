"""D758 - a computed Fact survives a row whose subject_id is not a UUID.

The static fixture backend serves rows whose `subject_id`/`merchant_id` are `m1`-style
identifiers, not UUIDs. The renderer synthesises facts against those ids on every request:

* `synth_computed_facts` fell back to a content-derived id (`stable_fact_id`), so its
  distance/open-state/availability facts survived;
* `cards.py`'s `category_match` fact and price fact passed the RAW id into
  `FactBundle.synth`, which did `UUID(str(subject_id))` unconditionally - so a Chinese
  query that earned a card on the static plane raised `ValueError: badly formed
  hexadecimal UUID string` and the answer vanished into a 500.

D758 makes the bundle itself resilient: a UUID passes through unchanged; anything else
gets a content-derived id the same way the sibling readers already do. The two detector
tests that caught it (`test_parking_transient`, `test_pet_friendly_transient`) are the
end-to-end proof; this unit locks the unit-level contract.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from nexus_ai.trust.facts import FactBundle


def _synth(bundle: FactBundle, subject_id) -> object:
    return bundle.synth(
        subject_type="merchant", subject_id=subject_id,
        attribute="price", value={"amount": "50", "currency": "HKD"},
        source="inferred", observed_at=datetime(2026, 11, 8, tzinfo=timezone.utc))


def test_a_non_uuid_subject_id_still_produces_a_fact():
    bundle = FactBundle()
    fact = _synth(bundle, "m1")
    # the contract requires a UUID on the wire; the fallback is deterministic
    again = _synth(bundle, "m1")
    assert fact.subject_id == again.subject_id


def test_a_valid_uuid_passes_through_unchanged():
    uid = UUID("00000000-0000-0000-0000-0000000000ab")
    bundle = FactBundle()
    fact = _synth(bundle, str(uid))
    assert fact.subject_id == uid
