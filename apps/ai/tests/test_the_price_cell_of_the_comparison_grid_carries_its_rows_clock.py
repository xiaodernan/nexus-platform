"""D590 - the price cell of the comparison grid carries the clock of its own row.

§4 and §5 have a second reader. D589 grounded the number a SEARCH CARD prints; `/ai/v1/compare`
builds its table in `routes_discover._grid`, and the price cell did the same thing the card did:
it asks the facts table (`bundle.get("price", sid)`) and, finding nothing, prints
`row["avg_price_hkd"]` in a cell whose `fact_id` is null. `_cell` is what the web renders a
comparison value from, and a cell with no fact id is the unverified marker - so the grid prints
the merchant's own published price and calls it unverified, for every subject whose price lives
in a column rather than in `facts`.

The compare read is one step further behind than the card read was. `sql.entities_for` selects
`COALESCE(o.price_amount, o.price_min) AS avg_price_hkd` for an offering and does not select
`o.price_updated_at` at all, so the grid cannot even see the clock V1 annotates as "drives
freshness TTL (§20)" (`V1__init.sql:228`). The fix therefore has two halves, and the second is
what keeps the first honest: a cell may only be stamped with a clock its own row carries.
`merchants.avg_price_hkd` (V1:93) has no price clock beside it, and `m.updated_at` moves when the
description moves, so a merchant cell keeps its unverified marker rather than inheriting a stamp
that would launder the number's age.

Measured on this plane (the door below re-reads it, so the figures live): every active, published
offering with a price is past the 6h price TTL and most have no `price` fact for their own
subject, which is the population whose cells print a number and cite nothing.

Arms, measured (`tmp/d590_arms.py` and `tmp/d590fu_arms.py`; each file restored byte-identically,
the rows each moved named by the run):

* the grid stops grounding its cell - 11 of the 14 rows, including all five source ids except
  the merchant's own and all three live rows;
* the cell stamped with the request time (the kernel's `observed_at=stamp` dropped, so `synth`
  takes its own clock) - the stamped-clock row, the past-TTL id, the live read row and the
  both-branches row. The inside-TTL id stays green, which is its right: a now-stamped number IS
  fresh;
* `synth`'s `stale` back to the constant - the past-TTL id here, three rows on the card door;
* the kernel's already-vouched guard dropped - **14 passed here**, one row red on the D589 card
  door. The grid cannot reach that guard: its price branch is an `elif` after the stored-fact
  lookup, so a subject that already has a `price` fact never calls the kernel. This door's
  no-twin row is carried instead by the grid reading the stored fact at all
  (`bundle.get("price", sid)` emptied), which reddens it and the both-branches row;
* the compare read stops carrying the clock - the offering branch's values nulled with the
  aliases kept reddens the three live rows on their grounding asserts, and dropping the column
  from both branches reddens the same three with the text gate itself moving
  (`:195`, read with `--tb=line`);
* an unearned `price_source` promoted to a merchant claim - the estimated, blank, absent and
  observed ids, the merchant's own id correctly unmoved, plus the card door's estimated row;
* a missing clock filled with `now` - this door's merchant row and the card door's
  no-invented-timestamp row.
"""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from nexus_ai.api.routes_discover import _grid
from nexus_ai.trust.facts import FactBundle
from nexus_ai.trust.freshness import FRESHNESS_TTL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

#: the request clock `_compare` hands the grid. Stamps below are relative to it: an absolute
#: date here drifts past the 6h TTL while the test is being written (D589 learned this).
NOW = datetime.now(timezone.utc).replace(microsecond=0)
OLD = NOW - timedelta(days=36)
FRESH = NOW - timedelta(hours=1)


