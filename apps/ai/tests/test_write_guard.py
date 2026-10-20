"""Structural guard: the HTTP layer's write surface is provably narrow.

D19/D20 + API_CONTRACT §0 fix what the AI service may write. Rather than trust review,
this test scans every route module for `INSERT INTO <table>` and asserts the set is a
subset of the AI-owned observability tables — and that no commerce/dialogue table
(conversations, messages, handoffs, carts, orders) is ever written from here. It also
confirms the `events` INSERT omits `RETURNING` (D19: insert-but-no-select).
"""

from __future__ import annotations

import re
from pathlib import Path

from nexus_ai.api.runs import AI_WRITE_ALLOWED_TABLES

API_DIR = Path(__file__).resolve().parent.parent / "nexus_ai" / "api"

INSERT_RE = re.compile(r"INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)", re.IGNORECASE)

#: tables the platform door owns — the AI HTTP layer must never write these (D20)
FORBIDDEN_TABLES = {"conversations", "messages", "handoffs", "carts", "orders",
                    "order_items", "cart_items", "reservations", "payments",
                    "users", "merchants", "offerings", "facts", "reviews"}


def _api_sources():
    return sorted(API_DIR.glob("*.py"))


def test_all_insert_targets_are_ai_owned_tables():
    offenders: list[tuple[str, str]] = []
    for path in _api_sources():
        for table in INSERT_RE.findall(path.read_text(encoding="utf-8")):
            if table not in AI_WRITE_ALLOWED_TABLES:
                offenders.append((path.name, table))
    assert not offenders, f"HTTP layer writes a non-AI-owned table: {offenders}"


def test_no_forbidden_commerce_or_dialogue_writes():
    for path in _api_sources():
        for table in INSERT_RE.findall(path.read_text(encoding="utf-8")):
            assert table not in FORBIDDEN_TABLES, f"{path.name} INSERTs {table}"


def test_events_insert_never_uses_returning():
    src = (API_DIR / "runs.py").read_text(encoding="utf-8")
    events_sql = src.split("INSERT INTO events", 1)
    assert len(events_sql) == 2, "events insert should live in runs.py"
    stmt = events_sql[1].split('"""', 1)[0]
    assert "RETURNING" not in stmt.upper()  # D19: INSERT-only grant, no returning


def test_sql_is_parameterised_no_string_interpolation():
    # every INSERT in the HTTP layer uses $n placeholders, not f-string value splicing
    for path in _api_sources():
        text = path.read_text(encoding="utf-8")
        for stmt in re.findall(r"INSERT INTO.*?\"\"\"", text, re.DOTALL | re.IGNORECASE):
            assert "$1" in stmt, f"{path.name}: unparameterised INSERT"
