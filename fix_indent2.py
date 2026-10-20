with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find the function and fix the indentation
new_lines = []
i = 0
while i < len(lines):
    line = lines[i]
    if 'async def test_ambience_preference_matches_boolean_attributes' in line:
        new_lines.append(line)
        i += 1
        new_lines.append(lines[i])  # docstring
        i += 1
        new_lines.append(lines[i])  # comment
        i += 1
        # Skip all lines until we reach the next test function
        while i < len(lines) and not (lines[i].startswith('async def test_') and i > 8232):
            i += 1
        # Write the correct function body
        new_lines.append('    # Use a SqlLikeBackend that does not filter on text (like the real SQL backend)\n')
        new_lines.append('    class SqlLikeBackend(S.StaticBackend):\n')
        new_lines.append('        async def merchant_candidates(self, *, text=None, filters=None, **_kw):\n')
        new_lines.append('            return [dict(r) for r in self.merchants]\n')
        new_lines.append('\n')
        new_lines.append('    backend = SqlLikeBackend(\n')
        new_lines.append('        merchants=[\n')
        new_lines.append('            {"subject_id": "m1", "merchant_id": "m1", "subject_type": "merchant",\n')
        new_lines.append('             "display_name": "Quiet Cafe", "display_name_zh": "静谧咖啡",\n')
        new_lines.append('             "category_primary": "cafe", "rating_agg": 4.0, "review_count": 10,\n')
        new_lines.append('             "attributes": {"quiet_ambience": True, "lively_ambience": False}},\n')
        new_lines.append('            {"subject_id": "m2", "merchant_id": "m2", "subject_type": "merchant",\n')
        new_lines.append('             "display_name": "Lively Bar", "display_name_zh": "热闹酒吧",\n')
        new_lines.append('             "category_primary": "bar", "rating_agg": 4.2, "review_count": 20,\n')
        new_lines.append('             "attributes": {"quiet_ambience": False, "lively_ambience": True}},\n')
        new_lines.append('        ],\n')
        new_lines.append('        user_prefs=[\n')
        new_lines.append('            {"user_id": "u1", "kind": "style", "key": "ambience",\n')
        new_lines.append('             "value": json.dumps({"value": "quiet"}),\n')
        new_lines.append('             "weight": 0.7, "source": "inferred", "scope": "long_term"},\n')
        new_lines.append('        ]\n')
        new_lines.append('    )\n')
        new_lines.append('\n')
        new_lines.append('    plan = S.SearchPlan(query_text="cafe", limit=10)\n')
        new_lines.append('    cards, resp, _, scored = await S.search(backend=backend, plan=plan, user_id="u1")\n')
        new_lines.append('\n')
        new_lines.append('    assert len(scored) == 2\n')
        new_lines.append('    for s in scored:\n')
        new_lines.append('        row = s.candidate.raw.get("row", {})\n')
        new_lines.append('        name = row.get("display_name_zh", "")\n')
        new_lines.append('        if name == "静谧咖啡":\n')
        new_lines.append('            assert s.candidate.personalization is not None\n')
        new_lines.append('            assert s.candidate.personalization > 0.5\n')
        new_lines.append('        else:\n')
        new_lines.append('            assert s.candidate.personalization is not None\n')
        new_lines.append('            assert s.candidate.personalization < 0.5\n')
        new_lines.append('\n')
        # Skip to next function
        while i < len(lines) and not (lines[i].startswith('async def test_') and 'ambience' not in lines[i]):
            i += 1
        continue
    new_lines.append(line)
    i += 1

with open(r'D:\获客平台\apps\ai\tests\test_structured_preferences.py', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print('Done')