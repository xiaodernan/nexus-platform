"""D670 - every cell of the comparison grid states a value about the subject it sits under.

`packages/types/src/search.ts` publishes `CompareRow.cards` as "One cell per compared subject, in
request order", and `packages/ui/src/trust/CompareTable.tsx` renders it exactly that way: the
headers come from the caller's card list and the body is `row.cards.map((cell, cellIndex) => ...)`,
keyed `${row.attribute}-${cellIndex}`. The row itself names no subject - `CompareCell.subject_id?`
exists in the published type and the AI never emits it - so the position IS the pairing, and a cell
that moved is a number about one subject printed under another subject's name.

`api/routes_discover._grid` built its cells by iterating the DATABASE rows
(`order = [str(r.get("subject_id")) for r in entity_rows]`, then `for sid in order`) while the
response's `subjects` echoed `body.subject_ids`. Neither half of that pairing is a promise:

  * `search/sql.entities_for` is a merchant-then-offering `UNION ALL` with no `ORDER BY`, so the
    sequence is a property of the id SET and not of the request. `tmp/d670_rows.txt` asked one list
    of four subjects in three different orders and got the same returned sequence each time
    (permutations of the named list `[0, 1, 3, 2]`, `[3, 2, 0, 1]`, `[0, 3, 2, 1]`), reproducible
    over three runs of the same statement;
  * the same read filters on status (`m.status='published'`, `o.status='active' AND
    m.status='published'`), so a named subject can have no row at all. `tmp/d670_missing.txt`
    counted 50 of 520 merchants unpublished, 368 offerings not active, 463 offerings whose merchant
    is not reachable, and a three-subject ask of `[reachable offering, draft merchant, a uuid
    nobody holds]` answered with ONE cell per attribute row under THREE echoed subjects.

Measured on the shipped bytes, in-process (`tmp/d670_measure.py`, record `tmp/d670_before.txt`):

  * **14 of 14 batches** returned rows in a sequence that is not the sequence the request named, and
    **47 of the 65 non-blank rating cells** printed a number belonging to a different subject of the
    same batch. 3 more were ambiguous - two subjects sharing a value, so the mislabelling could not
    be attributed - and the other 15 happen to agree with their own header.
  * the probe shows it without any inference: one list of four ids asked in three orders returned
    the identical rating row `[4.23, 4.25, 4.57, 4.55]`, and identical price, category, open_state
    and distance rows, while `subjects` echoed each order correctly.
  * **8 of the 65 cells** state a score for a subject whose own row says nobody reviewed it, and all
    8 name no `fact_id`. That is the second road in the rating branch: `row["rating_agg"]` is read
    when the subject has no `rating` fact, and `V1__init.sql` declares, on `merchants` and on
    `offerings`, both `rating_agg numeric(3,2) NOT NULL DEFAULT 0` and
    `review_count integer NOT NULL DEFAULT 0`. So an unrated subject arrives as the number zero -
    the worst score the 0-5 scale has, about a thing nobody scored, in a cell §4 says must resolve
    to a fact. D669 found the same phantom on the card surface; this is its second reader.
  * `tmp/d670_uncited.txt` classifies those 65 cells as 57 cited-and-rated and 8 uncited-and-unrated
    and finds nothing in either remaining class: 0 of 999 rated reachable offerings and 0 of 470
    rated merchants lack a `rating` fact of their own, and 0 of the 1,727 stored rating facts sit on
    a row with `review_count = 0`. The unrated subject is the ONLY thing that reaches the
    fall-through, and the only number it can print is the column default - which is why the fix keys
    that road on the count and needs no new fact. Corpus-wide the pair is unambiguous: 3,708 of the
    4,707 reachable offerings have no reviews and all 3,708 have `rating_agg = 0`; 0 rows anywhere
    have a score with no reviews or reviews with a zero score.
  * that classifier attributes a cell to the row the grid iterated, so it names its rule in its own
    first line: `db` (the parent's - cell `i` is `db_order[i]`) for `tmp/d670_uncited.txt`, and
    `request` (the shipped rule - cell `i` is the header `ids[i]`) for `tmp/d670_uncited_after.txt`,
    which reports the after-census's 57 value-bearing cells as 57 cited-and-rated, 0 in every other
    class, and 3 blanks. Read through the parent's rule the same dump would call two of those cells
    "a fact the columns deny" - the classifier is the instrument, and the instrument has to use the
    plane it is measuring.

What the fix is not: it is not an `ORDER BY` added to the read. The grid answers for the subjects it
was named, so the read's sequence is no longer load-bearing, and `entities_for` has exactly one
caller (`routes_discover.S_entities`). Nor does a subject the read cannot answer for become an
error: `search.ts` makes `value` nullable precisely for this - "null when the subject has no value
for this attribute - spec §37 shows blank cells, never a fabricated one" - and `test_understand_recommend_compare.py`
already demands that an empty cell carries no phantom fact.

Consequence, stated rather than discovered later: `routes_discover._compare_rows` drops a row whose
cells are all blank (D401), so a comparison of subjects nobody has rated now shows no rating row at
all instead of a row of zeros. `test_a_grid_of_only_unrated_subjects_shows_no_rating_row` pins that
so the next change to it is a decision.
"""

