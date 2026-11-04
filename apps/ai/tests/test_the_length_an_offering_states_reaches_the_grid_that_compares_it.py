"""D675 - the length an offering states reaches the grid that compares it with the others.

The unit before this one put `duration_minutes` on the card (§671). A reader who then pressed
「對比」 got the same two offerings answered by a different read, and that read could not say what
either of them takes: `apps/ai/nexus_ai/api/routes_discover.py` emitted six attribute rows -
`price, rating, category, district, open_state, distance` - and no seventh for the length, because
`search/sql.entities_for`, the `/ai/v1/compare` projection, named none of the four Booking columns
while `build_offering_query`, the search's projection, names all four. Measured on the bytes before
this unit (`tmp/d675_measure.py`, record `tmp/d675_measure.txt`): eight asks served 48 cards over 28
distinct offering subjects, **17 of them printing a length**, and four `POST /ai/v1/compare` calls
made over exactly those subjects answered **3-4 rows each, none of them a length**. So one reader of
the same row was told 90 minutes and the other was told nothing.

What the corpus and the two planes allow, from the same record:

  * **4,707 reachable offerings** (`active` under a `published` merchant), of which **682 state a
    length** - 496 of 822 `service`, 186 of 313 `experience`, 0 of 3,572 `product`. The values are
    30, 45, 60, 90, 120 and 180 and nothing else, with no zero and no negative, so a cell has no
    rounding decision to make (`tmp/d675_dur_stats.py`).
  * **`merchants` names none of the four Booking columns** - V1 gives that table `avg_price_hkd`
    and `price_band` and no length - so the merchant branch of the `UNION ALL` answers "no length"
    and a batch of merchants loses the row on the grid's own `any value` guard rather than showing
    a row of dashes. That NULL is also a positional necessity: a `UNION ALL` matches its branches
    by position, which is why the legs below count both SELECT lists.
  * the renderer prints the row's name out of a table the OTHER lane owns: `CompareTable.tsx` does
    `labels.rowLabels?.[row.attribute] ?? row.attribute`, so an unlabelled row shows a reader of a
    Chinese interface the identifier `duration`. `apps/web/src/lib/compare-row-labels.test.ts`
    already gates that by reading this module's row list as text; the leg below keeps the same
    promise from this side of the boundary, and the name went into both `rowLabels` blocks of
    `apps/web/src/lib/i18n/trust-labels.ts`.
  * the cell has to cite something: `CompareTable` renders a cell with no `fact_id` as the
    unverified marker, so the length is grounded the way D401 grounds `category` and `open_state`
    and D590 grounds the price clock - it is the merchant's own recorded column, so it carries a
    `merchant` source and never an `inferred` one it did not earn.

Two things this unit does NOT do:

  * it borrows no length. The only duration-shaped facts on this corpus are **157 merchant-sourced
    `capacity` facts** whose `value->>'duration_minutes'` agrees with the column on all 157 - and
    they are a `capacity` claim, not a `duration` one (D611: a claim vouched for by a number of a
    kind it did not say). The grid reads the column. A subject whose column states nothing stays a
    blank cell even when a `capacity` fact beside it names 45, and a subject whose column states
    90 keeps its own 90 when a `capacity` fact contradicts it; both halves are legs below.
  * it invents no clock and no predicate. `facts` holds no `attribute = 'duration'` row and this
    unit writes none - the cell cites a fact of this request, like the `open_state` and `distance`
    rows do - and the length stays out of every `WHERE`, so which subjects answer a comparison is
    unchanged by this unit.

`packages/types/src/search.ts:199-200` types a cell as `string | number | null`, "null when the
subject has no value for this attribute", which is what both the text cell and the blank one are
here - and the text is the minutes as the merchant wrote them, localized, never re-expressed as
hours: 90 is 「90 分鐘」, because a cell that converts is a cell that can disagree with the card.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient

from nexus_ai.api import routes_discover as RD
from nexus_ai.api.app import create_app
from nexus_ai.config import Settings
from nexus_ai.contract import CompareResponse, CompareRow
from nexus_ai.db import pool as db_pool
from nexus_ai.search import cards as CARDS
from nexus_ai.search import sql as SQL
from nexus_ai.trust.facts import FactBundle

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("NEXUS_TEST_DATABASE_URL", "").strip()
live_only = pytest.mark.skipif(not DB_URL, reason="NEXUS_TEST_DATABASE_URL is not set")

NOW = datetime(2026, 11, 4, 2, 0, 0, tzinfo=timezone.utc)
#: the value of `search.service.DEFAULT_TENANT_ID`, inlined so this file reads only the projection
TENANT = "00000000-0000-0000-0000-000000000001"

DISCOVER_PY = (REPO / "apps/ai/nexus_ai/api/routes_discover.py").read_text(encoding="utf-8")
LABELS_TS = (REPO / "apps/web/src/lib/i18n/trust-labels.ts").read_text(encoding="utf-8")
COMPARE_TSX = (REPO / "packages/ui/src/trust/CompareTable.tsx").read_text(encoding="utf-8")
SEARCH_TS = (REPO / "packages/types/src/search.ts").read_text(encoding="utf-8")


# --------------------------------------------------------------------------- the read
def _branches() -> list[str]:
    """The two `UNION ALL` branches of the shipped compare read, in order."""
    text, _params = SQL.entities_for(TENANT, [str(uuid4()), str(uuid4())])
    branches = text.split("UNION ALL")
    assert len(branches) == 2, f"the compare read is no longer one merchant + one offering: {branches}"
    return branches


def _select_list(branch: str) -> list[str]:
    """A branch's projection, split on top-level commas only."""
    body = branch.split("SELECT", 1)[1].split("FROM", 1)[0]
    items, depth, current = [], 0, ""
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            items.append(current.strip())
            current = ""
        else:
            current += ch
    if current.strip():
        items.append(current.strip())
    return [i for i in items if i]


