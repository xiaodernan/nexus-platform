"""D617 - the rows a page cut drops are not the rows the same order says should come next.

Both candidate SELECTs ended `ORDER BY <relevance> DESC, <rating> DESC LIMIT <n>` - `sql.py:409` and
`sql.py:600` are those two cuts, now carrying this unit's id tail - so the order was not total:
whenever the LIMIT lands inside a group that ties on both keys, WHICH members of that group reach the
answer is the plan's choice, and the plan is free to change with the LIMIT, with the statistics, or
with the next write. The presentation layer does not have this problem - the service re-sorts the rows
it fetched by `(-organic_score, candidate.key())` (`ranking.py:273`), a sort that ends with
`subject_type:subject_id` and is therefore total. Only the cut that decides which rows EXIST had no
last key.

Measured on the seeded plane before the patch (`tmp/d617_census.txt` for the cut, `tmp/d617_pool_ties.txt`
for what a customer sees):

  merchant  browse restaurant   pool 184, the LIMIT-20 boundary key (kw 0.0, rating 4.41) is carried
            by 5 rows - 1 is served, 4 are cut
  offering  browse restaurant   pool 2384, the boundary key (0.0, 5.0) is carried by 89 rows - the
            whole 60-row candidate page is drawn from those 89 and 29 of them are cut

Because which tie survives is not a function of the keys, the pages do not line up: for the offering
browse, the first 20 rows of the 60-row fetch are not the 20-row page (17 of the 20 differ once an id
tail is added), and the documented "show me others" follow-up - `filters.exclude`, written from
`shown_ids` at `state_merger.py:179` by the ALT cues 其他 / next / more options (`state_merger.py:49`) -
serves a second page that shares only 11 of its 20 rows with rows 21-40 of the deeper fetch. The 9
that differ are not mis-sorted - both pages hold rows carrying the same two keys, and the keys are
what the sort can see; which members of that group each cut reaches is not a function of them.

Adding the row's own id completes the total order with the key the ranking already uses: `subject_id`
is the projected `m.id::text` / `o.id::text`, `Candidate.key()` is `subject_type:subject_id`, and
Postgres orders `uuid` by canonical hex, which is how the Python side compares the same ids (measured:
ids ascend inside every tie group - `tmp/d617_pool_ties.txt`). What it does NOT decide is who belongs
in the answer: the 29 offerings the 60-row cut drops stay dropped, now permanently.

Two cuts of the same shape are filed by this unit and not fixed, because each needs a decision about
the query and not about the order: the candidate cut is blind to the distance the geo lane computes
(`tmp/d617_census.txt` section B - a 2500 m request pools 119 restaurants and only 33 of the nearest 60
reach the page, and an id tail changes that number by 0), and the chunk rerank budget (`sql.py:865`)
holds 40 rows that all score 0 on every leg the SELECT projects for a Chinese sentence on the
keyword-only path (`routes_rag.py:45-49`). Both are pinned below as not-this-unit's-claim, so the day
either is decided the pin goes red and asks for a new door.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from nexus_ai.search import service as S
from nexus_ai.search import sql as SQ

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()

live = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

TENANT = str(S.DEFAULT_TENANT_ID)
PAGE = 20            # the page a caller asks to see
CANDIDATES = 60      # service.py:996 - max(60, plan.limit * 3), the rows the SQL actually cuts
RESTAURANT = {"category": "restaurant"}


def cut_line(sql_text: str) -> str:
    """The SELECT's own ORDER BY: the one line that mentions the rating column.

    A geo request builds two more ORDER BYs - the nearest-chunk LATERAL and the transit LATERAL both
    end `ORDER BY meters ASC NULLS LAST LIMIT 1` - so "the ORDER BY line" is not "the line that starts
    with ORDER BY". Only the page cut sorts on rating.
    """
    lines = [ln.strip() for ln in sql_text.splitlines() if ln.strip().startswith("ORDER BY")]
    cuts = [ln for ln in lines if "rating_agg" in ln]
    assert len(cuts) == 1, f"expected one page cut among {lines}"
    return cuts[0]


def order_terms(sql_text: str) -> list[str]:
    """The cut's sort terms, split at depth 0 so the relevance expression stays one term."""
    body = cut_line(sql_text)[len("ORDER BY "):]
    out, depth, cur = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    out.append(cur.strip())
    return out


