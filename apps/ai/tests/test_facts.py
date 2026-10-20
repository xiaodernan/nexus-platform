"""`trust/facts.py` — the §4 grounding anchor (AGENT_CONTRACT §4, spec §19/§53).

Every AI-stated fact must resolve to one of these, and §4's conflict-resolution order
(`merchant > observed > imported > third_party > inferred > demo`), confidence ceiling,
and "conflicts are surfaced, never hidden" rule all live here. The module is pure except
for the `facts_from_rows` DB-row bridge — but it had **no tests**. This pins the contract.
DB-free.
"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID, uuid4

from nexus_ai.contract import Fact
from nexus_ai.trust.facts import (
    SOURCE_CONFIDENCE_CAP,
    SOURCE_RANK,
    FactBundle,
    better_source,
    copy_confidence_hint,
    facts_from_rows,
    pick_authoritative,
    resolve_conflicts,
    select_display_facts,
    stable_fact_id,
)

NOW = datetime(2024, 1, 1, 12, 0, tzinfo=timezone.utc)
SUBJECT = UUID("11111111-1111-1111-1111-111111111111")


def make_fact(*, source="merchant", attribute="price", value=100.0, confidence=0.9,
              subject_id=SUBJECT, observed_at=NOW) -> Fact:
    return Fact(
        fact_id=stable_fact_id("merchant", str(subject_id), attribute, value, observed_at),
        subject_type="merchant", subject_id=subject_id, attribute=attribute, value=value,
        source=source, confidence=confidence, observed_at=observed_at,
    )


# ------------------------------------------------------------- §4 source hierarchy
def test_source_rank_order():
    assert SOURCE_RANK["merchant"] > SOURCE_RANK["observed"] > SOURCE_RANK["imported"] \
        > SOURCE_RANK["third_party"] > SOURCE_RANK["inferred"] > SOURCE_RANK["demo"]
    assert better_source("merchant", "third_party") > 0
    assert better_source("third_party", "merchant") < 0
    assert better_source("merchant", "merchant") == 0


def test_source_confidence_cap_clamps_third_party_not_merchant():
    assert SOURCE_CONFIDENCE_CAP["merchant"] == 1.0
    assert SOURCE_CONFIDENCE_CAP["third_party"] == 0.7
    assert SOURCE_CONFIDENCE_CAP["inferred"] == 0.5
    b = FactBundle()
    tp = b.synth(subject_type="merchant", subject_id=SUBJECT, attribute="price",
                 value=90, source="third_party", confidence=0.99, observed_at=NOW)
    assert tp.confidence == 0.7            # third-party never out-ranks its ceiling
    mc = b.synth(subject_type="merchant", subject_id=SUBJECT, attribute="price",
                 value=100, source="merchant", confidence=0.99, observed_at=NOW)
    assert mc.confidence == 0.99            # merchant keeps its full confidence


# ------------------------------------------------------------- content-derived ids (reproducible)
def test_stable_fact_id_is_content_derived_and_deterministic():
    a = stable_fact_id("merchant", SUBJECT, "price", 100, NOW)
    assert a == stable_fact_id("merchant", SUBJECT, "price", 100, NOW)   # replay => same id
    assert a != stable_fact_id("merchant", SUBJECT, "price", 101, NOW)   # different value => different id


# ------------------------------------------------------------- ordering / pick authoritative (§4)
def test_pick_all_orders_by_source_hierarchy():
    b = FactBundle()
    b.add(make_fact(source="third_party", attribute="price", value=90))
    b.add(make_fact(source="merchant", attribute="price", value=100))
    b.add(make_fact(source="observed", attribute="price", value=95))
    ordered = b.pick_all("price", SUBJECT)
    assert [f.source for f in ordered] == ["merchant", "observed", "third_party"]


def test_pick_all_tie_broken_by_confidence():
    b = FactBundle()
    b.add(make_fact(source="merchant", attribute="price", value=100, confidence=0.7))
    b.add(make_fact(source="merchant", attribute="price", value=100, confidence=0.9))
    ordered = b.pick_all("price", SUBJECT)
    assert ordered[0].confidence == 0.9     # higher confidence wins the tie


def test_pick_authoritative_returns_best_or_none():
    facts = [make_fact(source="third_party", attribute="price", value=90),
             make_fact(source="merchant", attribute="price", value=100)]
    assert pick_authoritative(facts).source == "merchant"
    assert pick_authoritative([]) is None


# ------------------------------------------------------------- grounding at the fact level (§18/§19)
def test_explanations_cite_the_authoritative_fact_id():
    b = FactBundle()
    m = make_fact(source="merchant", attribute="price", value=100)
    b.add(m)
    b.add(make_fact(source="third_party", attribute="price", value=90))
    expl = b.explanations("price", SUBJECT, label="價錢", text="合理")
    assert len(expl) == 1
    assert expl[0].fact_id == m.fact_id     # the bullet traces to the merchant fact
    assert expl[0].label == "價錢"


def test_explanations_empty_when_no_fact():
    assert FactBundle().explanations("price", SUBJECT, "x", "y") == []


# ------------------------------------------------------------- conflicts surfaced, not hidden (§4)
def test_resolve_conflicts_surfaces_price_anomaly_warn_when_merchant_wins():
    b = FactBundle()
    m = make_fact(source="merchant", attribute="price", value=100)
    t = make_fact(source="third_party", attribute="price", value=90)
    b.add(m)
    b.add(t)
    chosen, disag = resolve_conflicts(b, "price", SUBJECT)
    assert chosen.fact_id == m.fact_id
    assert len(disag) == 1
    assert disag[0]["kind"] == "price_anomaly"
    assert disag[0]["severity"] == "warn"   # merchant is authoritative -> lower severity
    assert disag[0]["evidence"]["chosen"]["value"] == 100


def test_resolve_conflicts_same_value_is_not_a_conflict():
    b = FactBundle()
    b.add(make_fact(source="merchant", attribute="price", value=100))
    b.add(make_fact(source="third_party", attribute="price", value=100))
    chosen, disag = resolve_conflicts(b, "price", SUBJECT)
    assert chosen is not None
    assert disag == []                      # identical value => nothing to surface


def test_resolve_conflicts_high_severity_when_not_merchant():
    b = FactBundle()
    obs = make_fact(source="observed", attribute="price", value=100)
    tp = make_fact(source="third_party", attribute="price", value=90)
    b.add(obs)
    b.add(tp)
    chosen, disag = resolve_conflicts(b, "price", SUBJECT)
    assert chosen.source == "observed"      # observed(4) outranks third_party(2)
    assert disag[0]["severity"] == "high"   # no merchant anchor => escalate


# ------------------------------------------------------------- §4 confidence phrasing (never upgrades)
def test_copy_confidence_hint_never_upgrades():
    assert copy_confidence_hint(0.3) == "omit_and_offer_handoff"
    assert copy_confidence_hint(0.5) == "phrase_as_uncertain"
    assert copy_confidence_hint(0.9) is None


# ------------------------------------------------------------- display selection ordering
def test_select_display_facts_respects_requested_order_and_skips_missing():
    b = FactBundle()
    b.add(make_fact(attribute="rating", value=4.7))
    b.add(make_fact(attribute="price", value=100))
    b.add(make_fact(attribute="distance", value=300))
    out = select_display_facts(b, SUBJECT, ["rating", "price"])
    assert [f.attribute for f in out] == ["rating", "price"]
    out2 = select_display_facts(b, SUBJECT, ["rating", "nonexistent"])
    assert [f.attribute for f in out2] == ["rating"]   # missing attribute skipped


# ------------------------------------------------------------- synth idempotency
def test_synth_is_idempotent_and_marks_observed():
    b = FactBundle()
    f1 = b.synth(subject_type="merchant", subject_id=SUBJECT, attribute="open_now",
                 value=True, observed_at=NOW)
    f2 = b.synth(subject_type="merchant", subject_id=SUBJECT, attribute="open_now",
                 value=True, observed_at=NOW)
    assert f1.fact_id == f2.fact_id      # same content + observed_at => same id (reproducible SSE)
    assert f1.source == "observed"
    assert f1.stale is False


# ------------------------------------------------------------- bundle indexing helpers
def test_bundle_indexing():
    b = FactBundle()
    b.add(make_fact(subject_id=SUBJECT, attribute="price", value=100))
    b.add(make_fact(subject_id=SUBJECT, attribute="rating", value=4.7))
    assert len(b.by_subject(SUBJECT)) == 2
    assert len(b.by_attribute("price", SUBJECT)) == 1
    assert b.values("price") == {"100"}
    assert len(b.ids()) == 2


# ------------------------------------------------------------- DB-row bridge clamps + flags
def test_facts_from_rows_clamps_confidence_parses_value_flags_stale_and_skips_bad_uuid():
    rows = [
        {"fact_id": str(uuid4()), "subject_id": str(SUBJECT), "attribute": "price",
         "value": '{"amount":100}', "source": "third_party", "confidence": 0.99,
         "observed_at": NOW, "stale": False},
        {"fact_id": str(uuid4()), "subject_id": str(SUBJECT), "attribute": "rating",
         "value": 4.7, "source": "merchant", "confidence": 0.9,
         "observed_at": NOW, "stale": True},
        {"fact_id": "not-a-uuid", "subject_id": str(SUBJECT), "attribute": "x",
         "value": 1, "source": "inferred", "observed_at": NOW},   # bad uuid -> skipped
    ]
    facts = facts_from_rows(rows, now=NOW)
    assert len(facts) == 2                      # the malformed row is dropped
    tp = [f for f in facts if f.source == "third_party"][0]
    assert tp.confidence == 0.7                  # clamped from 0.99
    assert tp.value == {"amount": 100}           # JSON string parsed to dict
    merchant = [f for f in facts if f.source == "merchant"][0]
    assert merchant.stale is True                # forced_stale respected