def _where_of(branch: str) -> str:
    return branch.split("WHERE", 1)[1] if "WHERE" in branch else ""


def _alias(item: str) -> str:
    return item.split(" AS ", 1)[1].strip() if " AS " in item else ""


def test_the_compare_read_selects_the_length_the_card_read_already_selected():
    """§671 filed this projection as the residue it left behind, and named it the one to edit."""
    merchant_branch, offering_branch = _branches()
    assert "o.duration_minutes" in offering_branch, (
        "the compare read stopped selecting the column, so the grid can answer no length row - "
        "this is the projection §671's own residue note points at")
    assert "NULL::int AS duration_minutes" in merchant_branch, (
        "`merchants` has no length column, so a merchant row states no length. NULL, not 0: a zero "
        "would be a claim about a thing nobody said, which is D669 in a new costume")
    for branch in _branches():
        assert "duration_minutes" not in _where_of(branch), (
            "the only place either branch may name the column is its projection: a predicate on the "
            "length would silently shrink the pool the caller named")


def test_the_two_branches_still_line_up_by_position():
    """A `UNION ALL` matches by POSITION, so the merchant branch needs a NULL in the same slot.

    Not a style point: with one fewer column in one branch every `/ai/v1/compare` request against a
    real database raises `each UNION query must have the same number of columns`, which the route
    catches and answers as a 503. So the shape is pinned where it is written, not only by the legs
    that run it.
    """
    merchant_cols, offering_cols = (_select_list(b) for b in _branches())
    assert len(merchant_cols) == len(offering_cols), (
        f"the merchant branch selects {len(merchant_cols)} columns and the offering's "
        f"{len(offering_cols)}; Postgres matches them positionally, so one of the two is misaligned")
    at_merchant = [i for i, c in enumerate(merchant_cols) if "duration_minutes" in c]
    at_offering = [i for i, c in enumerate(offering_cols) if "duration_minutes" in c]
    assert at_merchant == at_offering, (
        f"the length sits at column {at_merchant} of the merchant branch and {at_offering} of the "
        "offering's - every cell after it would be read under the wrong row")
    moved = [(i, _alias(m), _alias(o)) for i, (m, o) in enumerate(zip(merchant_cols, offering_cols))
             if _alias(m) and _alias(o) and _alias(m) != _alias(o)]
    assert not moved, f"the two branches name the same slot differently: {moved}"