def merchant_sql(**kw) -> str:
    kw.setdefault("filters", RESTAURANT)
    return SQ.build_merchant_query(tenant_id=TENANT, text=None, embedding=None,
                                   limit=CANDIDATES, **kw).sql


def offering_sql(**kw) -> str:
    kw.setdefault("filters", RESTAURANT)
    return SQ.build_offering_query(tenant_id=TENANT, text=None, limit=CANDIDATES, **kw).sql


def sort_key(row: dict) -> tuple:
    """The two keys the shipped cut actually sorts on - the tie-break is not one of them.

    No rounding: the projected `kw_score` is the same expression the ORDER BY sorts on, so two rows
    the database separated at all must not be called tied here and then asked for id order.
    """
    return (float(row.get("kw_score") or 0.0), float(row.get("rating_agg") or 0.0))


class TestTheCutIsATotalOrder:
    """Structural: what the two ORDER BYs must state, with no database in sight."""

    def test_the_page_cut_still_leads_with_the_relevance_expression(self):
        # The tie-break is LAST. Asserting the head first is what keeps this unit from quietly
        # becoming a re-ranking unit.
        for sql_text in (merchant_sql(), offering_sql()):
            first = order_terms(sql_text)[0]
            assert "ts_rank" in first, f"the cut no longer opens with the relevance term: {first}"

    def test_the_page_cut_ends_with_the_rows_own_id(self):
        assert order_terms(merchant_sql())[-1] == "m.id"
        assert order_terms(offering_sql())[-1] == "o.id"

    def test_the_tie_break_is_the_id_the_row_carries_as_its_subject_key(self):
        # `ranking.py:273` ends its own sort with `candidate.key()` = `subject_type:subject_id`, and
        # `subject_id` is projected from exactly this column. A slug or a popularity score would also
        # be deterministic, and would decide the page by a key the answer does not sort by.
        for sql_text, id_term in ((merchant_sql(), "m.id"), (offering_sql(), "o.id")):
            assert order_terms(sql_text)[-1] == id_term
            assert f"{id_term}::text AS subject_id" in sql_text, (
                "the tie-break names a column the SELECT does not project as `subject_id`")

    def test_the_distance_the_geo_lane_computes_is_still_not_a_sort_key(self):
        # Filed, not fixed: the candidate cut ranks a "near me" request by text and rating, so 33 of
        # the 60 nearest restaurants reach the page at a 2500 m radius (`tmp/d617_census.txt` B), and
        # an id tail changes that count by nothing. Widening this unit into a distance ranking is a
        # different decision about the query.
        terms = order_terms(merchant_sql(geo=(22.3167, 114.1933), radius_m=2500))
        assert not any("meters" in t for t in terms), (
            "this unit's patch was widened into a distance ranking - the geo ORDER BY is its own "
            "filed question")

    def test_the_chunk_rerank_budget_is_left_as_it_was_found(self):
        # Filed, not fixed: `sql.py:865` cuts the rerank budget with `ORDER BY {score} DESC` and, on
        # the keyword-only path (`routes_rag.py:45-49`, taken whenever the embedder raises), all 40
        # rows it holds score 0 on every leg for a Chinese sentence (`tmp/d617_census.txt` C). That is
        # a question about the budget, not about the order.
        chunk = SQ.build_chunk_query(tenant_id=TENANT, merchant_id=None, text="coffee",
                                     embedding=None, top_k=40)
        lines = [ln.strip() for ln in chunk.sql.splitlines()
                 if ln.strip().startswith("ORDER BY")]
        assert len(lines) == 1, f"the chunk builder grew a second cut: {lines}"
        assert "c.id" not in lines[0], (
            "the chunk budget was tie-broken by this unit too - its own defect (40 zero-score rows) "
            "is filed separately and needs a decision about the budget, not about the order")