from __future__ import annotations

import ast
import asyncio
import functools
import inspect
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

import nexus_ai.api.routes_discover as RD
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import CompareRow
from nexus_ai.search import sql as SQL
from nexus_ai.search.service import DEFAULT_TENANT_ID
from nexus_ai.trust.facts import FactBundle, facts_from_rows

REPO = Path(__file__).resolve().parents[3]

DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

NOW = datetime.now(timezone.utc).replace(microsecond=0)

#: `contract.CompareRequest.subject_ids` is `Field(min_length=2, max_length=5)` - a longer ask is
#: a 422, not a grid, so a census that wants to send what the search served has to say what it cut.
MAX_IDS = 5

SEARCH_TS = (REPO / "packages" / "types" / "src" / "search.ts").read_text(encoding="utf-8")
TABLE_TSX = (REPO / "packages" / "ui" / "src" / "trust" / "CompareTable.tsx").read_text(
    encoding="utf-8")
DDL = (REPO / "infra" / "db" / "migrations" / "V1__init.sql").read_text(encoding="utf-8")

#: the asks whose batches carry the cells this door is about: `kind=product` and the comparison
#: query served every one of the 8 unrated cells `tmp/d670_uncited.txt` lists, the other two are
#: the rated controls.
ASKS: list[tuple[str, dict[str, Any]]] = [
    ("browse restaurant", {"query": "browse restaurant", "limit": 6}),
    ("ramen", {"query": "ramen", "limit": 6}),
    ("kind=product", {"query": "gift set", "filters": {"kind": "product"}, "limit": 6}),
    ("compare two", {"query": "\u6bd4\u8f03\u4e2d\u74b0\u540c\u65fa\u89d2", "limit": 6}),
]


def _num(value: Any) -> float:
    return round(float(value), 2)