def _row(**over):
    """An offering row in the shape `sql.entities_for` returns it.

    The column list matters more than the values: the grid may only claim what the read
    selects, so a fixture that hands over a clock the shipped SQL never fetches would prove
    nothing about the shipped path.
    """
    row = {
        "subject_id": str(uuid4()), "subject_type": "offering",
        "merchant_id": str(uuid4()), "slug": "oak-fire-ramen", "name": "Oak Fire Ramen",
        "name_zh": None, "kind": "set_meal", "category": "japanese",
        "avg_price_hkd": 168.0, "currency": "HKD", "price_model": None,
        "rating_agg": 4.4, "review_count": 12, "description": None,
        "data_origin": "seeded", "plan": "pro", "attributes": {}, "images": [],
        "ai_agent_enabled": True, "status": "active",
        "price_updated_at": OLD, "price_source": "merchant",
    }
    row.update(over)
    return row


def _grid_row(row, bundle=None):
    bundle = bundle if bundle is not None else FactBundle(facts=[])
    grid = _grid([row], bundle, {}, now=NOW, locale="zh-HK")
    price = next(r for r in grid if r["attribute"] == "price")
    return price["cards"][0], bundle, grid


def _price_facts(bundle, subject_id):
    return [f for f in bundle.facts
            if f.attribute in ("price", "avg_price_hkd")
            and str(f.subject_id) == str(subject_id)]


# ------------------------------------------------------------------ the grounding
def test_the_price_cell_carries_a_fact_stamped_with_the_rows_own_clock():
    row = _row()
    cell, bundle, _rows = _grid_row(row)
    assert cell["fact_id"], (
        f"the grid prints {cell['value']} in a cell with no fact id - §4 says a rendered "
        f"number resolves to a fact, and the web renders this cell as unverified")
    facts = _price_facts(bundle, row["subject_id"])
    assert facts, f"the cell cites {cell['fact_id']}, which is not a fact about this subject"
    assert str(facts[0].fact_id) == cell["fact_id"], (
        f"the cell cites {cell['fact_id']} but the bundle holds {facts[0].fact_id}")
    assert facts[0].observed_at == OLD, (
        f"the cell's fact is stamped {facts[0].observed_at} while the row's own price clock "
        f"(price_updated_at) says {OLD} - stamping the request time launders a 36-day-old "
        f"number into a fresh one, which is what §5 forbids")


@pytest.mark.parametrize("clock,want", [(OLD, True), (FRESH, False)],
                         ids=["past the 6h TTL", "inside it"])
def test_the_cells_staleness_is_the_clocks_answer(clock, want):
    row = _row(price_updated_at=clock)
    cell, bundle, _rows = _grid_row(row)
    assert cell["fact_id"], "the cell cites nothing, so the grid has no age to surface"
    facts = _price_facts(bundle, row["subject_id"])
    assert facts, f"the cell cites {cell['fact_id']} and no fact of this subject matches it"
    assert facts[0].stale is want, (
        f"a price observed {clock} reports stale={facts[0].stale}, the TTL is "
        f"{FRESHNESS_TTL['price']}s and the request clock is {NOW}")


# ------------------------------------------------------------------ what it must not do
def test_a_subject_that_already_has_a_price_fact_is_not_given_a_second_one():
    stored = FactBundle(facts=[])
    subject = uuid4()
    row = _row(subject_id=str(subject))
    vouch = stored.synth(subject_type="offering", subject_id=subject, attribute="price",
                         value={"amount": 99.0, "currency": "HKD"}, source="merchant",
                         observed_at=FRESH)
    cell, bundle, _rows = _grid_row(row, stored)
    assert cell["fact_id"] == str(vouch.fact_id), (
        f"the cell cites {cell['fact_id']} while the facts table already vouched for "
        f"{vouch.fact_id} - two price facts for one subject is a §4 conflict the grid "
        f"would be inventing, not reporting")
    assert len(_price_facts(bundle, subject)) == 1
    assert _price_facts(bundle, subject)[0].observed_at == FRESH, (
        "the stored fact's clock was overwritten by the row's - the merchant's own statement "
        "is the older witness of the two")


