# Update PLAN.md - mark open_state locale issue as closed
with open('D:/获客平台/docs/PLAN.md', 'r', encoding='utf-8') as f:
    content = f.read()
old = '''- **The grid's `open_state` row, and the card's availability block, print one English string at a
  reader of any locale** - found while this unit was standing in `_grid`, not measured:
  `compute_open()` builds its `text` from three English templates ("Open until {hh:mm}", "Opens
  {hh:mm}", "Closed"), and both readers copy it verbatim - the card's availability object and this
  cell. `REASON_COPY` in the same module already holds ��{when} �I�I�� {close}�� and ���F���I�I�� and selects
  per locale, but only for the card's reason line. ��603 (D605) closed exactly this shape on one card
  string; the open-state text is the same defect with two readers, and the localized vocabulary is
  already written. Owner: the AI lane.'''
new = '''- **The grid's `open_state` row, and the card's availability block, print one English string at a
  reader of any locale** - **CLOSED by D725** - `compute_open()` now takes `locale` and uses
  `OPEN_STATE_COPY` templates ("營業至 {close}" / "营业至 {close}" / "Open until {close}", etc.).
  Callers in `search/service.py` and `api/routes_discover.py` pass locale. Card availability and
  grid `open_state` cells now render in the user's locale.'''
if old in content:
    content = content.replace(old, new)
    with open('D:/获客平台/docs/PLAN.md', 'w', encoding='utf-8') as f:
        f.write(content)
    print('PLAN.md updated')
else:
    print('not found - trying to locate')
    idx = content.find("The grid's `open_state` row")
    if idx >= 0:
        print('found at', idx)
        print(content[idx:idx+200])
    else:
        print('not found at all')