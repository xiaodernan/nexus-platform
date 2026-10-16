"""§67 / §66 / §1846 — sponsored placement is a *capped post-hoc insertion*, never a
score input.

`ranking.py` is pure Python over the `Candidate` feature vector, so these invariants are
unit-testable without a database:

- `score_candidate` is organic-only: the `sponsored` flag is not an input to the score, so
  a paid placement can never earn a higher organic score than an identical organic one
  (§67 — paid rank may not influence organic score).
- `apply_sponsored` inserts promoted cards *after* organic scoring, capped
  `max_in_top` within the first `cap_in_top` slots, never at rank 0, and never displaces
  the organic best match; a promoted card keeps its own organic score (no boost).
- `sponsor_label` is a deterministic label lookup with a safe fallback.

DB-free, no provider.
"""

from __future__ import annotations

from nexus_ai.search.ranking import (
    Candidate,
    RankingWeights,
    Scored,
    SponsoredConfig,
    WEIGHT_KEYS,
    apply_sponsored,
    score_candidate,
    sponsor_label,
)


def _weights() -> RankingWeights:
    return RankingWeights(weights={k: 1.0 / len(WEIGHT_KEYS) for k in WEIGHT_KEYS})


def _mk(subject_id: str, *, sponsored: bool = False, organic_score: float = 0.0,
        relevance: float = 0.5) -> Scored:
    c = Candidate(subject_type="merchant", subject_id=subject_id, merchant_id="m1",
                  relevance=relevance, sponsored=sponsored)
    # in the real pipeline organic_rank() sets score == organic_score; mirror that here
    return Scored(candidate=c, score=organic_score, organic_score=organic_score,
                  breakdown={}, contributions=[])


# ----------------------------------------------------------------- organic-only score
def test_score_candidate_ignores_sponsored_flag():
    # §67: identical features, only the sponsored flag differs -> identical organic score.
    base = Candidate(subject_type="merchant", subject_id="s1", merchant_id="m1",
                     relevance=0.8, rating=4.6, rating_count=200, distance_m=500.0,
                     price=180.0, budget_max=300.0, popularity=0.7, freshness=0.9,
                     personalization=0.6)
    paid = Candidate(subject_type="merchant", subject_id="s2", merchant_id="m1",
                     relevance=0.8, rating=4.6, rating_count=200, distance_m=500.0,
                     price=180.0, budget_max=300.0, popularity=0.7, freshness=0.9,
                     personalization=0.6, sponsored=True)
    w = _weights()
    organic_paid, _ = score_candidate(paid, w)
    organic_free, _ = score_candidate(base, w)
    assert organic_paid == organic_free


# ------------------------------------------------------------- apply_sponsored invariants
def test_organic_best_never_displaced_from_rank_zero():
    # ranked sorted with the organic best first; a promoted card follows it.
    ranked = [
        _mk("o0", organic_score=0.95),   # organic best
        _mk("p0", sponsored=True, organic_score=0.99),  # even higher score...
        _mk("o1", organic_score=0.90),
        _mk("o2", organic_score=0.80),
    ]
    out = apply_sponsored(ranked, RankingWeights())
    assert out[0].candidate.key() == "merchant:o0"  # ...but never takes rank 0


def test_no_promoted_card_at_rank_zero():
    ranked = [_mk(f"o{i}", organic_score=1.0 - i * 0.1) for i in range(6)]
    ranked.append(_mk("p0", sponsored=True, organic_score=0.0))
    ranked.append(_mk("p1", sponsored=True, organic_score=0.0))
    out = apply_sponsored(ranked, RankingWeights())
    assert not out[0].candidate.sponsored


def test_promoted_capped_within_top():
    # 10 organic + 3 promoted, default cap_in_top=5 / max_in_top=1
    w = RankingWeights()
    ranked = [_mk(f"o{i}", organic_score=1.0 - i * 0.01) for i in range(10)]
    ranked += [_mk(f"p{i}", sponsored=True, organic_score=0.5) for i in range(3)]
    out = apply_sponsored(ranked, w)
    in_top = [s for s in out[: w.sponsored.cap_in_top] if s.candidate.sponsored]
    assert len(in_top) <= w.sponsored.max_in_top  # at most 1 promoted in the top 5