def test_a_merchant_row_with_no_price_clock_claims_nothing():
    row = _row(subject_type="merchant", avg_price_hkd=410.0, price_updated_at=None,
               price_source=None, kind=None)
    cell, bundle, _rows = _grid_row(row)
    assert cell["value"] is not None, "the merchant's published average stopped rendering"
    assert cell["fact_id"] is None, (
        f"the grid stamped a merchant price with {cell['observed_at']} - merchants have no "
        f"price_updated_at column (V1:93), and m.updated_at moves when the description does")
    assert not _price_facts(bundle, row["subject_id"])


#: the three spellings this plane's `price_source` column actually holds, measured:
#: merchant 4,710 / estimated 559 / observed 265 offerings.
@pytest.mark.parametrize("price_source,want_source", [
    ("estimated", "demo"), ("", "demo"), (None, "demo"), ("observed", "observed"),
    ("merchant", "merchant"),
], ids=["estimated", "blank", "absent", "observed", "merchant's own"])
def test_the_cell_reports_the_source_the_row_gives(price_source, want_source):
    row = _row(price_source=price_source)
    cell, bundle, _rows = _grid_row(row)
    assert cell["source"] == want_source, (
        f"a price the row labels {price_source!r} was reported as {cell['source']!r} - D501's "
        f"rule: an unearned word is not promoted to a merchant claim")


# ------------------------------------------------------------------- the shipped read
def _run(query, *params):
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
def test_the_compare_read_selects_the_clock_the_cell_is_stamped_with():
    from nexus_ai.search.service import DEFAULT_TENANT_ID
    from nexus_ai.search.sql import entities_for

    subject_ids = [r["id"] for r in _run("""
        select o.id::text from offerings o join merchants m on m.id = o.merchant_id
        where o.status='active' and m.status='published'
          and coalesce(o.price_amount, o.price_min) is not null
          and not exists (select 1 from facts f where f.subject_id = o.id
                          and f.attribute = 'price')
        limit 2""")]
    assert subject_ids, "no offering on this plane lacks its own price fact"
    text, params = entities_for(str(DEFAULT_TENANT_ID), subject_ids)
    assert "price_updated_at" in text, (
        "the compare read stopped selecting the offering's price clock - the grid has "
        "nothing left to stamp a cell with")
    rows = _run(text, *params)
    priced = [r for r in rows if r.get("subject_type") == "offering"]
    assert priced, f"the shipped compare read returned no offering row: {rows[:1]}"
    row = priced[0]
    cell, bundle, _rows = _grid_row(row)
    assert cell["fact_id"], (
        f"live offering {row['subject_id']}: the grid prints {cell['value']} and cites "
        f"nothing - the case §4 promises to ground")
    fact = _price_facts(bundle, row["subject_id"])[0]
    assert fact.observed_at == row["price_updated_at"], (
        f"live offering {row['subject_id']}: the cell says {fact.observed_at}, the row's "
        f"own clock says {row['price_updated_at']}")


@live_only
def test_a_grounded_cell_reaches_the_comparisons_citation_list():
    """The cells that carry a fact are the answer's citations - a cell outside that list is
    a number the response never vouched for."""
    from nexus_ai.api.routes_discover import _compare_fact_ids
    from nexus_ai.search.service import DEFAULT_TENANT_ID
    from nexus_ai.search.sql import entities_for

    offering = _run("""
        select o.id::text from offerings o join merchants m on m.id = o.merchant_id
        where o.status='active' and m.status='published' and o.price_amount is not null
          and not exists (select 1 from facts f where f.subject_id = o.id
                          and f.attribute='price')
        limit 1""")[0]["id"]
    text, params = entities_for(str(DEFAULT_TENANT_ID), [offering])
    rows = _run(text, *params)
    _cell, bundle, grid = _grid_row(rows[0])
    cited = _compare_fact_ids(grid)
    assert str(bundle.get("price", offering).fact_id) in cited, (
        f"the price cell's fact {bundle.get('price', offering).fact_id} never reached the "
        f"citations ({cited}) - grounded in the grid, ungrounded in the response")


