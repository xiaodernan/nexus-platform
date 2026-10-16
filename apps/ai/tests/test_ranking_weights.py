"""§67 / AGENT_CONTRACT §6 — the organic ranking weights are a guarded contract.

`load_ranking_weights` is the only way the search service gets its scoring mix. Three
invariants are enforced at load time, and they are security/correctness properties, not
cosmetic ones:
- paid rank may never leak into the organic weights (§67 — a `bid`/`paid_rank`/… key is
  rejected outright);
- every one of the 8 weight keys must be present;
- the weights must sum to exactly 1.0.

This pins those so a bad deploy config cannot silently skew or corrupt ranking. The
function reads a file, so each case writes a temp YAML. DB-free, no provider.
"""

from __future__ import annotations

import textwrap

import pytest
from nexus_ai.search.ranking import RankingConfigError, load_ranking_weights

_VALID = textwrap.dedent("""
    version: hybrid_v1
    weights:
      relevance: 0.30
      quality: 0.20
      distance: 0.10
      price_fit: 0.10
      availability: 0.10
      personalization: 0.10
      popularity: 0.05
      freshness: 0.05
""")

WEIGHT_KEYS = ("relevance", "quality", "distance", "price_fit", "availability",
               "personalization", "popularity", "freshness")


def _write(tmp_path, body: str):
    p = tmp_path / "rw.yaml"
    p.write_text(body, encoding="utf-8")
    return p


def test_valid_config_loads_all_keys(tmp_path):
    w = load_ranking_weights(_write(tmp_path, _VALID))
    assert w.version == "hybrid_v1"
    for k in WEIGHT_KEYS:
        assert k in w.weights
    assert abs(sum(w.weights.values()) - 1.0) < 1e-9


def test_forbidden_paid_rank_key_is_rejected(tmp_path):
    # §67: a paid-rank signal must not influence organic score
    body = _VALID + "  paid_rank: 0.10\n"
    with pytest.raises(RankingConfigError):
        load_ranking_weights(_write(tmp_path, body))


def test_any_forbidden_organic_key_is_rejected(tmp_path):
    for bad in ("bid", "spend", "plan", "mrr", "arr", "ads"):
        body = _VALID + f"  {bad}: 0.10\n"
        with pytest.raises(RankingConfigError):
            load_ranking_weights(_write(tmp_path, body))


def test_missing_weight_key_is_rejected(tmp_path):
    drop_freshness = "\n".join(
        ln for ln in _VALID.splitlines() if "freshness" not in ln) + "\n"
    with pytest.raises(RankingConfigError, match="missing"):
        load_ranking_weights(_write(tmp_path, drop_freshness))


def test_weights_not_summing_to_one_is_rejected(tmp_path):
    # keep all keys but shave 0.01 off freshness -> 0.99
    bad = _VALID.replace("freshness: 0.05", "freshness: 0.04")
    with pytest.raises(RankingConfigError, match="sum to 1.0"):
        load_ranking_weights(_write(tmp_path, bad))


def test_missing_file_is_rejected(tmp_path):
    with pytest.raises(RankingConfigError, match="not found"):
        load_ranking_weights(tmp_path / "absent.yaml")
