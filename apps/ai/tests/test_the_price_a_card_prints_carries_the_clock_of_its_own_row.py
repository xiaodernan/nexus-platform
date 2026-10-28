"""D589 - the price a card prints is grounded in the clock of the row it came from.

AGENT_CONTRACT §4 says anything shown to a user must resolve to a fact, and §5 says a stale
price is surfaced rather than silently rendered - "價格可能已更新". Both of those promises run
through one lookup:

    price_fact = bundle.get("price", card.id) or bundle.get("avg_price_hkd", card.id)   # cards.py

`bundle` is the `facts` table. The number the card prints is not: `_price_of` renders
`cand.price`, which is the row's own `price_amount` column. Measured at HEAD on the demo plane
this is not a corner case - 3,373 of its 4,707 active offerings on published merchants have no
`price` fact for their own subject at all, so those cards print a price with no fact behind it
(nothing to cite under §4) and no staleness (nothing to surface under §5). The web's own
reader makes the consequence concrete: `resolvedPrice` returns null for a card with no price
fact, and the page renders its unverified marker over the merchant's own published number,
because the reader looked in the wrong table.

The row does carry the clock. `V1__init.sql:228` annotates `offerings.price_updated_at` as
"drives freshness TTL (§20)", `OfferingRepository` stamps it `now()` on every price write and
sends it in the offering projection, and `sql.py:454` selects it into the candidate row the card
is built from - and nothing compares it. Every price clock on this plane is 36 days old against
`FRESHNESS_TTL["price"] = 6h`, so "old" is the whole corpus and the gap is total.

The second half lives one file over: `FactBundle.synth` sets `stale=ttl <= 0 and False`, which is
`False` for every attribute - a computed fact could never be stale however old its observation.
Grounding the printed price through `synth` therefore needs the clock to decide `stale`, the same
way the stored rows' read already does (`facts_from_rows` -> `freshness.evaluate`, "the DB flag
never overrides the clock").

Proved to fail, one arm each (`tmp/d589_arms.py`, each arm restoring its file byte-identically):
removing the grounding block reddens five rows - the two stale halves, the fresh control's
stamp, the estimated-source row and the live one; stamping the fact with the request time
instead of the row's clock reddens four, including the fresh control, so the gate is about the
clock and not about a fact existing; putting `stale=ttl <= 0 and False` back in `synth` reddens
the three staleness rows; writing the fact into the bundle but not onto the card reddens only
row 1; dropping the "already vouched" guard reddens only the duplication row; promoting an
unknown source to `merchant` reddens only the estimated row; and filling a missing clock with
`now` reddens only the merchant row that has no clock column.

`test_facts.py::test_synth_is_idempotent_and_marks_observed` asserted `stale is False` for a
synthesised fact, which was the constant's answer rather than the clock's; it now asserts both
halves - the 2024 observation is stale, a request-time one is not.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from nexus_ai.contract import Fact
from nexus_ai.search.cards import attach_price_staleness, build_card, drop_ungrounded_reasons
from nexus_ai.search.ranking import Candidate
from nexus_ai.trust.facts import FactBundle
from nexus_ai.trust.freshness import FRESHNESS_TTL, evaluate, stale_copy

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

#: the request clock the pipeline hands the card (`raw["as_of"] = plan.now`). `synth` answers
#: staleness against the wall clock, so the stamps below are relative to it - an absolute date
#: here silently became "hours ago" and the fresh control expired.
NOW = datetime.now(timezone.utc).replace(microsecond=0)
#: six days past this plane's newest offering clock, and far outside the 6h price TTL.
OLD = NOW - timedelta(days=36)
#: inside the TTL, which is the state the demo plane has no row in.
FRESH = NOW - timedelta(hours=1)
SUBJECT = uuid4()
MERCHANT = uuid4()

_PRICE_TTL = timedelta(seconds=FRESHNESS_TTL["price"])


def _offering_row(**over):
    """A row shaped like `build_offering_query`'s output - the columns the card reads."""
    row = {"id": SUBJECT, "subject_id": str(SUBJECT), "subject_type": "offering",
           "merchant_id": MERCHANT, "merchant_id_key": str(MERCHANT), "slug": "test-product",
           "name": "Test product", "kind": "product", "price_amount": 460.0,
           "price_min": None, "price_max": None, "currency": "HKD", "price_model": "fixed",
           "price_source": "merchant", "price_updated_at": OLD, "avg_price_hkd": 300.0,
           "data_origin": "demo", "rating_agg": 4.2, "review_count": 30}
    row.update(over)
    return row


def _card(row, bundle=None):
    cand = Candidate(subject_type="offering", subject_id=str(row["subject_id"]),
                     merchant_id=str(row["merchant_id"]), price=row.get("price_amount"),
                     rating=row.get("rating_agg"), rating_count=row.get("review_count") or 0,
                     raw={"row": row, "as_of": NOW})
    bundle = FactBundle() if bundle is None else bundle
    return build_card(cand, None, bundle, locale="zh-HK"), bundle


