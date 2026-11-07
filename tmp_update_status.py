with open('D:/获客平台/docs/STATUS.md', 'r', encoding='utf-8') as f:
    content = f.read()
new_entry = '''

## 724. D724 · stub cart no longer ships stale_copy string; client renders from stale boolean

**The gap.** `adapters/platform.py:246` hardcoded `"stale_copy": "價格可能已更新"` in cart items with no locale support (D605's second producer). The module had no locale concept, and the test asserted the exact literal.

**The fix.** Removed `stale_copy` from `StubPlatformClient.add_cart_item()` - the item carries the `stale` boolean and the client renders the notice using `freshness.stale_copy(locale)` (§5/§20). Updated `test_stub_platform.py` to assert `stale_copy` is absent and `stale` is present.

**Measured.** The stale boolean is still surfaced correctly; checkout still blocks on stale prices. The locale-aware wording lives in `trust.freshness.stale_copy()` where the card path already uses it (D605).

- readers: stub cart adapter no longer ships locale-locked stale copy - D605's cart producer closed.
'''
with open('D:/获客平台/docs/STATUS.md', 'a', encoding='utf-8') as f:
    f.write(new_entry)
print('STATUS.md updated')