# --------------------------------------------------------------------------- the formatter
@pytest.mark.parametrize("minutes,locale,expected", [
    (90, "zh-HK", "90 分鐘"), (90, "zh-CN", "90 分钟"), (90, "en", "90 min"),
    (45, "zh-HK", "45 分鐘"), (180, "en", "180 min"), (30, "zh-CN", "30 分钟"),
])
def test_the_text_is_the_minutes_the_row_states_in_the_locale_the_request_named(minutes, locale,
                                                                                expected):
    assert CARDS.duration_text(minutes, locale) == expected


def test_the_number_is_never_re_expressed():
    """180 is 「180 分鐘」, not "3 hours": a cell that converts is a cell that can drift."""
    for minutes in (30, 45, 60, 90, 120, 180):
        for locale in ("zh-HK", "zh-CN", "en"):
            text = CARDS.duration_text(minutes, locale)
            assert str(minutes) in text, f"{minutes} states {text!r} in {locale}"
            assert not re.search(r"\d+\.\d", text), f"{minutes} was re-expressed as {text!r}"
    assert CARDS.duration_text(None, "zh-HK") == "", "nothing stated is nothing printed"


def test_an_unexpected_locale_falls_back_rather_than_raising():
    """`CompareRequest.locale` is a bare `str = "zh-HK"`, so anything can arrive in it."""
    assert CARDS.duration_text(90, "ja-JP") == "90 分鐘"
    assert CARDS.duration_text(90, "") == "90 分鐘"
    assert CARDS.duration_text(90) == "90 分鐘"


# --------------------------------------------------------------------------- the grid, offline
def _offering_row(sid: str, *, minutes: Any = 90, **over) -> dict:
    """An offering row in the shape the shipped `entities_for` returns it."""
    row = {"subject_id": sid, "subject_type": "offering", "merchant_id": str(uuid4()),
           "slug": "heritage-walk-3-hours", "name": "Heritage Walk", "name_zh": None,
           "kind": "experience", "category": "Heritage Tour", "avg_price_hkd": 340.0,
           "currency": "HKD", "price_model": None, "price_updated_at": None,
           "price_source": None, "duration_minutes": minutes,
           "rating_agg": 4.3, "review_count": 21, "description": None,
           "data_origin": "seeded", "plan": "pro", "attributes": {}, "images": [],
           "ai_agent_enabled": True, "status": "active"}
    row.update(over)
    return row


def _merchant_row(sid: str, **over) -> dict:
    """A merchant row - the branch that selects NULL for the length and has no kind at all."""
    row = {"subject_id": sid, "subject_type": "merchant", "merchant_id": sid,
           "slug": "sham-shui-terraces", "name": "Sham Shui Terraces", "name_zh": None,
           "kind": None, "category": "Cantonese", "avg_price_hkd": 240.0, "currency": None,
           "price_model": None, "price_updated_at": None, "price_source": None,
           "duration_minutes": None, "rating_agg": 4.6, "review_count": 88,
           "description": None, "data_origin": "seeded", "plan": "pro", "attributes": {},
           "images": [], "ai_agent_enabled": True, "status": "published"}
    row.update(over)
    return row


def _grid(rows: list[dict], named: list[str], *, bundle: FactBundle | None = None,
          locale: str = "zh-HK") -> list[dict]:
    return RD._grid(rows, bundle if bundle is not None else FactBundle(), {},
                    subject_ids=[str(s) for s in named], now=NOW, locale=locale)


def _column(grid: list[dict], attribute: str) -> list[dict]:
    row = next((r for r in grid if r["attribute"] == attribute), None)
    assert row is not None, f"the grid answers no {attribute} row: {[r['attribute'] for r in grid]}"
    return row["cards"]


