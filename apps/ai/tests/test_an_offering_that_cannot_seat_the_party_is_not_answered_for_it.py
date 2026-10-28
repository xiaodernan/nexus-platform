"""D607 - an offering that cannot seat the party is still answered for it.

`offerings` carries the party a booking physically fits: `bookable`, `min_party_size`,
`max_party_size`, `duration_minutes` (`docs/DATABASE.md:72` calls these the Booking columns).
The AI lane's offering SELECT already reads two of them into the row
(`nexus_ai/search/sql.py:555`, `o.bookable, o.min_party_size, o.max_party_size`) and the plan
already knows the party (`service.py:442` `SearchPlan.party_size`, filled from the intent at
`:660`, and already used hard against slot capacity - `sql.py:637`
`AND capacity_left >= :party_size`). What nobody does is compare the party to the offering's own
bounds: `build_offering_query` (`sql.py:410`) had no party parameter, `_filter_static`
(`service.py:223`) had none either, and `ReservationService.book` checks the SLOT's capacity
(`:108`) but never the offering's cap - so a booking the recommendation proposes is not refused
downstream either.

Measured on the live plane (`tmp/d606_probe.py`, offering lane, top 12 per query):

    query      party  rows that carry bounds  answers that cannot seat them
    下午茶          4     3                      1  posture-assessment-afternoon (1-2)
    下午茶          8     3                      2  + trial-class-afternoon (1-4)
    下午茶         12     3                      3  + skin-analysis-consult-afternoon (1-8)
    晚餐           4     2                      2  gel-nails (1-2), soak-off-reshape-weekend (1-2)
    bookable      8     1                      1  lane-booking-per-hour-large (1-6)

The bounds are not noise on this corpus: 804 of 5,534 offerings carry both, every one of them
bookable, and `max_party_size` takes the values 2, 4, 6, 8 and 10 (267 rows cap at 2, 538 cap
below 8). The `min_party_size` half has no live victim - `count(*) filter (where min_party_size
> 1)` is 0 - so that side is carried here by the fixture lane, which is the lane that can show
it. Unbounded rows are the majority (4,730), and they are what the over-filtering failure mode
looks like: a clause written as `max_party_size >= :party` with no NULL arm would delete every
offering that never stated a cap.

HOW the removal is measured was itself two measurements, not a guess:

* an offering's `slug` is not a row key. 5,534 offerings share 1,623 slugs, and the same slug
  carries different bounds across its rows (`executive-suite` appears 9 times with caps
  None/2/4/6). Every set comparison here is keyed on `id`.
* a 200-row page cannot answer "what did the clause remove". `下午茶` serves 200 rows over 27
  distinct `(kw_score, rating_agg)` ordering keys, and 148 of the 200 share ONE key - the cut
  falls inside a tie group, so which row wins it is the planner's business: adding the party
  predicate replaced 21 of the page's rows, 9 of which fit the party perfectly. Asking
  "exactly those that cannot fit" of a cut page therefore measures the plan, not the clause.
  The removal is asserted instead on whole per-merchant populations (`POPULATION`, merchants
  holding both shapes in fewer offerings than the page limit), where the answer IS the
  population and set equality is meaningful. The tie behaviour is filed in PLAN as its own
  question; this unit does not repair it and does not hide it.

The merchant lane is deliberately NOT touched by this claim: `merchants` has no party columns,
and "a merchant whose every offering caps at 2 cannot host 8" is an aggregation rule nobody has
documented - filed in PLAN rather than invented here.

Both lanes must answer the same question (D449), so the live clause and the fixture mirror are
asserted together, and the party is a bound parameter, not a number interpolated into SQL.
"""

from __future__ import annotations

import asyncio
import os
import re
from typing import Any

import pytest

import nexus_ai.search.service as S
import nexus_ai.search.sql as SQL

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

