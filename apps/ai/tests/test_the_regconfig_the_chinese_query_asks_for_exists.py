"""D755 - the request's reader-facing ts_config picks the regconfig the database holds.

`_tsconfig` maps the caller-typed `ts_config="cjk_zh"` onto `jiebacfg`, the CJK bigram
configuration the RAG lane already uses, so a CJK sentence is SEGMENTED instead of matching
one opaque token; and `build_merchant_query`/`build_offering_query` interpolate
`plainto_tsquery('jiebacfg'::regconfig, ...)` when the caller named `cjk_zh`. A silently
broken mapping (a typo'd `jiebacfg`, a dropped `cjk_zh`) returns `simple` and every Chinese
query answers nothing - the exact failure D755 was written to end.
"""

from __future__ import annotations

import nexus_ai.search.sql as M


def test_the_cjk_name_maps_to_jiebacfg():
    assert M._tsconfig("cjk_zh") == "jiebacfg"


def test_the_built_in_configs_stay_built_in():
    assert M._tsconfig("simple") == "simple"
    assert M._tsconfig("english") == "english"


def test_an_unknown_name_degrades_to_simple():
    assert M._tsconfig("nonsense-name") == "simple"


def test_the_mapped_config_is_quote_inlineable():
    # anything that could leak into SQL syntax must not be inlineable at all
    for name in ("cjk_zh", "simple", "english", "'; drop table merchants; --",
                 "simple' --", "simple\"; drop table merchants; --"):
        cfg = M._tsconfig(name)
        assert cfg in M._TS_CONFIG_MAP.values()
