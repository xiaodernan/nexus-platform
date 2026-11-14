import { test, expect } from '../../lib/fixture.js';

/**
 * D1095's `/hk-type` — the interactive Hong Kong archetype quiz, end-to-end:
 * start screen renders with chapter chips and the 開始 button; clicking it enters
 * the question phase with a real progressbar; eight picks of option A land on the
 * deterministic yum_cha archetype result with the matching chapter link.
 */

test('the /hk-type quiz is playable end-to-end', async ({ page }) => {
  await page.goto('/hk-type');

  // Start screen — chapter chips, title, CTA button.
  await expect(page.getByRole('heading', { name: '你係邊一個 HK？' })).toBeVisible();
  await expect(page.getByRole('button', { name: '開始' })).toBeVisible();

  // Enter the question phase.
  await page.getByRole('button', { name: '開始' }).click();

  const progressbar = page.locator('[role="progressbar"]');
  await expect(progressbar).toBeVisible();

  // Play through deterministically: ten option-A clicks → yum_cha archetype.
  for (let n = 0; n < 10; n += 1) {
    await page.getByRole('button', { name: /^A / }).click();
  }

  // Result lands: the yum_cha archetype heading, the chapter CTA.
  await expect(page.getByRole('heading', { name: /茶樓早茶/ })).toBeVisible();
  await expect(page.getByText(/閱讀《早茶：竹籠與陳皮茶香》/)).toBeVisible();
});