S1, S2, S3 = str(uuid4()), str(uuid4()), str(uuid4())


def test_two_offerings_that_state_a_length_get_a_row_that_states_both():
    rows = [_offering_row(S1, minutes=90), _offering_row(S2, minutes=120)]
    bundle = FactBundle([])
    cells = _column(_grid(rows, [S1, S2], bundle=bundle), "duration")
    assert [c["value"] for c in cells] == ["90 分鐘", "120 分鐘"]
    assert len(cells) == 2, "one cell per named subject"
    for cell, row in zip(cells, rows):
        assert cell["fact_id"], f"the grid prints {cell['value']} and cites nothing"
        assert cell["source"] == "merchant", (
            f"the length is the merchant's own column, so it carries a merchant source, not an "
            f"inferred one - got {cell['source']}")
        assert cell["confidence"] == 0.9
        assert cell["observed_at"] == NOW.isoformat(), (
            "the cell's clock is the request's, exactly like the category and open_state rows")
        fact = next(f for f in bundle.facts if str(f.fact_id) == cell["fact_id"])
        assert fact.attribute == "duration"
        assert fact.subject_id == UUID(row["subject_id"]), (
            "the fact is keyed to the subject the cell sits under, not to its merchant (D609)")
        assert fact.value == {"minutes": int(row["duration_minutes"]), "text": cell["value"]}, (
            f"the fact behind the cell says {fact.value}")


def test_a_subject_that_states_nothing_is_a_blank_cell_and_not_a_missing_one():
    """D670's invariant, re-asserted on the new row: the grid answers every subject it named."""
    cells = _column(_grid([_offering_row(S1, minutes=90), _offering_row(S2, minutes=None)],
                          [S1, S2]), "duration")
    assert [c["value"] for c in cells] == ["90 分鐘", None]
    assert cells[1]["fact_id"] is None, "an empty cell carries no phantom fact"
    assert cells[1]["source"] is None and cells[1]["confidence"] is None


@pytest.mark.parametrize("rows", [
    [_merchant_row(S1), _merchant_row(S2)],
    [_offering_row(S1, minutes=None, kind="product"),
     _offering_row(S2, minutes=None, kind="product")],
])
def test_a_batch_in_which_no_subject_states_a_length_answers_no_duration_row(rows):
    """The row is absent, never a row of dashes - the grid's own `any value` guard."""
    grid = _grid(rows, [r["subject_id"] for r in rows])
    assert "duration" not in [r["attribute"] for r in grid], (
        f"a comparison of two subjects that state nothing grew a length row: {grid}")


def test_the_length_under_each_subject_is_its_own():
    """The rows arrive in one order and the caller names them in another (D670)."""
    rows = [_offering_row(S1, minutes=45), _offering_row(S2, minutes=180),
            _offering_row(S3, minutes=90)]
    own = {r["subject_id"]: r["duration_minutes"] for r in rows}
    for named in ([S3, S1, S2], [S2, S3, S1], [S1, S2, S3]):
        cells = _column(_grid(rows, named), "duration")
        assert [c["value"] for c in cells] == [f"{own[s]} 分鐘" for s in named], (
            f"named {named}, got {[c['value'] for c in cells]}")


def test_the_row_follows_the_locale_the_request_named():
    rows = [_offering_row(S1, minutes=90), _offering_row(S2, minutes=120)]
    for locale, expected in (("zh-HK", "90 分鐘"), ("zh-CN", "90 分钟"), ("en", "90 min")):
        cells = _column(_grid(rows, [S1, S2], locale=locale), "duration")
        assert cells[0]["value"] == expected, f"{locale} answered {cells[0]['value']!r}"
        assert cells[1]["value"].startswith("120"), f"{locale} shifted the second cell"


