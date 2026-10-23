"""Contract tests for the embed+store stage (``rag/embed.py``, docs/RAG.md §2, DECISIONS D3).

The module had **no tests at all** (D507 added it). Its pure layer is pinned here with a fake
async database and adapter — no real DB, no network:

  * the validation refusals (wrong dim, all-zero vector, short answer) — a refused batch leaves
    its rows `pending` rather than labelling an unretrievable row "embedded";
  * the parameterized `build_store_query` (VALUES rows, `embedding IS NULL` guard, `RETURNING`);
  * the batching loop's counts (`scanned` / `stored` / `batches`), the poisoned-batch path, and
    the `limit` cap.

Every assertion was confirmed against the running module (empirical probe), never guessed.
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import nexus_ai.rag.embed as E

NOW = datetime(2026, 1, 1, tzinfo=timezone.utc)
ID1 = "11111111-1111-1111-1111-111111111111"
ID2 = "22222222-2222-2222-2222-222222222222"


def _vec() -> list[float]:
    """A valid 1024-d vector (non-zero, so it passes the refusal)."""
    return [0.1] + [0.0] * (E.DIM - 1)


class FakeDB:
    """Emulates `id > cursor ORDER BY id LIMIT want`, plus the count query."""

    def __init__(self, rows, written_per_write: int = 1):
        self.rows = list(rows)
        self.written_per_write = written_per_write
        self.writes: list[tuple] = []

    async def fetch(self, sql, *args):
        if "count(*)" in sql:
            return [{"n": 0}]
        cursor, _tenant, want = args[0], args[1], args[2]
        pool = [r for r in self.rows if str(r["id"]) > str(cursor)]
        return pool[:want]

    async def write(self, sql, *params):
        self.writes.append((sql, params))
        return [{"id": "x"} for _ in range(self.written_per_write)]


class FakeAdapter:
    def __init__(self, answer_count: int):
        self.answer_count = answer_count

    async def embed(self, texts):
        return [_vec() for _ in range(self.answer_count)]


ROWS = [{"id": ID1, "text": "a"}, {"id": ID2, "text": "b"}]


class TestModelTag:
    def test_model_wins_over_name(self):
        assert E.model_tag(SimpleNamespace(model="m", name="n")) == "m"

    def test_name_fallback(self):
        assert E.model_tag(SimpleNamespace(name="n")) == "n"

    def test_empty(self):
        assert E.model_tag(object()) == ""


class TestValidateVector:
    def test_valid_vector_is_returned_as_floats(self):
        out = E._validate_vector(_vec(), position=0, dim=E.DIM)
        assert len(out) == E.DIM

    def test_wrong_dim_is_refused(self):
        with pytest.raises(E.EmbeddingRefusal):
            E._validate_vector([0.1, 0.2], position=0, dim=E.DIM)

    def test_all_zero_is_refused(self):
        # cosine cannot rank a zero vector; storing it would label an unretrievable row embedded
        with pytest.raises(E.EmbeddingRefusal):
            E._validate_vector([0.0] * E.DIM, position=0, dim=E.DIM)


class TestValidateAnswer:
    def test_short_answer_is_refused(self):
        with pytest.raises(E.EmbeddingRefusal):
            E._validate_answer(["a"], [_vec(), _vec()])

    def test_valid_answer_passes(self):
        out = E._validate_answer(["a", "b"], [_vec(), _vec()])
        assert len(out) == 2


class TestBuildStoreQuery:
    def test_sql_shape_and_guards(self):
        sql, params = E.build_store_query([ID1], [_vec()], model="hashing", stamped_at=NOW)
        assert "UPDATE chunks" in sql
        assert "embedding IS NULL" in sql  # never overwrite a row another pass stamped
        assert "RETURNING c.id" in sql

    def test_params_are_bound_in_order(self):
        sql, params = E.build_store_query([ID1], [_vec()], model="hashing", stamped_at=NOW)
        assert params[0] == "hashing"
        assert params[1] == NOW
        assert params[2] == ID1
        assert str(params[3]).startswith("[0.100000,0.000000,0")

    def test_short_answer_with_texts_is_refused(self):
        with pytest.raises(E.EmbeddingRefusal):
            E.build_store_query([ID1], [_vec()], model="m", stamped_at=NOW,
                                texts=["a", "b"])


class TestEmbedReport:
    def test_refused_rows_is_scanned_minus_stored(self):
        assert E.EmbedReport(model="m", dim=E.DIM, scanned=5, stored=3).refused_rows == 2

    def test_describe_names_the_numbers(self):
        line = E._describe(E.EmbedReport(model="m", dim=E.DIM, scanned=5, stored=3,
                                         pending_left=2))
        assert "stored 3 of 5" in line
        assert "embed_model='m'" in line
        assert "2 not stored" in line
        assert "2 row(s) still pending" in line


class TestEmbedPending:
    async def test_one_batch_counts(self):
        db = FakeDB(ROWS, written_per_write=2)
        report = await E.embed_pending(db, FakeAdapter(2), batch_size=32, now=NOW)
        assert (report.scanned, report.stored, report.batches) == (2, 2, 1)
        assert len(db.writes) == 1

    async def test_poisoned_batch_is_refused_and_not_written(self):
        db = FakeDB(ROWS)
        report = await E.embed_pending(db, FakeAdapter(1), batch_size=32, now=NOW)
        assert len(report.failures) == 1
        assert report.stored == 0
        assert db.writes == []

    async def test_limit_caps_the_rows_scanned(self):
        db = FakeDB(ROWS, written_per_write=1)
        report = await E.embed_pending(db, FakeAdapter(1), batch_size=32, limit=1, now=NOW)
        assert report.scanned == 1

    async def test_empty_pending_does_nothing(self):
        db = FakeDB([])
        report = await E.embed_pending(db, FakeAdapter(0), batch_size=32, now=NOW)
        assert (report.scanned, report.stored, report.batches) == (0, 0, 0)

    async def test_batch_size_must_be_positive(self):
        with pytest.raises(ValueError):
            await E.embed_pending(FakeDB(ROWS), FakeAdapter(1), batch_size=0, now=NOW)