def _fetch(lane: str, filters: dict, limit: int, exclude: list[str] | None = None) -> list[dict]:
    """One connection, one page, gathered inside a single event loop."""

    async def _go():
        from nexus_ai.config import Settings
        from nexus_ai.db import pool as db_pool

        st = Settings(llm_provider="mock", embedding_provider="hashing", database_url=DB_URL,
                      internal_token="", db_statement_timeout_ms=60000)
        db = await db_pool.connect(st, force_new=True)
        try:
            backend = S.PostgresBackend(db)
            f = dict(filters)
            if exclude:
                f["exclude"] = exclude
            if lane == "merchant":
                return await backend.merchant_candidates(
                    text=None, filters=f, tenant_id=TENANT, limit=limit, with_total=True,
                    embedding=None)
            return await backend.offering_candidates(
                text=None, filters=f, tenant_id=TENANT, limit=limit, with_total=True)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


@live
class TestThePagesLineUp:
    """Live: the property a customer feels - a next page that is the next rows."""

    def test_an_offering_page_is_the_prefix_of_the_page_the_service_fetched(self):
        for lane in ("merchant", "offering"):
            page = [str(r["id"]) for r in _fetch(lane=lane, filters=RESTAURANT, limit=PAGE)]
            deep = [str(r["id"]) for r in _fetch(lane=lane, filters=RESTAURANT, limit=CANDIDATES)]
            assert deep[:PAGE] == page, f"{lane}: the 20 rows shown are not the first 20 fetched"

    def test_the_excluded_next_page_is_the_next_twenty_rows(self):
        for lane in ("merchant", "offering"):
            first = [str(r["id"]) for r in _fetch(lane=lane, filters=RESTAURANT, limit=PAGE)]
            deep = [str(r["id"]) for r in _fetch(lane=lane, filters=RESTAURANT, limit=CANDIDATES)]
            second = [str(r["id"]) for r in _fetch(lane=lane, filters=RESTAURANT, limit=PAGE,
                                                   exclude=first)]
            assert second == deep[PAGE:2 * PAGE], (
                f"{lane}: the next page shares only {len(set(second) & set(deep[PAGE:2 * PAGE]))} of "
                f"its 20 rows with rows 21-40 of the fetch that produced it")
            assert not set(second) & set(first), f"{lane}: the next page re-shows rows 1-20"

    def test_tied_rows_reach_the_page_in_subject_id_order(self):
        for lane in ("merchant", "offering"):
            rows = _fetch(lane=lane, filters=RESTAURANT, limit=CANDIDATES)
            for a, b in zip(rows, rows[1:]):
                if sort_key(a) == sort_key(b):
                    assert str(a["id"]) < str(b["id"]), (
                        f"{lane}: two rows tied on both sort keys came back as "
                        f"{a['id']} then {b['id']}")

    def test_the_highest_scoring_row_still_opens_the_page(self):
        # The other half of "the tie-break is last", measured on rows instead of on the query text.
        for lane in ("merchant", "offering"):
            rows = _fetch(lane=lane, filters=RESTAURANT, limit=CANDIDATES)
            best = max(sort_key(r) for r in rows)
            assert sort_key(rows[0]) == best, (
                f"{lane}: the page opens with {sort_key(rows[0])} while {best} is in the pool")

    def test_deciding_the_order_does_not_decide_who_is_in_the_answer(self):
        # The honest non-claim, pinned: 89 offerings carry the sort key the 60-row cut lands on, the
        # page holds 60 of them and 29 stay outside (`tmp/d617_census.txt`). Completing the total order
        # fixes WHICH rows and not HOW MANY. The pool behind the cap is `pool_total` (D599's window).
        rows = _fetch(lane="offering", filters=RESTAURANT, limit=CANDIDATES)
        keys: dict[tuple, int] = {}
        for r in rows:
            keys[sort_key(r)] = keys.get(sort_key(r), 0) + 1
        assert len(rows) == CANDIDATES, f"the cut returned {len(rows)} rows"
        assert keys[sort_key(rows[-1])] > 1, (
            "the boundary key is no longer a tie - this row pinned that the cut still lands inside "
            "a tie group, and the plane changed")
        assert int(rows[0]["pool_total"]) > CANDIDATES, (
            "the pool behind the cap is now smaller than the page - the non-claim needs re-wording")