@live_only
def test_both_branches_of_one_real_comparison_cite_what_each_row_can_support():
    """The UNION is where a column list goes wrong quietly: the offering branch carries a
    price clock and the merchant branch carries NULLs for it, and one grid has to answer
    differently for the two subjects without shifting a value into the wrong column."""
    from nexus_ai.search.service import DEFAULT_TENANT_ID
    from nexus_ai.search.sql import entities_for, facts_for
    from nexus_ai.trust.facts import facts_from_rows

    pair = _run("""
        select o.merchant_id::text as merchant, o.id::text as offering
        from offerings o join merchants m on m.id = o.merchant_id
        where o.status='active' and m.status='published'
          and m.avg_price_hkd is not null and coalesce(o.price_amount, o.price_min) is not null
          and exists (select 1 from facts f where f.subject_id = m.id
                      and f.attribute = 'price')
          and not exists (select 1 from facts f where f.subject_id = o.id
                          and f.attribute = 'price')
        limit 1""")
    assert pair, "no merchant with its own price fact has an offering without one on this plane"
    ids = [pair[0]["merchant"], pair[0]["offering"]]
    text, params = entities_for(str(DEFAULT_TENANT_ID), ids)
    rows = _run(text, *params)
    by_subject = {str(r["subject_id"]): r for r in rows}
    assert set(by_subject) == set(ids), f"the compare read lost a branch: {list(by_subject)}"
    fact_text, fact_params = facts_for(ids, ["price", "rating", "category"])
    bundle = FactBundle(facts_from_rows(_run(fact_text, *fact_params), now=NOW))
    grid = _grid(rows, bundle, {}, now=NOW, locale="zh-HK")
    cells = {str(r["subject_id"]): c
             for r, c in zip(rows, next(g["cards"] for g in grid if g["attribute"] == "price"))}

    stored = bundle.get("price", pair[0]["merchant"])
    merchant = cells[pair[0]["merchant"]]
    assert merchant["value"] is not None, "the merchant's published average stopped rendering"
    assert merchant["fact_id"] == str(stored.fact_id), (
        f"the merchant cell cites {merchant['fact_id']} while the facts table vouches for it "
        f"as {stored.fact_id} - the row's NULL clock must not become a second witness")
    assert merchant["observed_at"] == stored.observed_at.isoformat(), (
        f"the cell reports {merchant['observed_at']} and the stored fact says "
        f"{stored.observed_at} - the reader rewrote the age of a merchant's own number")

    offering = cells[pair[0]["offering"]]
    row = by_subject[pair[0]["offering"]]
    assert offering["fact_id"], f"the offering cell prints {offering['value']} and cites nothing"
    assert offering["observed_at"] == row["price_updated_at"].isoformat(), (
        f"the cell says {offering['observed_at']} and the row's clock says "
        f"{row['price_updated_at']}")


@live_only
def test_the_plane_this_runs_on_is_clocks_with_no_fact_behind_the_cell():
    """The measurement the fix is sized against, so a refreshed plane says so."""
    census = _run("""
        select count(*) as priced_offerings,
               count(*) filter (where not exists (select 1 from facts f
                     where f.subject_id = o.id and f.attribute = 'price')) as no_price_fact,
               count(*) filter (where o.price_updated_at <= now() - make_interval(secs => $1))
                     as past_price_ttl
        from offerings o join merchants m on m.id = o.merchant_id
        where o.status='active' and m.status='published'
          and coalesce(o.price_amount, o.price_min) is not null""",
        int(FRESHNESS_TTL["price"]))
    assert census, "no priced offerings on this plane"
    row = census[0]
    assert row["no_price_fact"] > 0, (
        f"every priced offering has its own price fact now ({row}) - the grounding is still "
        f"right, but this plane no longer shows the gap; write a real row instead")
    assert row["past_price_ttl"] == row["priced_offerings"], (
        f"some priced offering is inside its TTL ({row}) - the corpus moved, re-check the "
        f"fresh/stale controls above against the real ages")