#: (query, party size) - the pairs the probe measured, kept as the corpus's own numbers rather
#: than a synthetic shape. `下午茶` at 12 is the pair that can be asserted across a page cut:
#: this plane's largest stated cap is 10, so a party of 12 fits NO bounded row and the filtered
#: page must therefore be entirely unbounded.
VICTIMS = [("下午茶", 4), ("下午茶", 8), ("下午茶", 12), ("晚餐", 4), ("bookable", 8)]

#: the parties the whole-population comparison asks about
POPULATION_PARTIES = (4, 8)
#: the fixture's page size. A population that reaches it is cut, and a cut page is not a
#: population - see the docstring.
PAGE_LIMIT = 200

#: merchants whose offerings hold BOTH shapes in a page-sized population. Chosen by the corpus,
#: not by hand: a hard-coded uuid would quietly stop being a merchant that has anything to say.
POPULATION = """
SELECT o.merchant_id::text AS mid, m.slug, count(*)::int AS n,
       count(*) FILTER (WHERE o.max_party_size IS NOT NULL)::int AS bounded,
       count(*) FILTER (WHERE o.max_party_size IS NOT NULL
                          AND o.max_party_size < 4)::int AS breaks_4,
       count(*) FILTER (WHERE o.max_party_size IS NULL
                          AND o.min_party_size IS NULL)::int AS unbounded
FROM offerings o JOIN merchants m ON m.id = o.merchant_id
WHERE o.status = 'active' AND m.status = 'published' AND o.tenant_id = $1::uuid
GROUP BY 1, 2
HAVING count(*) BETWEEN 8 AND 60
   AND count(*) FILTER (WHERE o.max_party_size IS NOT NULL
                          AND o.max_party_size < 4) >= 2
   AND count(*) FILTER (WHERE o.max_party_size IS NULL
                          AND o.min_party_size IS NULL) >= 2
ORDER BY 1
LIMIT 3
"""


def _offering(slug: str, **over: Any) -> dict[str, Any]:
    row = {"id": slug, "subject_id": slug, "subject_type": "offering", "merchant_id": "m1",
           "slug": slug, "name": slug, "name_zh": "", "kind": "service",
           "price_amount": 100.0, "currency": "HKD", "bookable": True,
           "min_party_size": None, "max_party_size": None, "status": "active",
           "data_origin": "demo"}
    row.update(over)
    return row


#: the three shapes the corpus holds: a cap the party exceeds, a cap it fits, and no stated cap.
_FIXTURE = [
    _offering("small", min_party_size=1, max_party_size=2),
    _offering("large", min_party_size=1, max_party_size=10),
    _offering("unbounded"),
    _offering("group-only", min_party_size=6, max_party_size=12),
]


def _fits(row, party: int) -> bool:
    """The mirror of the shipped clause, written against the row the lane returned."""
    lo, hi = row.get("min_party_size"), row.get("max_party_size")
    return not ((hi is not None and party > int(hi)) or (lo is not None and party < int(lo)))


def _stated_bound(row) -> bool:
    """Does this offering state a bound at all - the population the whole door is about."""
    return row.get("min_party_size") is not None or row.get("max_party_size") is not None


@pytest.fixture(scope="module")
def plane():
    if not DB_URL:
        pytest.skip("NEXUS_TEST_DATABASE_URL is not set - live DB test skipped")
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                  internal_token="")

    async def _go():
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            common = dict(tenant_id=S.DEFAULT_TENANT_ID, text=None, filters={}, geo=None,
                          radius_m=None, limit=PAGE_LIMIT, with_total=False)
            victims = {}
            for query, party in VICTIMS:
                every = await backend.offering_candidates(**dict(common, text=query))
                asked = await backend.offering_candidates(**dict(common, text=query,
                                                                 party_size=party))
                victims[(query, party)] = (every, asked)
            pops = []
            for mid in await db.fetch(POPULATION, S.DEFAULT_TENANT_ID):
                scoped = dict(common, filters={"merchant_id": mid["mid"]}, text=None)
                every = await backend.offering_candidates(**scoped)
                asked = {party: await backend.offering_candidates(**dict(scoped, party_size=party))
                         for party in POPULATION_PARTIES}
                pops.append((mid["slug"], mid["n"], every, asked))
            return {"victims": victims, "pops": pops}
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


