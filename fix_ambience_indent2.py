with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'r', encoding='utf-8') as f:
    content = f.read()

# The function has wrong indentation - fix it
old = '''async def test_ambience_preference_matches_boolean_attributes():
    """Style/ambience preference should match boolean attributes.\"\"\"
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"quiet_ambience": True, "lively_ambience": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Lively Bar", "display_name_zh": "热闹酒吧",
             "category_primary": "bar", "rating_agg": 4.2, "review_count": 20,
             "attributes": {"quiet_ambience": False, "lively_ambience": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.7, "source": "inferred", "scope": "long_term"},
        ]
    )

    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        name = row.get("display_name_zh", "")
        if name == "静谧咖啡":
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5'''

new = '''async def test_ambience_preference_matches_boolean_attributes():
    """Style/ambience preference should match boolean attributes.\"\"\"
    # Use a SqlLikeBackend that does not filter on text (like the real SQL backend)
    class SqlLikeBackend(S.StaticBackend):
        async def merchant_candidates(self, *, text=None, filters=None, **_kw):
            return [dict(r) for r in self.merchants]

    backend = SqlLikeBackend(
        merchants=[
            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",
             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",
             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,
             "attributes": {"quiet_ambience": True, "lively_ambience": False}},
            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",
             "display_name": "Lively Bar", "display_name_zh": "热闹酒吧",
             "category_primary": "bar", "rating_agg": 4.2, "review_count": 20,
             "attributes": {"quiet_ambience": False, "lively_ambience": True}},
        ],
        user_prefs=[
            {"user_id": "u1", "kind": "style", "key": "ambience",
             "value": json.dumps({"value": "quiet"}),
             "weight": 0.7, "source": "inferred", "scope": "long_term"},
        ]
    )

    plan = S.SearchPlan(query_text="cafe", limit=10)
    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")

    assert len(scored) == 2
    for s in scored:
        row = s.candidate.raw.get("row", {})
        name = row.get("display_name_zh", "")
        if name == "静谧咖啡":
            assert s.candidate.personalization is not None
            assert s.candidate.personalization > 0.5
        else:
            assert s.candidate.personalization is not None
            assert s.candidate.personalization < 0.5'''

if old in content:
    content = content.replace(old, new)
    with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'w', encoding='utf-8') as f:
        f.write(content)
    print('SUCCESS')
else:
    print('NOT FOUND')
    idx = content.index('async def test_ambience_preference_matches_boolean_attributes')
    print(repr(content[idx:idx+500]))