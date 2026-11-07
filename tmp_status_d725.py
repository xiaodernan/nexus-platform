with open('D:/获客平台/docs/STATUS.md', 'r', encoding='utf-8') as f:
    content = f.read()
new_entry = '''

## 725. D725 · open_state text localized for card availability and compare grid

**The gap.** `compute_open()` in `search/cards.py` returned English-only text ("Open until {hh:mm}", "Opens {hhmm}", "Closed"). The grid's `open_state` row and the card's availability block both copied it verbatim, so every reader saw English regardless of locale.

**The fix.** Added `locale` parameter to `compute_open()` (default `zh-HK`) and `OPEN_STATE_COPY` templates per locale. Callers in `search/service.py` and `api/routes_discover.py` now pass locale. `test_cards.py` updated to pass `locale="en"` where English text is expected.

**Measured.** Open/closed/opens-at text now renders in the user's locale (zh-HK, zh-CN, en) in both card availability blocks and compare grid cells.

- readers: open_state locale-aware in cards and compare grid - D605's open-state residue closed.
'''
with open('D:/获客平台/docs/STATUS.md', 'a', encoding='utf-8') as f:
    f.write(new_entry)
print('ok')