# ------------------------------------------------------------------- the live lane
@live_only
def test_the_offering_lane_answers_a_party_it_cannot_seat(plane):
    for (query, party), (_every, asked) in plane["victims"].items():
        bad = [f"{r['slug']}:{r.get('min_party_size')}-{r.get('max_party_size')}"
               for r in asked if not _fits(r, party)]
        assert not bad, (
            f"`{query}` for {party} people was answered with {len(bad)} offering(s) whose own "
            f"bounds say the party does not fit ({sorted(bad)}) - the lane reads "
            f"`min_party_size`/`max_party_size` into the row (sql.py:555) and applied neither, "
            f"while it already applies slot capacity (sql.py:637)")


@live_only
def test_the_party_clause_removes_exactly_the_offerings_that_cannot_fit(plane):
    """Under-filtering is the defect; over-filtering is the failure mode; one claim, whole sets.

    On a population the page does not cut, the filtered answer must equal the unfiltered answer
    minus the rows that cannot seat the party - so both halves of "exactly" are measurable
    (see the docstring for why a 200-row page cannot carry this claim).
    """
    assert plane["pops"], "no merchant on this plane holds both bounded and unbounded offerings"
    for slug, n, every, asked_by_party in plane["pops"]:
        assert len(every) < PAGE_LIMIT, (
            f"`{slug}` (which the corpus says holds {n} offerings) returned {len(every)} rows - "
            f"the page reached the limit, so this comparison is a cut page again and its set "
            f"equality would be measuring the planner's tie-breaking")
        expected_by_party = {party: {r["id"] for r in every if _fits(r, party)}
                             for party in asked_by_party}
        shown = {r["id"] for r in every}
        for party, asked in asked_by_party.items():
            expected = expected_by_party[party]
            cannot_seat = shown - expected
            assert cannot_seat, (
                f"`{slug}` has no offering the party of {party} breaks - the population moved "
                f"and this pair measures nothing")
            got = {r["id"] for r in asked}
            came_back = got & cannot_seat
            assert not came_back, (
                f"`{slug}` for {party}: {sorted(came_back)[:3]} of the offerings the party "
                f"cannot seat came back anyway - the clause is not filtering them out")
            dropped = expected - got
            assert not dropped, (
                f"`{slug}` for {party}: {sorted(dropped)[:3]} fit the party and vanished anyway "
                f"- a clause over `max_party_size >= :party` with no NULL arm does exactly this "
                f"to the 4,730 of 5,534 offerings that state no cap")


@live_only
def test_a_request_that_names_no_party_sees_the_bounded_offerings_too(plane):
    """The filter is the caller's, not a standing property of a bounded row.

    Each pair's before-image has to hold both shapes or the rows above compare an empty
    population to itself: a page with no bounded row cannot show a removal, and a page with no
    unbounded row cannot show the NULL arm doing its job.
    """
    for (query, _party), (every, _asked) in plane["victims"].items():
        bounded = [r["id"] for r in every if _stated_bound(r)]
        assert bounded, (
            f"the party-less page for `{query}` carries no offering that states a bound "
            f"({len(every)} rows) - the pair no longer has a before-image; re-measure which "
            f"offerings on this plane state min/max party size")
        assert any(not _stated_bound(r) for r in every), (
            f"the party-less page for `{query}` is entirely bounded rows - the unbounded "
            f"majority (4,730 of 5,534) never reaches the answer, so the NULL arm has no "
            f"population to be tested against")