def _as_num(value: Any) -> float | None:
    """A jsonb number can arrive as text: the stored price facts on this plane read
    `{"amount": "174.00"}`, and the grid prints that string verbatim in its cell. Both spellings
    of the same number have to match the cell that states it, or the census reports a leak that is
    only its own reader."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return None


def _settings(database_url: str = "") -> Settings:
    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=database_url, internal_token="0" * 8)


def _run(query: str, *params) -> list[dict]:
    from nexus_ai.db import pool as db_pool

    settings = _settings(DB_URL)

    async def _go():
        db = await db_pool.connect(settings, force_new=True)
        try:
            return await db.readonly(query, *params)
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


# --------------------------------------------------------------------------- the yardstick
def test_the_published_type_pairs_a_cell_with_its_position():
    """Nothing but the index says whose number a cell is, so the index has to be right."""
    assert "One cell per compared subject, in request order" in SEARCH_TS, (
        "the published meaning of `cards` changed - this door reads the pairing off the order")
    assert "null when the subject has no value for this attribute" in SEARCH_TS
    assert "subject_id?: Uuid | null;" in SEARCH_TS, (
        "a cell now names its own subject - the positional rule is no longer the only pairing, "
        "so aim the rows below at that key instead of at the index")


def test_the_renderer_places_each_cell_under_the_header_at_its_index():
    rendered = TABLE_TSX[TABLE_TSX.index("result.rows.map"):]
    assert "row.cards.map((cell, cellIndex)" in rendered, (
        "the compare table stopped rendering cells positionally - a misordered row would no longer "
        "reach a user, which changes what this fix is worth")
    assert "row.attribute}-${cellIndex" in rendered, (
        "the cell key stopped being the position, so React would hide a moved cell behind a stable "
        "subject key rather than repaint the wrong number")


def test_the_response_model_cannot_be_the_gate():
    """`CompareRow.cards` is a list of free dicts, so the pairing is enforced only in `_grid`."""
    annotation = str(CompareRow.model_fields["cards"].annotation)
    assert "dict" in annotation, (
        f"CompareRow.cards is now {annotation} - if it became a typed cell the rows above need "
        "re-aiming at that model")


def test_an_unrated_row_carries_a_number_and_no_way_to_tell_it_from_a_score():
    """Why the rating road has to read the COUNT: both columns default to the number zero."""
    for table in ("merchants", "offerings"):
        block = DDL.split(f"CREATE TABLE {table} (")[1].split(");")[0]
        assert "rating_agg        numeric(3,2) NOT NULL DEFAULT 0" in block
        assert "review_count      integer NOT NULL DEFAULT 0" in block, (
            f"{table}.review_count is nullable now - a NULL count is a different question from a "
            "zero count and the gate below answers only the zero")


# --------------------------------------------------------------------------- the grid, offline
def _row(sid: str, *, rating_agg: float, review_count: int, **over) -> dict:
    """A row in the shape `entities_for` returns it - merchant branch, all its columns.

    `test_the_rating_road_reads_the_count_not_the_number` deliberately hands it a pair the corpus
    never produces (a score with no reviews); every other row here uses shapes the columns can
    actually hold.
    """
    row = {"subject_id": sid, "subject_type": "merchant", "merchant_id": sid,
           "slug": "sham-shui-terraces", "name": "Sham Shui Terraces", "name_zh": None,
           "category": "Cantonese", "avg_price_hkd": 240.0, "currency": "HKD",
           "price_model": None, "rating_agg": rating_agg, "review_count": review_count,
           "description": None, "data_origin": "seeded", "plan": "pro", "attributes": {},
           "images": [], "ai_agent_enabled": True, "status": "published",
           "price_updated_at": None, "price_source": None}
    row.update(over)
    return row


def _grid_of(rows: list[dict], named: list[str], *, bundle: FactBundle | None = None,
             **over) -> list[dict]:
    return RD._grid(rows, bundle if bundle is not None else FactBundle(), {},
                    subject_ids=[str(s) for s in named], now=NOW, locale="zh-HK", **over)


def _column(grid: list[dict], attribute: str) -> list[dict]:
    row = next((r for r in grid if r["attribute"] == attribute), None)
    assert row is not None, f"the grid answers no {attribute} row: {[r['attribute'] for r in grid]}"
    return row["cards"]


A, B, C = str(uuid4()), str(uuid4()), str(uuid4())


def test_the_grid_answers_in_the_order_the_request_named():
    """The whole of D670's first charge, on a table that cannot be right by coincidence.

    The rows arrive A, B, C; the caller names them shuffled. `entities_for` really does answer in
    its own sequence (`tmp/d670_rows.txt`), so this is the shipped case, not a hypothetical one.
    """
    rows = [_row(A, rating_agg=4.1, review_count=11, category="Cantonese", avg_price_hkd=210.0),
            _row(B, rating_agg=4.6, review_count=3, category="Korean", avg_price_hkd=143.33),
            _row(C, rating_agg=4.9, review_count=7, category="Steakhouse", avg_price_hkd=354.55)]
    own = {r["subject_id"]: r for r in rows}
    for named in ([C, A, B], [B, C, A], [A, C, B]):
        grid = _grid_of(rows, named)
        assert [c["value"] for c in _column(grid, "rating")] == \
            [own[s]["rating_agg"] for s in named]
        assert [c["value"] for c in _column(grid, "category")] == \
            [own[s]["category"] for s in named]
        assert [c["value"] for c in _column(grid, "price")] == \
            [f"{own[s]['avg_price_hkd']:.2f}" for s in named]


def test_a_subject_the_read_has_no_row_for_still_holds_its_column():
    """Charge (b): a missing column shifted every later number; a blank cell cannot."""
    here, gone, also_gone = A, str(uuid4()), str(uuid4())
    rows = [_row(here, rating_agg=4.4, review_count=9)]
    named = [gone, here, also_gone]
    grid = _grid_of(rows, named)
    for attribute in ("rating", "price", "category"):
        cells = _column(grid, attribute)
        assert len(cells) == len(named), (
            f"the {attribute} row has {len(cells)} cell(s) for {len(named)} named subjects - "
            "the renderer would put the next subject's number under this name")
        assert cells[1]["value"] is not None, (
            f"the {attribute} row lost the one subject it can answer for")
        for index in (0, 2):
            assert cells[index]["value"] is None, (
                f"the {attribute} cell under an unanswered subject states {cells[index]['value']}")
            assert cells[index]["fact_id"] is None, (
                "an empty cell carries no phantom fact (test_understand_recommend_compare.py)")


def test_the_rating_road_reads_the_count_and_not_the_number():
    """Charge (c), pinned by a pair the columns never produce together.

    `rating_agg = 4.9` with `review_count = 0` is impossible on this corpus (`tmp/d670_rows.txt`:
    0 of 3,708 unrated offerings and 0 of 470 merchants hold a score with no reviews). A gate that
    keyed on the number instead of the count - `if row["rating_agg"]` - would clear the real rows
    and fail here, which is the point of the impossible fixture.
    """
    rated, unrated = str(uuid4()), str(uuid4())
    rows = [_row(rated, rating_agg=4.4, review_count=12),
            _row(unrated, rating_agg=4.9, review_count=0)]
    cells = _column(_grid_of(rows, [rated, unrated]), "rating")
    assert cells[0]["value"] == 4.4, "a rated subject lost its own number"
    assert cells[1]["value"] is None, (
        f"the grid prints {cells[1]['value']} for a subject its own row says nobody reviewed")
    assert cells[1]["fact_id"] is None, (
        "the unrated cell still cites a fact - §4 wants the rendered number resolved to a fact, "
        "and here there is no number to resolve")


def test_the_real_unrated_shape_is_blank_too():
    """The column default verbatim: `rating_agg = 0`, `review_count = 0`.

    Separated from the row above because the two are different guards - one refuses a score with no
    reviews, this one refuses the zero that the default writes.
    """
    unrated, rated = str(uuid4()), str(uuid4())
    cells = _column(_grid_of([_row(unrated, rating_agg=0.0, review_count=0),
                              _row(rated, rating_agg=4.2, review_count=5)],
                             [unrated, rated]), "rating")
    assert cells[0]["value"] is None, (
        f"the cell states {cells[0]['value']} - the column default, which `common.ts` publishes "
        "as 'not yet rated'")
    assert cells[1]["value"] == 4.2, "the fix took a number off a subject that has reviews"


def test_the_stored_rating_fact_is_still_the_primary_road():
    """A subject that holds its own `rating` fact prints it, cited - the 57 of 65 that were right.

    This row exists so the fix cannot be made by deleting the fact lookup: the fall-through was the
    leak, and the fall-through is what changed.
    """
    sid = str(uuid4())
    bundle = FactBundle()
    fact = bundle.synth(subject_type="merchant", subject_id=sid, attribute="rating",
                        value={"value": 4.3, "count": 21}, source="merchant", confidence=0.9,
                        observed_at=NOW)
    cells = _column(_grid_of([_row(sid, rating_agg=4.3, review_count=21)], [sid],
                             bundle=bundle), "rating")
    assert cells[0]["value"] == 4.3
    assert str(cells[0]["fact_id"]) == str(fact.fact_id)


def test_a_grid_of_only_unrated_subjects_shows_no_rating_row():
    """The stated consequence: `_compare_rows` drops an all-blank row, so the zeros leave the table.

    Before the fix this row existed and said 0.0 about everyone. Silence is the honest answer, and
    it is a behaviour change - so it is written down where a reader can argue with it.
    """
    ids = [str(uuid4()), str(uuid4())]
    grid = _grid_of([_row(sid, rating_agg=0.0, review_count=0) for sid in ids], ids)
    assert "rating" not in [r["attribute"] for r in grid], (
        f"the grid still answers a rating row of {grid[0]['cards']} for subjects nobody rated")


def test_the_blank_cell_keeps_the_shape_the_compare_gate_demands():
    keys = {"value", "fact_id", "source", "observed_at", "confidence"}
    sid, gone = str(uuid4()), str(uuid4())
    grid = _grid_of([_row(sid, rating_agg=4.4, review_count=9)], [sid, gone])
    for row in grid:
        for cell in row["cards"]:
            assert set(cell) == keys, (
                f"a {row['attribute']} cell changed its keys: {sorted(set(cell))} - "
                "test_understand_recommend_compare.py asserts this set, and the web renders from it")


def test_the_grid_takes_the_subjects_it_answers_for_as_a_required_keyword():
    """A caller that forgets the list has to fail loudly, not fall back to row order."""
    parameter = inspect.signature(RD._grid).parameters["subject_ids"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty, (
        "`subject_ids` grew a default - a caller that stops naming its subjects would silently "
        "go back to answering in the order the database returned")


def test_the_kernels_only_caller_names_the_subjects_it_was_given():
    tree = ast.parse((REPO / "apps" / "ai" / "nexus_ai" / "api" / "routes_discover.py")
                     .read_text(encoding="utf-8"))
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and isinstance(n.func, ast.Name) and n.func.id == "_grid"]
    assert len(calls) == 1, f"the grid is now built in {len(calls)} places inside the kernel"
    assert any(k.arg == "subject_ids" for k in calls[0].keywords), (
        "the one caller stopped passing the request list - the grid is answering in row order again")


# --------------------------------------------------------------------------- the served grid
def _own_map(subjects: list[str], rows: list[dict], bundle: FactBundle) -> dict[str, dict]:
    """What each NAMED subject can honestly be said to have, from its own row and its own facts."""
    by_subject = {str(r["subject_id"]): r for r in rows}
    out: dict[str, dict] = {}
    for sid in subjects:
        row = by_subject.get(sid)
        rating: set[float] = set()
        if row is not None and row.get("review_count"):
            rating.add(_num(row["rating_agg"]))
        rating_fact = bundle.get("rating", sid)
        if rating_fact is not None and isinstance(rating_fact.value, dict):
            stated = _as_num(rating_fact.value.get("value"))
            if stated is not None:
                rating.add(stated)
        price: set[float] = set()
        if row is not None and row.get("avg_price_hkd") is not None:
            price.add(_num(row["avg_price_hkd"]))
        price_fact = bundle.get("price", sid)
        if price_fact is not None and isinstance(price_fact.value, dict):
            amount = _as_num(price_fact.value.get("amount"))
            if amount is not None:
                price.add(amount)
        own_category = (row.get("category") or row.get("category_primary")) if row else None
        out[sid] = {
            "row": row,
            "rating": rating,
            "price": price,
            "category": {str(own_category)} if own_category else set(),
        }
    return out


def _claim_of(batch: dict, sid: str, attribute: str) -> set:
    return batch["own"].get(sid, {}).get(attribute, set())


@functools.lru_cache(maxsize=1)
def _served_batches() -> tuple[dict, ...]:
    """The census that measured the defect, re-run on the shipped bytes.

    Read-only and expensive enough (four searches, four grids, two bound reads per grid) that the
    live rows below share one run rather than each repeating it; nothing here writes a row and no
    server is started - `TestClient` answers in this process.

    The two phases are sequential on purpose. `db.pool.connect(force_new=True)` - the only way a
    test can read this service's own SQL - CLOSES the process pool the running app is using, so a
    ground-truth read interleaved with the asks knocks the service onto its demo fallback and the
    census then judges live cells against a table that never existed.
    """
    out: list[dict] = []
    with TestClient(create_app(_settings(DB_URL))) as client:
        for label, body in ASKS:
            r = client.post("/ai/v1/search", json=body)
            assert r.status_code == 200, f"{label}: HTTP {r.status_code} {r.text[:200]}"
            ids = [str(i["id"]) for i in (r.json().get("items") or [])]
            batch = {"label": label, "asked": len(ids), "subjects": [],
                     "rows": [], "own": {}, "db_order": []}
            if len(ids) >= 2:
                cr = client.post("/ai/v1/compare", json={"subject_ids": ids[:MAX_IDS]})
                assert cr.status_code == 200, f"{label}: {cr.text[:200]}"
                served = cr.json()
                batch["subjects"] = [str(s) for s in served["subjects"]]
                batch["rows"] = served["rows"]
                assert not served.get("degraded"), (
                    f"{label}: the grid answered degraded ({served.get('degraded')}) - its cells "
                    "come from the demo fixture, so no live row can vouch for them")
            out.append(batch)

    for batch in out:
        if not batch["subjects"]:
            continue
        text, params = SQL.entities_for(str(DEFAULT_TENANT_ID), batch["subjects"])
        entity_rows = _run(text, *params)
        batch["db_order"] = [str(x["subject_id"]) for x in entity_rows]
        ftext, fparams = SQL.facts_for(batch["subjects"], ["price", "rating"])
        bundle = FactBundle(facts_from_rows(_run(ftext, *fparams), now=NOW))
        batch["own"] = _own_map(batch["subjects"], entity_rows, bundle)
    return tuple(out)


def _assert_cells_belong_to_their_subject(batches: tuple[dict, ...], plane: str) -> int:
    """The published rule in Python: cell `i` sits under header `i`, so its value has to be a value
    THAT subject has - never a neighbour's number, never the column default of a subject nobody
    scored, and (for a blank) never a fact either."""
    checked = 0
    wrong: list[str] = []
    for batch in batches:
        if not batch["rows"]:
            continue
        for row in batch["rows"]:
            if len(row["cards"]) != len(batch["subjects"]):
                pytest.fail(
                    f"{plane} {batch['label']}: the {row['attribute']} row answers "
                    f"{len(row['cards'])} cell(s) for {len(batch['subjects'])} named subjects - "
                    "every later number lands under the wrong name")
            for index, (sid, cell) in enumerate(zip(batch["subjects"], row["cards"])):
                if cell["value"] is None:
                    if row["attribute"] == "rating":
                        assert cell["fact_id"] is None, (
                            f"{plane} {batch['label']} position {index}: a blank rating cell cites "
                            f"{cell['fact_id']} - an empty cell carries no phantom fact")
                    continue
                if row["attribute"] not in ("rating", "price", "category"):
                    continue
                claim = batch["own"][sid]
                got = claim[row["attribute"]]
                value = _as_num(cell["value"]) if row["attribute"] != "category" \
                    else str(cell["value"])
                if value not in got:
                    neighbours = [str(s)[:8] for s in batch["subjects"] if s != sid
                                  and value in _claim_of(batch, s, row["attribute"])]
                    wrong.append(
                        f"{batch['label']} position {index} ({sid[:8]}): the {row['attribute']} "
                        f"cell states {cell['value']!r}, this subject holds "
                        f"{sorted(got) or 'nothing'}"
                        + (f" - it belongs to {neighbours}" if neighbours else ""))
                checked += 1
    assert not wrong, f"{plane}: {len(wrong)} cell(s) state a value their own subject does not " \
                      f"hold:\n" + "\n".join(wrong[:12])
    return checked


@live_only
def test_no_served_cell_states_a_value_that_belongs_to_another_subject():
    _assert_cells_belong_to_their_subject(_served_batches(), "live")


@live_only
def test_no_served_rating_cell_states_a_score_for_a_subject_nobody_reviewed():
    """D669's phantom, on the surface that had no door for it."""
    offenders = []
    for batch in _served_batches():
        for row in batch["rows"]:
            if row["attribute"] != "rating":
                continue
            for index, (sid, cell) in enumerate(zip(batch["subjects"], row["cards"])):
                claim = batch["own"].get(sid) or {}
                row_data = claim.get("row")
                if cell["value"] is None or row_data is None or row_data.get("review_count"):
                    continue
                offenders.append((batch["label"], index, sid[:8], cell["value"],
                                  cell["fact_id"]))
    assert not offenders, (
        f"{len(offenders)} cell(s) state a score for a subject whose own row says no review was "
        f"counted (V1 declares `rating_agg` and `review_count` both NOT NULL DEFAULT 0, so the "
        f"printed score is the column): {offenders[:8]}")


