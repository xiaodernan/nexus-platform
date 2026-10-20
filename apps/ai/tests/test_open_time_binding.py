"""D399 - a clock time is a `datetime.time`, not a string that looks like one.

The product's own e2e sentence carries a clock time:

    帮我找沙田适合情侣约会的餐厅，预算500港币，安静一点，周六晚上

That produced an open-at-time filter, whose value was bound to a `time` COLUMN as the string
"18:00:00". asyncpg encodes a `time` parameter from a `datetime.time`, so the bind raised
`invalid input for query argument $7: '18:00:00' ('str' object has no attribute 'hour')`
BEFORE the query ran - a 500 on the product's headline sentence, and one that no offline
test could see, because the offline path never reaches a driver.
"""

from __future__ import annotations

from datetime import time

import pytest

import nexus_ai.search.service as S
from nexus_ai.contract import Intent
from nexus_ai.nlu.understand import extract_intent, extract_intent_dict

# The product's own e2e sentence (tests/e2e/specs/consumer/vertical-slice.spec.ts).
E2E_SENTENCE = ("\u5e2b\u6211\u627e\u6c99\u7530\u9002\u5408\u60c5\u4fa3\u7ea6\u4f1a\u7684\u9910\u5385\uff0c"
                 "\u9884\u7b97500\u6e2f\u5e63\uff0c\u5b89\u9759\u4e00\u70b9\uff0c\u5468\u516d\u665a\u4e0a")


# --------------------------------------------------------------------------- the plan
def test_the_clock_time_is_carried_as_a_time():
    plan = S.plan_from_intent(
        Intent(raw_query="x", intent="discover_merchant", category="restaurant"),
        query="x",
    )
    assert "open_time" not in plan.filters  # no clock time -> no filter


def test_a_clock_time_in_the_intent_becomes_a_time_in_the_plan():
    # The rule engine returns its own shape; the contract Intent is what the plan reads.
    from nexus_ai.api.pipeline import validate_intent

    ex = validate_intent(extract_intent_dict(E2E_SENTENCE, {"locale": "zh-HK"}))
    assert ex is not None
    plan = S.plan_from_intent(ex, query=E2E_SENTENCE, limit=8)
    assert plan.filters.get("open_weekday") is not None
    open_time = plan.filters.get("open_time")
    assert isinstance(open_time, time), \
        f"the open-at-time filter must carry a time, not {type(open_time).__name__}"


def test_a_clock_time_in_a_hand_built_intent_is_also_a_time():
    from datetime import datetime, timezone

    from nexus_ai.contract import IntentTime

    ex = Intent(raw_query="x", intent="discover_merchant", category="restaurant",
                time=IntentTime(type="explicit",
                                starts_at=datetime(2026, 10, 24, 18, 0, tzinfo=timezone.utc),
                                ends_at=datetime(2026, 10, 24, 22, 0, tzinfo=timezone.utc)))
    plan = S.plan_from_intent(ex, query="x", limit=8)
    assert isinstance(plan.filters.get("open_time"), time)


# --------------------------------------------------------------------------- the SQL
def test_the_query_binds_the_time_rather_than_a_string():
    from nexus_ai.search import sql as SQL

    plan = S.plan_from_intent(
        Intent(raw_query="x", intent="discover_merchant", category="restaurant"),
        query="x",
    )
    # A plan carrying a clock time.
    plan.filters = dict(plan.filters)
    plan.filters["open_weekday"] = 5
    plan.filters["open_time"] = time(18, 0)

    q = SQL.build_merchant_query(tenant_id="t", text="cafe", embedding=None,
                                 filters=plan.filters)
    assert any(isinstance(v, time) for v in q.params), \
        "the open-at-time parameter must be a time, not a string"
    assert not any(isinstance(v, str) and v.count(":") == 2 and v[2] == ":"
                   for v in q.params), "a clock time must not be bound as a string"


def test_the_query_still_carries_the_open_at_time_clause():
    from nexus_ai.search import sql as SQL

    q = SQL.build_merchant_query(
        tenant_id="t", text="cafe", embedding=None,
        filters={"open_weekday": 5, "open_time": time(18, 0)},
    )
    assert "bh.opens_at" in q.sql
    assert "bh.weekday" in q.sql
