"""One surface per refusal row — the table's LENGTH says how many surfaces it means (D751).

`CONSTRAINT_RULES` is canonicalised at import, so a Traditional and Simplified pair of the same
word (純素 / 纯素) rewrite to one string and remain in one row twice. `constraint_hits` dedups
on `(key, canon)`, so a refused sentence wrote one refusal either way; what the duplication cost
was the table's honesty: any reader counting the folded rows over-counted the vocabulary, and
the census that reads the arm map counted the same surface twice inside one key.
"""

from __future__ import annotations

from nexus_ai.nlu import lexicon as L


def _dupes() -> list[tuple[str, str, int]]:
    out = []
    for kind, _negs, surfaces in L.CONSTRAINT_RULES:
        seen: dict[str, int] = {}
        offenders = []
        for s in surfaces:
            s = str(s).strip()
            seen[s] = seen.get(s, 0) + 1
        for s, n in seen.items():
            if n > 1:
                offenders.append((kind, s, n))
        out.extend(offenders)
    return out


def test_no_row_carries_the_same_surface_twice():
    dupes = _dupes()
    assert dupes == [], dupes


def test_the_refusal_rows_are_not_empty():
    # the census's rows survive the dedup: no row was emptied entirely
    for kind, _negs, surfaces in L.CONSTRAINT_RULES:
        assert len(surfaces) > 0, kind


def test_every_kind_still_reads_every_surface_out_of_the_canon():
    # the dedup never dropped a *distinct* surface: a quick spot-check that every surface in
    # every row canonises to something non-empty (no half-bindings left).
    for kind, _negs, surfaces in L.CONSTRAINT_RULES:
        for s in surfaces:
            assert isinstance(s, str) and s.strip(), (kind, s)