# --------------------------------------------------------------------------- non-vacuity
@live_only
def test_the_census_this_reads_still_contains_both_shapes():
    """A door that only asserts an absence is satisfied by an answer that stops serving these
    subjects, so the population the asserts above cover is measured here.

    Both figures are the ones `tmp/d670_before.txt` had to have in order to report 47 misplaced
    cells and 8 phantom scores: a batch whose rows arrive in a different sequence than the request
    named, and a served subject the columns say nobody reviewed.
    """
    batches = _served_batches()
    answered = [b for b in batches if b["rows"]]
    assert answered, f"no ask served a comparison grid: {[b['label'] for b in batches]}"
    shuffled = [b["label"] for b in answered if b["db_order"] != b["subjects"]]
    assert shuffled, (
        "every batch now arrives in the order it was named - the read changed, so the ordering "
        f"asserts measure an empty set: {[b['db_order'][:1] for b in answered]}")
    unrated = [(b["label"], sid[:8]) for b in answered for sid in b["subjects"]
               if (b["own"].get(sid) or {}).get("row") is not None
               and not (b["own"][sid]["row"].get("review_count") or 0)]
    assert unrated, (
        "no served subject has a zero review count - the phantom-score row above is measuring "
        "nothing; `tmp/d670_before.txt` found 8 of them in these asks")
    checked = _assert_cells_belong_to_their_subject(batches, "live")
    assert checked >= 20, (
        f"the census attributed only {checked} stated value(s) across {len(answered)} batch(es) - "
        "the rows above are thin enough that a grid which stopped answering would pass them")