def _price_facts(bundle, subject):
    return bundle.by_attribute("price", subject)


# ------------------------------------------------------------------- the grounding
def test_the_printed_price_carries_a_fact_stamped_with_the_rows_own_clock():
    card, bundle = _card(_offering_row())
    facts = _price_facts(bundle, card.id)
    assert facts, (
        f"the card prints {card.price.amount} {card.price.currency} with no price fact behind "
        f"it - §4 says a rendered number must resolve to a fact, and the web's resolvedPrice "
        f"renders its unverified marker rather than the merchant's own published price")
    fact = facts[0]
    assert fact.observed_at == OLD, (
        f"the price fact is stamped {fact.observed_at} but the row's own price clock "
        f"(price_updated_at, V1's 'drives freshness TTL') says {OLD} - stamping the request "
        f"time launders a 36-day-old number into a fresh one")
    assert float(str(fact.value["amount"])) == 460.0, (
        f"the fact vouches for {fact.value!r} while the card prints "
        f"{card.price.amount} - the citation has to name the number shown")
    assert [f.fact_id for f in card.facts].count(fact.fact_id) == 1, (
        f"the card's own facts[] is where the renderer and the verifier read from, and the "
        f"price fact is cited {[f.attribute for f in card.facts]} - in the bundle only is not "
        f"on the card")
    assert evaluate(fact.observed_at, "price", now=NOW).stale is True
    assert fact.stale is True, (
        "the price is 36 days past a 6-hour TTL and the card reports it as fresh")


def test_a_price_past_its_ttl_is_surfaced_with_the_copy_the_contract_names():
    card, bundle = _card(_offering_row())
    attach_price_staleness(card, bundle)
    stale = [r for r in (card.ai_match.reasons if card.ai_match else [])
             if r.label == "price_stale"]
    assert stale, (
        "a stale price rendered silently: attach_price_staleness found nothing to surface, so "
        "§5's '價格可能已更新' never reaches a card whose whole corpus is past its TTL")
    assert stale[0].text == stale_copy("zh-HK")
    assert stale[0].fact_id is not None, (
        "the stale marker cites no fact - the bullet is ungrounded and §4 refuses it")
    kept, dropped = drop_ungrounded_reasons(card)
    assert dropped == 0, (
        f"the reason the card raised was itself dropped as ungrounded ({dropped}) - the "
        f"staleness would be surfaced by the builder and deleted by the gate")
    assert [r.label for r in kept.ai_match.reasons] == ["price_stale"]


def test_a_price_inside_its_ttl_renders_without_the_warning():
    card, bundle = _card(_offering_row(price_updated_at=FRESH))
    facts = _price_facts(bundle, card.id)
    assert facts, "a fresh price still needs its fact - the grounding is not a staleness device"
    assert facts[0].stale is False
    assert facts[0].observed_at == FRESH
    attach_price_staleness(card, bundle)
    assert not [r for r in card.ai_match.reasons if r.label == "price_stale"], (
        "a price inside its TTL was marked stale - the check would then warn on every card "
        "and the warning would stop meaning anything")


def test_a_price_the_facts_table_already_vouches_for_is_not_duplicated():
    stored = Fact(fact_id=uuid4(), subject_type="offering", subject_id=SUBJECT,
                  attribute="price", value={"amount": "420.00", "currency": "HKD"},
                  source="observed", confidence=0.9, observed_at=NOW - timedelta(hours=2))
    card, bundle = _card(_offering_row(), FactBundle(facts=[stored]))
    facts = _price_facts(bundle, card.id)
    assert [f.fact_id for f in facts] == [stored.fact_id], (
        f"the read wrote its own price fact next to the stored one ({facts}) - two facts for "
        f"one number is the §4 conflict path, and the card would flag its own synthesis as a "
        f"disagreement")
    cited = next(f for f in card.facts if f.attribute == "price")
    assert cited.fact_id == stored.fact_id


# ------------------------------------------------------------------- what may not be claimed
def test_a_number_with_no_clock_on_the_row_gets_no_invented_timestamp():
    """`merchants` has no price clock column at all - an `avg_price_hkd` with no `facts` row
    must not be stamped `now` to look fresh."""
    row = _offering_row(subject_type="merchant", subject_id=str(MERCHANT),
                        price_amount=None, avg_price_hkd=300.0, price_updated_at=None,
                        merchant_id=MERCHANT)
    cand = Candidate(subject_type="merchant", subject_id=str(MERCHANT),
                     merchant_id=str(MERCHANT), price=300.0, raw={"row": row, "as_of": NOW})
    bundle = FactBundle()
    card = build_card(cand, None, bundle, locale="zh-HK")
    assert not _price_facts(bundle, card.id), (
        "the reader invented a price fact for a column that carries no clock - the number "
        "would arrive stamped as fresh as the request with nothing to show for it")