@live_only
def test_a_party_larger_than_every_stated_cap_leaves_only_unbounded_offerings(plane):
    """The sharpest form of the removal, and the one a page cut cannot blur.

    This plane's largest `max_party_size` is 10, so a party of 12 fits NO bounded offering: the
    filtered page must be all-NULL bounds while its own unfiltered page carries bounded rows.
    """
    every, asked = plane["victims"][("下午茶", 12)]
    assert any(_stated_bound(r) for r in every), (
        "the party-less page for the 12-person request holds no bounded offering - nothing to "
        "remove, so this row proves nothing")
    left = [f"{r['slug']}:{r.get('min_party_size')}-{r.get('max_party_size')}"
            for r in asked if _stated_bound(r)]
    assert not left, (
        f"a party of 12 - larger than every cap this plane states - was still answered with "
        f"{len(left)} bounded offering(s) ({sorted(left)[:5]})")


# ------------------------------------------------------------------- the lane's own SQL
def test_the_party_size_reaches_the_offering_query_as_a_parameter():
    sql = SQL.build_offering_query(tenant_id=S.DEFAULT_TENANT_ID, text=None, party_size=8)
    assert "min_party_size" in sql.sql and "max_party_size" in sql.sql, (
        "the offering query still cannot be asked about a party at all")
    where = sql.sql.split("WHERE", 1)[1] if "WHERE" in sql.sql else sql.sql
    assert "min_party_size" in where and "max_party_size" in where, (
        "the bounds are still only SELECTed, never applied - the row carries them and the "
        "answer ignores them")
    assert "IS NULL" in where, (
        "the bound clause has no NULL arm, so every offering that never stated a cap is "
        "filtered out with the ones that cannot fit")
    comparisons = re.findall(r"o\.(?:min|max)_party_size\s*(?:>=|<=)\s*(\S+)", sql.sql)
    assert len(comparisons) == 2, (
        f"the bounds are compared to {comparisons} - the clause should ask both a cap and a "
        f"minimum about the party, and an arm missing is a silent under-filter")
    assert all(c.startswith("$") for c in comparisons), (
        f"the party arrived interpolated into the SQL text, not bound as a parameter: "
        f"{comparisons}")
    assert 8 in sql.params, (
        f"the caller's party never reached the parameter list ({sql.params}) - the bounds are "
        f"being compared to something other than the number that was asked for")


def test_the_merchant_lane_is_not_asked_to_aggregate_the_bounds():
    """`merchants` has no party columns; a merchant-level rule would be a new product promise."""
    sql = SQL.build_merchant_query(tenant_id=S.DEFAULT_TENANT_ID, text=None, embedding=None)
    assert "min_party_size" not in sql.sql and "max_party_size" not in sql.sql, (
        "the merchant lane now applies offering bounds directly - that is the aggregation rule "
        "PLAN says is undocumented, so re-read it there before trusting this row")


# ------------------------------------------------------------------- both lanes, one question
def test_the_fixture_lane_answers_the_same_question_as_the_live_lane():
    """D449: two lanes of one product must not answer one request with two different sets."""
    kept = {r["slug"] for r in S._filter_static(list(_FIXTURE), "", {}, party_size=8)}
    assert kept == {"large", "unbounded", "group-only"}, (
        f"a party of 8 through the fixture lane kept {sorted(kept)} of "
        f"{[r['slug'] for r in _FIXTURE]} - `small` caps at 2 and `group-only` starts at 6, and "
        f"a fixture-backed test of this rule cannot see what the live clause does")


def test_the_smaller_party_is_excluded_by_a_minimum_too():
    """The live corpus has no `min_party_size > 1` row (measured: 0 of 5,534), so this half of
    the column is only reachable through the fixture lane."""
    kept = {r["slug"] for r in S._filter_static(list(_FIXTURE), "", {}, party_size=2)}
    assert kept == {"small", "large", "unbounded"}, (
        f"a party of 2 kept {sorted(kept)} - `group-only` states a minimum of 6")


def test_a_request_that_names_no_party_keeps_the_fixture_catalogue_whole():
    kept = {r["slug"] for r in S._filter_static(list(_FIXTURE), "", {})}
    assert kept == {r["slug"] for r in _FIXTURE}, (
        "an unbounded request lost fixture rows - the party filter is the caller's, not a "
        "standing property of a bounded row")