@live_only
def test_the_cells_move_with_the_names_and_not_with_the_reads_sequence():
    """The probe that made the defect unarguable, kept as a gate.

    Four published merchants with four DISTINCT aggregates, so no misplacement can hide behind an
    equal value; asked twice, once in an order the read does not answer in and once reversed. The
    request order is derived from the read rather than guessed, so the first ask is guaranteed to be
    the one the shipped `entities_for` would have mislabelled.
    """
    picked = _run("""
        select distinct on (m.rating_agg) m.id::text as id
        from merchants m
        where m.status = 'published' and m.review_count > 0
        order by m.rating_agg, m.id
        limit 4""")
    assert len(picked) == 4, f"the plane does not offer four distinct rated merchants: {picked}"
    ids = [p["id"] for p in picked]
    text, params = SQL.entities_for(str(DEFAULT_TENANT_ID), ids)
    entity_rows = _run(text, *params)
    assert len(entity_rows) == 4, f"the read dropped a subject: {entity_rows}"
    db_order = [str(r["subject_id"]) for r in entity_rows]
    # four different numbers, so no misplacement can hide behind an equal value
    canon = {str(r["subject_id"]): _num(r["rating_agg"]) for r in entity_rows}
    assert len(set(canon.values())) == 4, canon

    named = db_order[1:] + db_order[:1]
    assert named != db_order, (
        f"the read answered in the order named ({db_order}) - the probe can no longer tell the two "
        "sequences apart, so aim it at a rotation of a longer list")

    ftext, fparams = SQL.facts_for(ids, ["price", "rating"])
    bundle = FactBundle(facts_from_rows(_run(ftext, *fparams), now=NOW))
    own = _own_map(ids, entity_rows, bundle)

    with TestClient(create_app(_settings(DB_URL))) as client:
        cells: list[list[Any]] = []
        for order in (named, list(reversed(named))):
            cr = client.post("/ai/v1/compare", json={"subject_ids": order})
            assert cr.status_code == 200, cr.text[:200]
            body = cr.json()
            assert [str(s) for s in body["subjects"]] == order, (
                "the response stopped echoing the request - the headers the renderer uses are now "
                "a third sequence, and this row compares cells against the wrong names")
            row = next((r for r in body["rows"] if r["attribute"] == "rating"), None)
            assert row is not None, f"no rating row for four rated merchants: {body['rows']}"
            values = [c["value"] for c in row["cards"]]
            for sid, value in zip(order, values):
                assert value is not None and _num(value) in own[sid]["rating"], (
                    f"asked in order {[s[:8] for s in order]}, the rating row answered {values} "
                    f"while {sid[:8]} holds {sorted(own[sid]['rating'])} - the cells are still in "
                    "the read's sequence")
            assert values != [canon[s] for s in db_order], (
                f"the grid answered the read's own sequence {values} under the named headers "
                f"{[s[:8] for s in order]} - that is D670 itself")
            cells.append(values)
    assert cells[1] == list(reversed(cells[0])), (
        f"the two asks answered {cells[0]} and {cells[1]} - a table that does not move with its "
        "headers is the defect this row pins")


