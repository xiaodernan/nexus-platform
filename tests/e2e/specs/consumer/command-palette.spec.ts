import { expect, test } from '../../lib/fixture.js';

/**
 * The global command palette (D1056): opens on Ctrl+K (Meta is macOS-only), closes on Esc,
 * and hands the query to the ordinary /search route. The shortcut is the whole feature —
 * if a regression swallows it silently, this is the only pad that fails.
 */

test.describe('global command palette', () => {
  test('Ctrl+K opens, Esc closes, Enter lands on /search?q=', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: /AI search|搜索/i });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('textbox');
    await expect(input).toBeFocused({ timeout: 10000 });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox').fill('九龍城 太鼓 拉麵');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=/);
    // the palette is closed after submit
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('Ctrl+K does not open while typing inside a field', async ({ page }) => {
    await page.goto('/');
    const input = page.getByLabel(/想要|需要|Tell me|What are you looking for/i);
    // CI lanes hydrate the hero island at a different race than the local box; land on a
    // painted, enabled input first, and give hydration the same window the assertion gets.
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await input.scrollIntoViewIfNeeded();
    await input.focus();
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Control+k');
    // the palette must not have stolen focus from the conversation box
    await expect(input).toBeFocused({ timeout: 10000 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
});