def test_the_grid_borrows_no_length_from_a_capacity_fact():
    """The 157 `capacity` facts are a capacity claim; D611 is why this leg exists at all."""
    contradicting = FactBundle([])
    contradicting.synth(subject_type="offering", subject_id=S1, attribute="capacity",
                        value={"duration_minutes": 45, "max_party_size": 2},
                        source="merchant", confidence=0.98, observed_at=NOW - timedelta(days=1))
    cells = _column(_grid([_offering_row(S1, minutes=90)], [S1], bundle=contradicting),
                    "duration")
    assert cells[0]["value"] == "90 分鐘", (
        f"the cell read the capacity fact ({cells[0]['value']!r}) instead of the column")

    silent = FactBundle([])
    silent.synth(subject_type="offering", subject_id=S2, attribute="capacity",
                 value={"duration_minutes": 60, "max_party_size": 4},
                 source="merchant", confidence=0.95, observed_at=NOW)
    grid = _grid([_offering_row(S2, minutes=None)], [S2], bundle=silent)
    assert "duration" not in [r["attribute"] for r in grid], (
        "a subject whose own column states no length grew a row out of a capacity fact - the column "
        "is the claim the contract names, and a number of a kind it did not say cannot vouch for it")


def test_the_new_row_keeps_the_cells_the_response_model_publishes():
    rows = [_offering_row(S1, minutes=90), _offering_row(S2, minutes=None)]
    grid = _grid(rows, [S1, S2])
    response = CompareResponse(rows=[CompareRow(**row) for row in grid],
                               subjects=[S1, S2], degraded=False, source="postgres")
    dumped = json.loads(response.model_dump_json())
    cell = next(r for r in dumped["rows"] if r["attribute"] == "duration")["cards"][0]
    assert set(cell) == {"value", "fact_id", "source", "observed_at", "confidence"}, (
        f"a compare cell changed its keys on the wire: {sorted(cell)}")
    assert isinstance(cell["value"], str), (
        "`search.ts` types a cell as `string | number | null`; this row ships text so a reader is "
        "not handed a bare 90 with no unit")
    answered = [r["attribute"] for r in dumped["rows"]]
    assert answered == [a for a in _emitted_attributes() if a in answered], (
        f"the grid answered {answered} in an order its own emit loop does not declare - "
        f"{_emitted_attributes()}")


# --------------------------------------------------------------------------- the other plane
def _emitted_attributes() -> list[str]:
    loop = re.search(r"for attribute, cells in \(([\s\S]*?)\):", DISCOVER_PY)
    assert loop, "_compare_rows no longer holds the `for attribute, cells in (...)` loop"
    found = [m.group(1) for m in re.finditer(r'\("([a-z_]+)",\s*\w+\)', loop.group(1))]
    assert found, "the compare loop names no (\"attribute\", cells) pairs, so this leg read nothing"
    return found


def _label_blocks() -> list[tuple[str, dict[str, str]]]:
    blocks = re.findall(r"rowLabels:\s*\{([^}]*)\}", LABELS_TS, flags=re.S)
    assert len(blocks) == 2, f"expected the zh and en rowLabels blocks, found {len(blocks)}"
    return [(block, dict(re.findall(r"([a-z_]+):\s*'([^']*)'", block))) for block in blocks]


def test_the_grid_has_a_row_name_for_the_length_in_both_locales():
    """`CompareTable` prints `?? row.attribute`, so an unlabelled row shows the identifier.

    `apps/web/src/lib/compare-row-labels.test.ts` gates this from the other side by reading this
    module's row list as text. From here it is the same promise with the same witness, and it is
    the reason the label went in on the same commit as the row: a reader of a Chinese interface
    must see 「時長」, not `duration`.
    """
    assert "?? row.attribute" in COMPARE_TSX, (
        "CompareTable no longer falls back to the raw attribute key, so this leg's reason moved")
    emitted = _emitted_attributes()
    assert "duration" in emitted, f"the grid emits {emitted} - there is no length row in it"
    for index, (_block, labels) in enumerate(_label_blocks()):
        plane = "zh-HK" if index == 0 else "en"
        assert "duration" in labels, f"the {plane} rowLabels block has no name for the length row"
        assert not re.fullmatch(r"[a-z][a-z_]*", labels["duration"]), (
            f"the {plane} label is the identifier spelled again: {labels['duration']!r}")
        assert set(labels) == set(emitted), (
            f"the {plane} block and the emitted rows disagree: labels {sorted(labels)}, "
            f"emitted {emitted}")


