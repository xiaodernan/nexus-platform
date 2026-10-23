"""Embed + store — the pipeline stage `docs/RAG.md` §2 names `embed.py`.

The schema has carried `chunks.embedding vector(1024)`, `embed_model` and `embedded_at`
since V1, the seed has stamped every chunk it writes `embed_model = 'pending'`, and
`nexus_ai/search/sql.py` has a vector branch in its hybrid read — but nothing between them
ever ran. Measured on the live demo corpus before this module existed: 2118 chunks, 0 of
them with a vector, so the vector lane scored nothing and the seed's own quality gate
asserted that state as a precondition. This is the missing stage.

The rules, in the order they matter:

* **a row the provider cannot answer stays pending.** A batch whose answer is short, whose
  vector has the wrong length, or whose vector is all zeros is refused and NOT written:
  cosine reads `chunks.embedding`, so a zero vector is a row that is labelled embedded and
  can never be retrieved. Refusing leaves `embed_model = 'pending'` telling the truth.
* **the stamp is the adapter's own identity.** `embed_model` carries the model tag the
  adapter reports, so a corpus written by the dev-only lexical hasher says `'hashing'`
  rather than borrowing a semantic model's name.
* **one instant per run.** `embedded_at` is the pass's run stamp, bound once and written
  into every row this run fills, so "which pass produced these vectors" is one readable
  value instead of a per-row clock.
* **the write guards `embedding IS NULL`.** A row that another process stamped between the
  read and the update is not overwritten, and re-running the pass over an embedded corpus
  stores nothing.
* **the cursor moves even when a batch is refused.** Keyset pagination on `id` is what lets
  one poisoned batch fail without spinning the loop forever.

Ingest stays off the request path (§12, RAG §5): this is a worker entry point —
`python -m nexus_ai.rag.embed`, wired as `make ai-embed` — not an endpoint.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional, Sequence

from nexus_ai.models.embeddings import DIM
from nexus_ai.search.sql import Params, vector_literal

log = logging.getLogger("nexus_ai.rag.embed")

BATCH_SIZE = 32
NIL_UUID = "00000000-0000-0000-0000-000000000000"

# Every value reaches the server as a bound parameter, and the uuid parameters are cast to
# uuid rather than the column being cast to text (D506: the second spelling costs an index).
SELECT_PENDING = """\
SELECT id, text
  FROM chunks
 WHERE embedding IS NULL
   AND id > $1::uuid
   AND ($2::uuid IS NULL OR tenant_id = $2::uuid)
 ORDER BY id
 LIMIT $3"""

COUNT_PENDING = """\
SELECT count(*) AS n
  FROM chunks
 WHERE embedding IS NULL
   AND ($1::uuid IS NULL OR tenant_id = $1::uuid)"""


class EmbeddingRefusal(RuntimeError):
    """The provider's answer cannot be stored, so the rows it was meant for stay pending."""


@dataclass
class EmbedReport:
    """What one pass did, in the numbers a reader needs to decide whether to trust it."""

    model: str
    dim: int
    scanned: int = 0
    stored: int = 0
    batches: int = 0
    pending_left: int = 0
    run_stamped_at: Optional[datetime] = None
    failures: list[str] = field(default_factory=list)

    @property
    def refused_rows(self) -> int:
        return self.scanned - self.stored


def model_tag(adapter: Any) -> str:
    """The model that produced the vectors, from the adapter itself — never a typed guess."""
    return str(getattr(adapter, "model", "") or getattr(adapter, "name", "") or "")


def _validate_vector(vector: Sequence[float], *, position: int, dim: int) -> list[float]:
    if len(vector) != dim:
        raise EmbeddingRefusal(
            f"row {position}: provider returned dim {len(vector)}, the contract fixes "
            f"{dim} (DECISIONS D3) — refusing to store a vector the column cannot hold")
    values = [float(v) for v in vector]
    if not any(values):
        raise EmbeddingRefusal(
            f"row {position}: provider returned an all-zero vector — cosine cannot rank it, "
            "so storing it would label the row embedded while it is unretrievable")
    return values


def _validate_answer(texts: Sequence[str], vectors: Sequence[Sequence[float]]) -> list[list[float]]:
    if len(vectors) != len(texts):
        raise EmbeddingRefusal(
            f"provider answered {len(vectors)} vector(s) for {len(texts)} text(s) — a short "
            "answer would leave rows written as pending out of the batch")
    dim = len(vectors[0]) if vectors else DIM
    if dim != DIM:
        raise EmbeddingRefusal(
            f"provider returned dim {dim}, the contract fixes {DIM} (DECISIONS D3)")
    return [_validate_vector(v, position=i, dim=DIM) for i, v in enumerate(vectors)]


def build_store_query(ids: Sequence[Any], vectors: Sequence[Sequence[float]], *,
                      model: str, stamped_at: datetime, texts: Optional[Sequence[str]] = None
                      ) -> tuple[str, list[Any]]:
    """One set-based UPDATE per batch: VALUES rows joined to the guarded target rows.

    Passing `texts` re-runs the answer's shape against the input it claims to answer, so a
    provider that returned the wrong number of rows cannot reach the write at all.
    """
    if texts is not None:
        vectors = _validate_answer(texts, vectors)
    else:
        vectors = [_validate_vector(v, position=i, dim=DIM) for i, v in enumerate(vectors)]
    p = Params()
    model_ph = p.add(model)
    stamp_ph = p.add(stamped_at)
    rows = []
    for cid, vec in zip(ids, vectors):
        rows.append(f"({p.add(str(cid))}::uuid, {p.add(vector_literal(vec))}::vector)")
    sql = f"""
UPDATE chunks AS c
   SET embedding = s.embedding,
       embed_model = {model_ph},
       embedded_at = {stamp_ph}::timestamptz
  FROM (VALUES {", ".join(rows)}) AS s(id, embedding)
 WHERE c.id = s.id
   AND c.embedding IS NULL
RETURNING c.id"""
    return sql, p.values


