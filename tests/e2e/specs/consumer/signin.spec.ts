import { test, expect } from '../../lib/fixture.js';

/**
 * D1077's two-panel sign-in desk, end-to-end: the left promise panel carries the brand tagline
 * as the display headline and the three HK-local proofs (dict-driven, HK Traditional script); the
 * right card keeps the working door (§46/§48) untouched. The proofs are the new copy surface this
 * spec pins so a dict regression shows up as a red e2e, not as a silent page.
 */

test('the sign-in desk renders both panels with HK proof copy', async ({ page }) => {
  await page.goto('/signin');

  // Left panel: the promise — eyebrow + three HK-local proofs from the dictionary.
  await expect(page.getByText('為什麼是香港本地')).toBeVisible();
  await expect(page.getByText('香港本地優先')).toBeVisible();
  await expect(page.getByText('每個數字都有出處')).toBeVisible();
  await expect(page.getByText('一句話就能搜')).toBeVisible();

  // Right card: the working door — title + the §46/§48 actions.
  await expect(page.getByRole('heading', { name: '示例登入' })).toBeVisible();
  await expect(page.getByText('為什麼是香港本地').first()).toBeAttached();

  // Display headline: the brand tagline, from the shared dict (never hand-typed).
  await expect(page.getByText('用一句話，找到今天想去的地方').first()).toBeVisible();
});
