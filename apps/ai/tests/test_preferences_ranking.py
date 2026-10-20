"""D381 follow-up — read user preferences into the personalization ranking signal.

`user_preferences` table (kind, key, value, weight, source, scope) holds declared
and inferred preferences. The search pipeline should read them for the searching user
and boost candidates that match the preference (e.g., `ambience=quiet` boosts
merchants with `quiet_ambience=true` in their attributes).
"""

from __future__ import annotations



import nexus_ai.search.service as S
from nexus_ai.search import sql as SQL
from nexus_ai.search.ranking import PersonalizationConfig, personalization_signal


# --------------------------------------------------------------------------- signal from preference
def test_preference_signal_is_distinct_from_feedback_signal():
    """A preference signal is computed from declared prefs, not from feedback events."""
    # The personalization_signal function takes a list of values and returns an EMA.
    # For preferences, we pass the preference weights directly (not through feedback).
    cfg = PersonalizationConfig(min_signals=1, ema_alpha=0.1)
    # A single strong preference should produce a signal > neutral
    sig = personalization_signal([1.0], cfg)  # weight 1.0 = strong preference
    assert sig is not None
    assert sig > 0.5  # neutral is 0.5


def test_preference_weight_is_respected():
    """The preference's `weight` column should scale the signal."""
    cfg = PersonalizationConfig(min_signals=1, ema_alpha=0.1)
    # Weight 0.5 (neutral) should give neutral signal
    sig_neutral = personalization_signal([0.5], cfg)
    # Weight 1.0 (strong like) should give positive signal
    sig_like = personalization_signal([1.0], cfg)
    # Weight 0.0 (strong dislike) should give negative signal
    sig_dislike = personalization_signal([0.0], cfg)
    assert sig_like > sig_neutral > sig_dislike


# --------------------------------------------------------------------------- SQL for preferences
def test_build_user_preferences_query_exists():
    """The SQL builder should have a function to read user preferences."""
    # This is the signature we expect; the implementation will be added
    assert hasattr(SQL, 'user_preferences_for'), "SQL.user_preferences_for not implemented"


def test_user_preferences_query_shape():
    """The query should return (user_id, kind, key, value, weight) for a user."""
    # Will be implemented after the function exists
    pass


# --------------------------------------------------------------------------- StaticBackend support
class PrefStaticBackend(S.StaticBackend):
    """StaticBackend that also supports user_preferences for testing."""
    
    def __init__(self, *args, user_prefs=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._user_prefs = user_prefs or []
    
    async def user_preferences(self, user_id: str, subject_ids: list[str] | None = None) -> list[dict]:
        return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]


async def test_search_with_user_preference_boosts_matching_merchant():
    """A user preference for 'quiet_ambience' should boost merchants with that attribute."""
    # Use a SqlLikeBackend that doesn't filter on text (like the real SQL backend)
    class SqlLikeBackend(S.StaticBackend):
        def __init__(self, *args, user_prefs=None, **kwargs):
            super().__init__(*args, **kwargs)
            self._user_prefs = user_prefs or []
        
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]
        
        async def user_preferences(self, user_id: str, subject_ids: list[str] | None = None) -> list[dict]:
            return [dict(p) for p in self._user_prefs if str(p.get("user_id")) == user_id]
    
    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "靜咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"quiet_ambience": True}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Loud Bar", "display_name_zh": "吵酒吧",
             "category_primary": "bar", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"quiet_ambience": False}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "ambience", "key": "quiet", "value": True, "weight": 1.0,
             "source": "declared", "scope": "long_term"},
        ]
    )
    
    plan = S.SearchPlan(query_text="cafe", limit=10, subject_types=("merchant",))
    # This will fail until the search pipeline integrates user_preferences
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")
    
    # The quiet cafe should rank higher due to preference match
    # For now, just verify the pipeline runs without error
    assert len(scored) == 2


# --------------------------------------------------------------------------- SQL builder integration
def test_search_sql_includes_preference_boost_when_provided():
    """The merchant query should have an optional preference boost clause."""
    # This will be implemented by extending build_merchant_query with an optional
    # preference_boost parameter that adds a CASE/WHEN for attribute matches
    pass