"""D755/D813 — the Chinese query asks only for regconfigs that exist everywhere.

`_tsconfig` maps the caller-typed `ts_config="cjk_zh"` onto a regconfig the database
holds, so EVERY Chinese query can execute. D755 mapped it to `jiebacfg`, a CJK bigram
configuration that exists nowhere this project reaches: not in V1–V10, not in CI, not
on this dev database (measured with `pg_ts_config`), and a reference to a missing
regconfig is a hard SQL error (`text search configuration "jiebacfg" does not exist`)
on every CJK request — D809's live-DB failures were exactly that, not a match defect.

The containment lane (`tokens.cjk_keywords`, D407) does the Chinese matching —
`strpos` over bigrams, strongest arm capping similarity — so the CJK query needs no
special regconfig at all: `cjk_zh` resolves to `simple`, loses nothing it ever answered,
and cannot 500 the request.
"""

from __future__ import annotations

import nexus_ai.search.sql as M


def test_the_cjk_name_maps_to_a_regconfig_that_exists_everywhere():
    assert M._tsconfig("cjk_zh") == "simple"
    assert M._tsconfig("cjk_zh") in M._TS_CONFIG_MAP.values()


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
        assert cfg in ("simple", "english")


def test_the_chunk_side_uses_the_same_everywhere_config():
    # `_tsconfig_to_cfg` feeds `plainto_tsquery` in `build_chunk_query`; it must hold
    # the same availability line as the merchant/offering builders.
    assert M._tsconfig_to_cfg("cjk_zh") == "simple"
    assert M._tsconfig_to_cfg("simple") == "simple"
    assert M._tsconfig_to_cfg("english") == "english"
    assert M._tsconfig_to_cfg("nonsense-name") == "simple"