def test_the_published_cell_type_still_allows_what_the_row_sends():
    assert "string | number | null" in SEARCH_TS, (
        "the published cell type moved; this row ships a localized string and a blank")
    assert "null when the subject has no value for this attribute" in SEARCH_TS, (
        "the sentence that makes a blank cell legal is gone, and with it the reason this row "
        "answers blanks instead of dropping subjects")


# --------------------------------------------------------------------------- the served answer
def _settings(database_url: str = "") -> Settings:
    return Settings(llm_provider="mock", embedding_provider="hashing",
                    database_url=database_url, internal_token="")


def _run(query: str, *params) -> list[dict]:
    settings = _settings(DB_URL)

    async def _go():
        db = await db_pool.connect(settings, force_new=True)
        try:
            return [dict(r) for r in await db.fetch(query, *params)]
        finally:
            await db_pool.dispose()

    return asyncio.run(_go())


def _compare(ids: list[str], *, locale: str = "zh-HK", geo: dict | None = None) -> dict:
    with TestClient(create_app(_settings(DB_URL))) as c:
        body: dict[str, Any] = {"subject_ids": ids, "locale": locale}
        if geo:
            body["geo"] = geo
        r = c.post("/ai/v1/compare", json=body)
        assert r.status_code == 200, f"compare {ids}: HTTP {r.status_code} {r.text[:240]}"
        payload = r.json()
    assert not payload.get("degraded"), f"compare {ids}: served degraded, so the read proves nothing"
    return payload


def _offerings_stating_a_length(kind: str | None = None) -> list[dict]:
    extra = " AND o.kind = $1" if kind else ""
    sql = ("SELECT o.id::text AS id, o.kind, o.duration_minutes FROM offerings o "
           " JOIN merchants m ON m.id = o.merchant_id "
           "WHERE o.status = 'active' AND m.status = 'published' "
           "  AND o.duration_minutes IS NOT NULL" + extra + " ORDER BY o.id LIMIT 4")
    return _run(sql, *([kind] if kind else []))


@live_only
def test_the_compare_read_runs_and_the_length_reaches_the_answer():
    pairs = _offerings_stating_a_length()[:2]
    assert len(pairs) == 2, f"only {len(pairs)} reachable offerings state a length"
    ids = [p["id"] for p in pairs]
    payload = _compare(ids)
    attributes = [row["attribute"] for row in payload["rows"]]
    assert "duration" in attributes, (
        f"the grid answers {attributes} for two subjects the database says take "
        f"{[p['duration_minutes'] for p in pairs]} minutes")
    cells = _column(payload["rows"], "duration")
    assert [c["value"] for c in cells] == [f"{p['duration_minutes']} 分鐘" for p in pairs], (
        f"the row says {[c['value'] for c in cells]} for ids {ids}")
    for cell in cells:
        assert cell["fact_id"] and cell["source"] == "merchant", (
            f"an uncited length reached a live answer: {cell}")


@live_only
def test_the_grid_and_the_card_state_one_length_about_the_same_offering():
    """The two readers of one row, on one corpus - the whole point of the unit."""
    pool_rows = _offerings_stating_a_length("service")[:2]
    assert len(pool_rows) == 2, (
        f"only {len(pool_rows)} reachable `service` offerings state a length; §671 measured 496 of "
        "822, so this leg needs re-measuring rather than deleting")
    ids = [p["id"] for p in pool_rows]
    cells = _column(_compare(ids)["rows"], "duration")
    cards = {r["id"]: r["duration_minutes"] for r in _run(
        """SELECT id::text AS id, duration_minutes FROM offerings WHERE id = ANY($1::uuid[])""",
        ids)}
    for index, sid in enumerate(ids):
        assert cells[index]["value"] == f"{cards[sid]} 分鐘", (
            f"{sid}: the column says {cards[sid]}, the grid cell says {cells[index]['value']!r}")