def test_surplus_promoted_pushed_to_tail_not_dropped():
    w = RankingWeights()
    ranked = [_mk(f"o{i}", organic_score=1.0 - i * 0.01) for i in range(10)]
    ranked += [_mk(f"p{i}", sponsored=True, organic_score=0.5) for i in range(3)]
    out = apply_sponsored(ranked, w)
    promoted_in = {s.candidate.key() for s in ranked if s.candidate.sponsored}
    promoted_out = {s.candidate.key() for s in out if s.candidate.sponsored}
    assert promoted_out == promoted_in  # none lost
    # exactly one promoted sits in the top window; the other two are at the tail
    tail = out[w.sponsored.cap_in_top:]
    tail_promoted = [s for s in tail if s.candidate.sponsored]
    assert len(tail_promoted) == 2


def test_no_promo_returns_input_order():
    ranked = [_mk(f"o{i}", organic_score=0.9 - i * 0.1) for i in range(4)]
    out = apply_sponsored(ranked, RankingWeights())
    assert [s.candidate.key() for s in out] == [s.candidate.key() for s in ranked]


def test_no_organic_returns_input():
    ranked = [_mk(f"p{i}", sponsored=True, organic_score=0.5) for i in range(3)]
    out = apply_sponsored(ranked, RankingWeights())
    assert [s.candidate.key() for s in out] == [s.candidate.key() for s in ranked]


def test_promoted_score_not_boosted():
    # apply_sponsored only reorders; it must never change a card's score.
    ranked = [_mk(f"o{i}", organic_score=0.9 - i * 0.1) for i in range(5)]
    ranked.append(_mk("p0", sponsored=True, organic_score=0.42))
    out = apply_sponsored(ranked, RankingWeights())
    for s in out:
        assert s.score == s.organic_score


def test_organic_rank_preserved_on_cards():
    ranked = [_mk("o0", organic_score=0.95), _mk("o1", organic_score=0.90)]
    ranked.append(_mk("p0", sponsored=True, organic_score=0.50))
    out = apply_sponsored(ranked, RankingWeights())
    by_key = {s.candidate.key(): s for s in out}
    assert by_key["merchant:o0"].candidate.raw["organic_rank"] == 1
    assert by_key["merchant:o1"].candidate.raw["organic_rank"] == 2
    # a promoted card was never part of the organic list, so it has no organic_rank
    assert by_key["merchant:p0"].candidate.raw["organic_rank"] is None


def test_sponsored_ids_path_promotes_by_key():
    # promotion can also come from the sponsored_ids set, not just the flag.
    ranked = [_mk("o0", organic_score=0.95), _mk("o1", organic_score=0.90)]
    ranked.append(_mk("x0", organic_score=0.50))  # not flagged, but in the id set
    out = apply_sponsored(ranked, RankingWeights(), sponsored_ids={"merchant:x0"})
    promoted = [s for s in out if s.candidate.sponsored
                or s.candidate.key() in {"merchant:x0"}]
    assert len(promoted) == 1
    assert out[0].candidate.key() == "merchant:o0"  # organic best still first


def test_custom_cap_config_enforced():
    # cap_in_top=5 leaves room for both max_in_top=2 promoted slots to interleave in.
    w = RankingWeights(sponsored=SponsoredConfig(cap_in_top=5, max_in_top=2))
    ranked = [_mk(f"o{i}", organic_score=1.0 - i * 0.01) for i in range(8)]
    ranked += [_mk(f"p{i}", sponsored=True, organic_score=0.5) for i in range(4)]
    out = apply_sponsored(ranked, w)
    in_top = [s for s in out[: w.sponsored.cap_in_top] if s.candidate.sponsored]
    assert len(in_top) == w.sponsored.max_in_top  # exactly 2 in the top 5
    tail_promoted = [s for s in out[w.sponsored.cap_in_top:] if s.candidate.sponsored]
    assert len(tail_promoted) == 2  # remaining 2 pushed to tail


def test_sponsor_label_lookup_and_fallback():
    w = RankingWeights()
    assert sponsor_label("zh-HK", w) == "廣告"
    # unknown locale falls back to zh-HK (the always-present default)
    assert sponsor_label("en-US", w) == "廣告"
    assert sponsor_label("fr-FR", w) == "廣告"
    custom = RankingWeights(sponsored=SponsoredConfig(label={"zh-HK": "贊助", "en-US": "Ad"}))
    assert sponsor_label("en-US", custom) == "Ad"
    # no fr entry -> falls back to zh-HK
    assert sponsor_label("fr-FR", custom) == "贊助"
    # literal "Sponsored" only when zh-HK itself is absent
    no_zh = RankingWeights(sponsored=SponsoredConfig(label={"en-US": "Ad"}))
    assert sponsor_label("fr-FR", no_zh) == "Sponsored"
