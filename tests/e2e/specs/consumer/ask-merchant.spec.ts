import { test, expect } from '../../lib/fixture.js';
import { WEB } from '../../playwright.config.js';

const MERCHANT_PAGE = '/m/basil-leaf-0419';

/**
 * §142 — the consumer asks, the merchant-agent answers, and the answer lands in the page.
 * The demo sign-in door sets the session cookie; the loop is only honest if the page
 * actually shows the answer appear after the click.
 */

test('consumer asks basil-leaf-0419 a question and the agent answers from KB', async ({ page }) => {
  // Establish the demo consumer session through the same BFF door the sign-in page uses.
  // The click-then-router.push flow races React hydration on slow mobile: the click lands
  // before the handlers are attached and the POST never fires. page.request shares the cookie
  // jar with the page context, so this is the same door, without the race.
  const resp = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  expect(resp.ok()).toBeTruthy();

  await page.goto(MERCHANT_PAGE);

  const box = page.locator('textarea').first();
  await box.click();
  await box.pressSequentially('有BB椅嗎');

  const submit = page.getByRole('button', { name: '送出問題' });
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  await submit.click();

  await expect(page.getByText(/商戶助理/).first()).toBeVisible({ timeout: 120_000 });
});

test('anonymous question box submits are refused before any agent work happens', async ({ page }) => {
  await page.goto(MERCHANT_PAGE);

  const box = page.locator('textarea').first();
  await box.click();
  await box.pressSequentially('test');

  const submit = page.getByRole('button', { name: '送出問題' });
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  await submit.click();

  // No agent answer appears, and the sign-in prompt is shown instead.
  await expect(page.getByText('登錄後才可提問').first()).toBeVisible();
  await expect(page.getByText(/商戶助理/)).toHaveCount(0);
});
