"""§99/§100 — the personalization signal is an EMA over feedback, never ground
truth alone, and it stays neutral (None) until enough signals accumulate.

`personalization_signal` is pure logic (no DB), so this pins its contract: below
`min_signals` it returns None (the ranking falls back to `PersonalizationConfig.neutral`),
and once it has enough samples it returns a clamped EMA.
"""

from __future__ import annotations

from nexus_ai.search.ranking import PersonalizationConfig, personalization_signal


def test_below_min_signals_is_neutral_none():
    cfg = PersonalizationConfig(min_signals=3)
    assert personalization_signal([4.0, 5.0], cfg) is None  # 2 < 3
    assert personalization_signal([], cfg) is None


def test_at_min_signals_returns_a_value():
    cfg = PersonalizationConfig(min_signals=3)
    out = personalization_signal([4.0, 5.0, 3.0], cfg)
    assert out is not None
    assert 0.0 <= out <= 1.0


def test_signal_is_clamped_to_unit_interval():
    cfg = PersonalizationConfig(min_signals=1)
    # an out-of-range rating must not leak past [0, 1]
    assert 0.0 <= personalization_signal([9.0], cfg) <= 1.0
    assert 0.0 <= personalization_signal([-4.0], cfg) <= 1.0


def test_recent_feedback_shapes_the_signal():
    # alpha is small (0.1), so the earliest rating dominates; a strong opener beats a
    # strong closer. Values stay inside [0, 1] so clamping does not hide the EMA
    # direction — this documents the EMA direction, not just that it runs.
    cfg = PersonalizationConfig(min_signals=3, ema_alpha=0.1)
    early_strong = personalization_signal([0.9, 0.1, 0.1], cfg)
    late_strong = personalization_signal([0.1, 0.1, 0.9], cfg)
    assert early_strong > late_strong


def test_custom_min_signals_is_respected():
    cfg = PersonalizationConfig(min_signals=1)
    assert personalization_signal([3.0], cfg) is not None  # 1 >= 1
    cfg2 = PersonalizationConfig(min_signals=5)
    assert personalization_signal([3.0, 3.0, 3.0, 3.0], cfg2) is None  # 4 < 5