@live_only
def test_a_comparison_of_two_merchants_answers_no_length_row():
    ids = [r["id"] for r in _run(
        """SELECT id::text AS id FROM merchants WHERE status = 'published' ORDER BY id LIMIT 2""")]
    assert len(ids) == 2, "the corpus needs two published merchants for this leg"
    payload = _compare(ids)
    assert payload["rows"], "a merchant comparison answered no rows at all"
    assert "duration" not in [row["attribute"] for row in payload["rows"]], (
        "`merchants` has no length column, so a row of blanks would be a row of claims about "
        "nothing; the grid's own guard is what keeps this row off a merchant comparison")


@live_only
def test_a_product_batch_answers_no_length_row():
    ids = [r["id"] for r in _run(
        """SELECT o.id::text AS id FROM offerings o JOIN merchants m ON m.id = o.merchant_id
            WHERE o.kind = 'product' AND o.status = 'active' AND m.status = 'published'
            ORDER BY o.id LIMIT 2""")]
    assert len(ids) == 2, "no two reachable products"
    stating = _run("""SELECT id::text AS id FROM offerings WHERE id = ANY($1::uuid[])
                      AND duration_minutes IS NOT NULL""", ids)
    assert not stating, (
        f"{len(stating)} product row(s) state a length; §668 measured 0 of 4,184 and the closed "
        "card refuses the key on `product` anyway, so a grid row here would be a second reader "
        "disagreeing with the contract rather than a new fact")
    payload = _compare(ids)
    assert "duration" not in [row["attribute"] for row in payload["rows"]]


@live_only
def test_the_length_row_keeps_its_cells_under_the_subjects_the_request_named():
    """D670's order rule, on the new row and on the shipped read."""
    pairs = _offerings_stating_a_length()[:2]
    own = {p["id"]: p["duration_minutes"] for p in pairs}
    for named in ([p["id"] for p in pairs], list(reversed([p["id"] for p in pairs]))):
        cells = _column(_compare(named)["rows"], "duration")
        assert [c["value"] for c in cells] == [f"{own[s]} 分鐘" for s in named], (
            f"named {named}, got {[c['value'] for c in cells]}")


@live_only
def test_the_geo_lane_and_the_length_row_answer_together():
    """A `geo` request already grew a distance row; the new row has to keep the shape of the rest."""
    ids = [p["id"] for p in _offerings_stating_a_length()[:2]]
    payload = _compare(ids, geo={"lat": 22.3193, "lng": 114.1694})
    attributes = [row["attribute"] for row in payload["rows"]]
    assert "distance" in attributes and "duration" in attributes, attributes
    for row in payload["rows"]:
        assert len(row["cards"]) == len(ids), (
            f"the {row['attribute']} row answers {len(row['cards'])} cells for {len(ids)} subjects")


@live_only
def test_the_length_row_cites_a_fact_the_run_records():
    """D460: the comparison's grid facts ARE its `fact_ids`, so a row that cites is a row recorded."""
    ids = [p["id"] for p in _offerings_stating_a_length()[:2]]
    payload = _compare(ids)
    cited = [c["fact_id"] for c in _column(payload["rows"], "duration") if c["fact_id"]]
    assert len(cited) == len(ids), f"{len(cited)} of {len(ids)} live length cells cite a fact"
    rows = _run("""SELECT fact_ids FROM agent_runs WHERE agent = 'compare_entities'
                   ORDER BY started_at DESC NULLS LAST LIMIT 1""")
    if not rows or rows[0]["fact_ids"] is None:
        pytest.skip("the run recorder wrote no fact_ids for this comparison")
    recorded = {str(f) for f in rows[0]["fact_ids"]}
    assert set(cited) <= recorded, (
        f"the length cells cite {sorted(set(cited) - recorded)} that the run does not record")