@live_only
def test_a_subject_the_read_cannot_answer_holds_its_column_in_the_served_grid():
    """Charge (b) on the surface a user sees: three names, one row, three cells.

    `tmp/d670_missing.txt` recorded this exact ask answering one cell per row. The phantom id is
    first so the shape cannot pass by getting lucky: before the fix the only column - the real
    offering's - sat under the phantom's header.
    """
    offering = _run("""
        select o.id::text as id from offerings o
        join merchants m on m.id = o.merchant_id
        where o.status = 'active' and m.status = 'published' and o.review_count > 0
        order by o.id limit 1""")
    draft = _run("""
        select id::text as id from merchants where status <> 'published'
        order by id limit 1""")
    assert offering and draft, f"the plane has no reachable offering or no unpublished row: " \
                               f"{offering} / {draft}"
    phantom = str(uuid4())
    ids = [phantom, offering[0]["id"], draft[0]["id"]]

    text, params = SQL.entities_for(str(DEFAULT_TENANT_ID), ids)
    rows = _run(text, *params)
    assert len(rows) == 1, (
        f"the read now answers for all of {[i[:8] for i in ids]} - the blank-column case this row "
        f"pins no longer exists on this plane ({[str(r['subject_id'])[:8] for r in rows]})")

    with TestClient(create_app(_settings(DB_URL))) as client:
        cr = client.post("/ai/v1/compare", json={"subject_ids": ids})
        assert cr.status_code == 200, cr.text[:200]
        body = cr.json()
    subjects = [str(s) for s in body["subjects"]]
    assert subjects == ids, subjects
    ftext, fparams = SQL.facts_for(ids, ["price", "rating"])
    bundle = FactBundle(facts_from_rows(_run(ftext, *fparams), now=NOW))
    own = _own_map(ids, rows, bundle)
    answered = str(rows[0]["subject_id"])
    for row in body["rows"]:
        assert len(row["cards"]) == 3, (
            f"the {row['attribute']} row answered {len(row['cards'])} cell(s) for 3 named subjects")
        assert row["cards"][0]["value"] is None and row["cards"][0]["fact_id"] is None, (
            f"the {row['attribute']} cell under a uuid nobody holds states "
            f"{row['cards'][0]['value']!r} citing {row['cards'][0]['fact_id']}")
    rating = next(r for r in body["rows"] if r["attribute"] == "rating")
    assert rating["cards"][1]["value"] is not None, (
        f"the one subject the read answered for ({answered[:8]}) lost its column: "
        f"{rating['cards']}")
    _assert_cells_belong_to_their_subject(
        ({"label": "missing", "asked": 3, "subjects": ids, "rows": body["rows"],
          "own": own, "db_order": [str(r["subject_id"]) for r in rows]},), "live")
