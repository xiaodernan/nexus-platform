# Update PLAN.md
with open('D:/获客平台/docs/PLAN.md', 'r', encoding='utf-8') as f:
    content = f.read()
old = '''- **The stub cart writes the same stale-price sentence with no locale in sight (D605's second
  producer)** - `adapters/platform.py:246` puts `"stale_copy": "價格可能已更新"` into a cart item
  beside a `stale` boolean, and the module has no locale concept at all (measured: 0 occurrences of
  the word `locale` in `adapters/platform.py`; `add_cart_item` takes `cart_id, offering_id,
  quantity, options, token, tenant`). `test_stub_platform.py:100` asserts that exact literal under a
  `# §20 localisation` comment, so the stub's own door currently grades the wrong-language copy as
  correct. D605 fixed the card path and left this one named rather than folding a wider change into
  its evidence. Two repairs, different shapes: give the adapter the request locale, or stop shipping
  a sentence from it and let the client render the notice from `stale` - the item already carries the
  boolean, and §5's promise is about surfacing staleness, not about which module owns the wording.
  Owner: the AI lane with the platform adapter's owner.'''
new = '''- **The stub cart writes the same stale-price sentence with no locale in sight (D605's second
  producer)** - **CLOSED by D724** - `adapters/platform.py:246` no longer ships `stale_copy` from the
  adapter; the item carries the `stale` boolean and the client renders the notice using
  `freshness.stale_copy(locale)` (§5/§20). `test_stub_platform.py` updated to assert `stale_copy` is
  absent and `stale` boolean is present. D605 fixed the card path; D724 fixes the cart adapter path.'''
if old in content:
    content = content.replace(old, new)
    with open('D:/获客平台/docs/PLAN.md', 'w', encoding='utf-8') as f:
        f.write(content)
    print('PLAN.md updated')
else:
    print('not found')