# ------------------------------------------------------------------- the pipeline's own dispatch
class _Recorder(S.StaticBackend):
    """What `search()` actually hands the offering lane, recorded rather than remembered.

    Every row above calls the lane directly, so a pipeline that dropped the party between the
    plan and the dispatch would keep all of them green; arm D measured exactly that, and this
    is the row that catches it.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.parties: list[Any] = []

    async def offering_candidates(self, **kwargs: Any):
        self.parties.append(kwargs.get("party_size", "<absent>"))
        return await super().offering_candidates(**kwargs)


async def _through_pipeline(party: int | None):
    backend = _Recorder(offerings=[dict(r) for r in _FIXTURE])
    # the fixture rows carry no text the query could match, and `_filter_static` drops a row
    # that matches nothing (measured: "afternoon tea" keeps 0 of 4). The party is what is under
    # test here, so the request names none.
    plan = S.SearchPlan(query_text="", subject_types=("offering",), party_size=party, limit=10)
    _cards, _resp, _bundle, scored = await S.search(backend=backend, plan=plan)
    return backend.parties, {str(s.candidate.subject_id) for s in scored}


async def test_the_pipeline_hands_the_plan_party_to_the_offering_lane():
    parties, answered = await _through_pipeline(8)
    assert parties == [8], (
        f"with a plan carrying party_size=8 the pipeline called the offering lane as {parties} "
        f"- the plan knows the party (service.py:442), the lane accepts it, and the dispatch in "
        f"between is where it was dropped")
    assert "small" not in answered, (
        f"the pipeline answered an 8-person request with {sorted(answered)}, including the "
        f"1-2 offering - the party never reached the clause that filters it")
    assert "unbounded" in answered, (
        f"the pipeline answered with {sorted(answered)} - the offering that states no bound was "
        f"filtered out, which is the over-filtering failure mode, not the defect")


async def test_a_request_that_names_no_party_still_reaches_the_smallest_offering():
    parties, answered = await _through_pipeline(None)
    assert parties == [None], (
        f"a plan with no party dispatched {parties} to the offering lane - the absence has to "
        f"reach the clause as an absence, not as a zero or a one")
    assert "small" in answered, (
        f"an unbounded request lost the 1-2 offering ({sorted(answered)}) - the party filter is "
        f"the caller's, not a standing property of a bounded row")


# ------------------------------------------------------------------- the corpus the claims sit on
@live_only
def test_the_plane_measures_the_bounds_this_door_claims():
    from nexus_ai.config import Settings
    from nexus_ai.db import pool as db_pool

    async def _go():
        st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                      internal_token="")
        db = await db_pool.connect(st, force_new=True)
        try:
            return await db.readonly(
                "select count(*)::int total, "
                "count(*) filter (where max_party_size is not null)::int bounded, "
                "count(*) filter (where max_party_size is null and min_party_size is null)"
                "::int unbounded, "
                "count(*) filter (where min_party_size > 1)::int min_gt_1, "
                "count(distinct max_party_size)::int distinct_max, "
                "count(*) filter (where bookable and max_party_size is not null)::int "
                "bookable_bounded "
                "from offerings")
        finally:
            await db_pool.dispose()

    row = asyncio.run(_go())[0]
    assert row["bounded"] > 0 and row["unbounded"] > 0, (
        f"the corpus no longer holds both shapes ({row}) - the NULL arm and the cap arm need "
        f"their own populations or this door is measuring one row")
    assert row["min_gt_1"] == 0, (
        f"the corpus now carries {row['min_gt_1']} offerings with a stated MINIMUM above 1 - "
        f"the min half has live victims, so the fixture-only row above is no longer enough")
    assert row["bookable_bounded"] == row["bounded"], (
        f"{row['bounded']} offerings carry a cap but only {row['bookable_bounded']} are "
        "bookable - an unbookable offering's bounds are a different promise from this one")
    assert row["distinct_max"] <= 5, (
        f"the corpus now states {row['distinct_max']} distinct caps - the party of 12 above is "
        "no longer known to exceed every cap, so that row needs re-measuring")