async def pending_count(database: Any, tenant_id: Optional[str] = None) -> int:
    row = await database.fetch(COUNT_PENDING, tenant_id)
    return int(row[0]["n"]) if row else 0


async def embed_pending(database: Any, adapter: Any, *, tenant_id: Optional[str] = None,
                        batch_size: int = BATCH_SIZE, limit: Optional[int] = None,
                        now: Optional[datetime] = None) -> EmbedReport:
    """Fill `chunks.embedding` for the rows that have none, in batches, and refuse what is bad.

    `batch_size` is the provider's per-call input size and the write's row count; `limit`
    caps the rows this run looks at, which is what makes a canary run possible.
    """
    if batch_size < 1:
        raise ValueError(f"batch_size must be at least 1, got {batch_size}")
    stamped_at = now or datetime.now(timezone.utc)
    tag = model_tag(adapter)
    report = EmbedReport(model=tag, dim=DIM, run_stamped_at=stamped_at)
    cursor = NIL_UUID
    remaining: Optional[int] = limit

    while True:
        want = batch_size if remaining is None else min(batch_size, remaining)
        if want < 1:
            break
        rows = await database.fetch(SELECT_PENDING, cursor, tenant_id, want)
        if not rows:
            break
        report.batches += 1
        report.scanned += len(rows)
        ids = [r["id"] for r in rows]
        cursor = str(ids[-1])  # the server's own `ORDER BY id` decides the last row
        texts = [str(r["text"] or "") for r in rows]
        first_id = str(ids[0])
        try:
            answer = await adapter.embed(texts)
            sql, params = build_store_query(ids, answer, model=tag, stamped_at=stamped_at,
                                            texts=texts)
        except Exception as exc:  # the row stays pending; a poisoned batch cannot end the pass
            report.failures.append(f"batch starting at {first_id}: {exc}")
            log.warning("refused embedding batch at %s: %s", first_id, exc)
        else:
            written = await database.write(sql, *params)
            report.stored += len(written)
        if remaining is not None:
            remaining -= len(rows)
        if len(rows) < want:
            break

    report.pending_left = await pending_count(database, tenant_id)
    return report


async def run(settings: Any = None, *, tenant_id: Optional[str] = None,
              batch_size: int = BATCH_SIZE, limit: Optional[int] = None) -> EmbedReport:
    """The worker entry point: pool, adapter from the configured provider, one pass."""
    from nexus_ai.config import get_settings
    from nexus_ai.db import pool as db_pool
    from nexus_ai.models.embeddings import get_embedding_adapter

    settings = settings or get_settings()
    database = db_pool.db()
    if database is None:
        database = await db_pool.connect(settings)
    if database is None:
        raise EmbeddingRefusal(
            "no database pool — the store stage has nowhere to write; set NEXUS_DATABASE_URL")
    report = await embed_pending(database, get_embedding_adapter(settings),
                                 tenant_id=tenant_id, batch_size=batch_size, limit=limit)
    log.info("embedded %s/%s chunk(s) as %s, %s still pending", report.stored, report.scanned,
             report.model, report.pending_left)
    return report


def _describe(report: EmbedReport) -> str:
    line = (f"stored {report.stored} of {report.scanned} chunk(s) as embed_model="
            f"'{report.model}' dim={report.dim} over {report.batches} batch(es); "
            f"{report.refused_rows} not stored, {report.pending_left} row(s) still pending")
    if report.failures:
        line += f" — {len(report.failures)} batch(es) REFUSED:"
        line += "".join(f"\n  · {f}" for f in report.failures)
    return line


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="python -m nexus_ai.rag.embed",
        description="Fill chunks.embedding for the chunks that have none (docs/RAG.md §2).")
    ap.add_argument("--tenant", default=None, help="restrict the pass to one tenant id")
    ap.add_argument("--batch", type=int, default=BATCH_SIZE,
                    help=f"rows per provider call and per UPDATE (default {BATCH_SIZE})")
    ap.add_argument("--limit", type=int, default=None,
                    help="stop after this many pending rows (a canary run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what is pending and write nothing")
    args = ap.parse_args(list(argv) if argv is not None else None)

    async def go() -> int:
        from nexus_ai.config import get_settings
        from nexus_ai.db import pool as db_pool

        logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
        settings = get_settings()
        if args.dry_run:
            database = await db_pool.connect(settings)
            if database is None:
                print("no database pool — nothing to report; set NEXUS_DATABASE_URL")
                return 1
            print(f"{await pending_count(database, args.tenant)} chunk(s) await embedding")
            await db_pool.dispose()
            return 0
        report = await run(settings, tenant_id=args.tenant, batch_size=args.batch,
                           limit=args.limit)
        print(_describe(report))
        await db_pool.dispose()
        return 1 if report.failures else 0

    return asyncio.run(go())


if __name__ == "__main__":
    raise SystemExit(main())
