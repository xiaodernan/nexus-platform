with open('D:/获客平台/docs/PLAN.md', 'r', encoding='utf-8') as f:
    content = f.read()
idx = content.find("The grid's `open_state` row")
if idx >= 0:
    end = content.find('\n-', idx)
    if end < 0:
        end = content.find('\n\n', idx)
    if end < 0:
        end = idx + 800
    # find the start of this bullet (go back to '- **')
    start = content.rfind('- **', 0, idx)
    if start < 0:
        start = idx
    new_block = '''- **The grid's `open_state` row, and the card's availability block, print one English string at a
  reader of any locale** - **CLOSED by D725** - `compute_open()` now takes `locale` and uses
  `OPEN_STATE_COPY` templates ("營業至 {close}" / "营业至 {close}" / "Open until {close}", etc.).
  Callers in `search/service.py` and `api/routes_discover.py` pass locale. Card availability and
  grid `open_state` cells now render in the user's locale.'''
    content = content[:start] + new_block + content[end:]
    with open('D:/获客平台/docs/PLAN.md', 'w', encoding='utf-8') as f:
        f.write(content)
    print('PLAN.md updated')
else:
    print('not found')