# NEXUS — Next Phase Work Plan (2026-10-20)

## Current State (Verified)
- **apps/ai**: 651 passed, 4 skipped (live-DB tests skip; Docker engine down)
- **All ledger checks PASS**: sections, citations, EOLs, contract drift (117/109/no gap)
- **D382 complete**: User preferences read into personalization ranking signal
- **Docker engine down**: Cannot run fresh gate or live DB tests (user must start Docker Desktop)

## Next Work Items (Priority Order)

### 1. **Standardize Preference Attribute Naming in Seed Data** (AI lane - data/seed)
**Problem**: Current NLU preference rules and merchant seed attributes use different naming conventions:
- NLU emits: `("ambience", "quiet")` → looks for `quiet_ambience` / `ambience_quiet` ✓ (matches)
- NLU emits: `("occasion", "date")` → looks for `date_occasion` / `occasion_date` ✗ (no match in seed)
- NLU emits: `("style", "ambience")` → looks for `ambience_style` / `style_ambience` ✗
- NLU emits: `("access", "mtr_near")` → looks for `mtr_near_access` / `access_mtr_near` ✗ (seed has `mtr_within_5min`)
- NLU emits: `("access", "accessible")` → looks for `accessible_access` / `access_accessible` ✗
- NLU emits: `("access", "parking")` → ✗
- NLU emits: `("access", "pet_friendly")` → ✗
- NLU emits: `("cuisine", "spicy")` → ✗

**Action**: Update seed generation (`data/seed/generate.py` and/or merchant CSV) to include attributes matching NLU preference keys using `{value}_{kind}` convention (e.g., `date_occasion`, `ambience_style`, `mtr_near_access`, `accessible_access`, `parking_access`, `pet_friendly_access`, `spicy_cuisine`, etc.)

### 2. **Improve Chinese NLU Extraction Quality** (AI lane - nlu/)
**Problem**: "帮我找一个适合情侣约会的地方" extracts `occasion=date` but no category. Keyword "restaurant" returns 8 cards but Chinese sentence returns 0 before D381 fix. Now returns 5 but category is still None.

**Action**: 
- Add category inference from occasion/preference (e.g., `occasion=date` → likely `restaurant`/`cafe`/`bar`)
- Improve district extraction for Chinese sentences without explicit district mentions
- Add more cuisine/preference patterns to `lexicon.py`

### 3. **Fix Preference Matching for Structured Values** (AI lane - search/service.py)
**Problem**: Current implementation assumes simple boolean attributes. Seed user preferences have structured JSON values:
- `style/ambience`: `{"value": "quiet"}` (string value, not boolean)
- `food/cuisine_like`: `{"values": ["cantonese","sushi",...]}`
- `budget/per_person_max_hkd`: `{"value": 300, "currency": "HKD"}`
- `location/home_district`: `{"value": "Sha Tin", "lat": ..., "lng": ...}`

**Action**: Extend `search()` pipeline to handle different preference value types:
- String enum values → match against merchant attribute with same value
- Array values → any match
- Numeric budget → use existing price_fit scoring
- District → use existing geo filtering

### 4. **Add Preference Signal to Ranking Explanations** (AI lane - search/ranking.py, cards.py)
**Problem**: When preferences boost a result, the EntityCard doesn't explain why (no MatchExplanation with fact_id for preference match).

**Action**: Add preference match as a ranked contribution with explanation in `contributions()` and `AiMatch.reasons`.

### 5. **Complete Fresh Gate Re-certification** (Blocked - needs Docker)
**Status**: Steps 1-3 complete (create gate DB, 9 migrations, synthetic data). Step 4 (seed load) was running when Docker went down.
**Action**: Wait for user to start Docker Desktop, then re-run `scripts/db_gate_fresh.sh` to completion (steps 4-18).

## Items Blocked on Other Streams
- **Web stream**: Home-page all-fail throw (D318), e2e test markers (D328), readability floor (D328), name-drop fix (D329)
- **Seed lane**: Review-aspect threshold calibration (D359)

## Immediate Next Steps (Can Do Now - No Docker Needed)
1. Fix seed data attribute naming to match NLU preference keys
2. Improve NLU category inference for Chinese sentences
3. Extend preference matching for structured values
4. Add preference explanations to ranking output

---

**Let me start with Item 1: Standardize seed data attribute naming.**