def test_an_estimated_price_is_not_promoted_to_a_merchant_claim():
    """`offerings.price_source` admits `estimated`; D501's no-laundering rule says an unknown
    source never becomes a vouchable one."""
    card, bundle = _card(_offering_row(price_source="estimated"))
    facts = _price_facts(bundle, card.id)
    assert facts, "the estimated price lost its grounding too - the gate is about provenance"
    assert facts[0].source != "merchant", (
        f"price_source='estimated' came back vouched as {facts[0].source!r} - the row says "
        f"nobody quoted this number, and the fact would say a merchant did")
    assert facts[0].confidence < 0.6, (
        f"confidence {facts[0].confidence} on an estimated price - the renderer's uncertain "
        f"line is 0.6 and the number would read as a merchant's own claim")
    assert card.flags.estimated_price is True


# ------------------------------------------------------------------- the synthesiser itself
def test_a_synthesised_fact_stale_is_the_clocks_answer_not_a_constant():
    bundle = FactBundle()
    old = bundle.synth(subject_type="offering", subject_id=SUBJECT, attribute="price",
                       value={"amount": "10.00", "currency": "HKD"}, source="merchant",
                       confidence=0.9, observed_at=OLD)
    assert old.stale is True, (
        "`stale=ttl <= 0 and False` is False for every attribute - a computed fact stamped "
        "36 days ago can never be stale, so any gate that reads `.stale` is reading a constant")
    fresh = bundle.synth(subject_type="offering", subject_id=SUBJECT, attribute="price",
                         value={"amount": "11.00", "currency": "HKD"}, source="merchant",
                         confidence=0.9, observed_at=FRESH)
    assert fresh.stale is False, "the clock must be able to say fresh as well as stale"
    assert old.expires_at == OLD + _PRICE_TTL
    availability = bundle.synth(subject_type="merchant", subject_id=SUBJECT,
                                attribute="availability", value={"status": "available"},
                                source="observed", confidence=0.95, observed_at=NOW)
    assert availability.stale is False, (
        "a real-time attribute (TTL 0) is not stale by definition - it is never cached")


# ------------------------------------------------------------------- the plane it runs on
def _run(query: str, params) -> list[dict]:
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    settings = Settings(llm_provider="mock", embedding_provider="hashing",
                        database_url=DB_URL, internal_token="0" * 8)

    async def _go():
        db = await db_pool.connect(settings, force_new=True)
        try:
            return await db.readonly(query, *params)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live_only
def test_the_live_offering_card_grounds_the_price_it_prints():
    import nexus_ai.search.sql as SQL
    from nexus_ai.search.service import DEFAULT_TENANT_ID

    cq = SQL.build_offering_query(tenant_id=str(DEFAULT_TENANT_ID), text=None, filters={},
                                  limit=5)
    assert "price_updated_at" in cq.sql, (
        "the offering read stopped selecting the price clock - the card has nothing left to "
        "compare and this gate has no subject")
    rows = _run(cq.sql, cq.params)
    priced = [r for r in rows if r.get("price_amount") is not None]
    assert priced, f"the offering lane returns no priced row: {rows[:1]}"
    row = priced[0]
    card, bundle = _card(row)
    facts = _price_facts(bundle, card.id)
    assert facts, (
        f"the shipped builder printed {card.price.amount} for live offering "
        f"{row['subject_id']} with no price fact - the case the contract promises to ground")
    assert facts[0].observed_at == row["price_updated_at"], (
        f"live offering {row['subject_id']}: the fact says {facts[0].observed_at}, the row's "
        f"own clock says {row['price_updated_at']}")


@live_only
def test_the_plane_this_runs_on_is_all_clock_and_no_fact():
    """Recording the measurement the fix is sized against, so a refreshed plane says so."""
    census = _run("""
select count(*) as offerings,
       count(*) filter (where o.price_updated_at <= now() - make_interval(secs => $1))
         as past_price_ttl,
       count(*) filter (where not exists (select 1 from facts f
             where f.subject_id = o.id and f.attribute = 'price')) as no_price_fact
from offerings o join merchants m on m.id = o.merchant_id
where o.status = 'active' and m.status = 'published' and o.price_amount is not null
""", (int(FRESHNESS_TTL["price"]),))
    assert census, "no priced offerings on this plane - the gate above has nothing to measure"
    row = census[0]
    assert row["no_price_fact"] > 0, (
        f"every priced offering now has its own price fact ({row}) - the grounding is still "
        f"right, but the plane no longer shows the gap and a real stale-price row can be "
        f"written instead of measured")
    assert row["past_price_ttl"] == row["offerings"], (
        f"some priced offering is inside its 6h TTL ({row}) - the corpus moved, so re-check "
        f"the fresh-vs-stale controls above against the real ages")
