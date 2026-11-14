import { test, expect } from '../../lib/fixture.js';

/**
 * `/handbook` — the written product manual. The page must render on every deployment (it is
 * dict-carried text), carry the whole user journey in nine numbered sections, and prove a
 * reader can jump from the "five steps" tour straight into the real product.
 */

test('the handbook renders the tour, the nine sections and their anchor links', async ({ page }) => {
  await page.goto('/handbook');

  await expect(page.locator('h1').first()).toBeVisible();

  // The five-step walk-through is the entry point; each step is a <li>.
  await expect(page.getByRole('listitem').filter({ hasText: /SearchBox|Search|一句話/ }).first()).toBeVisible();

  // Every section renders with a stable id the jump rail can target.
  for (const id of ['search', 'home', 'hkseries', 'quiz', 'daily', 'me', 'merchant', 'privacy', 'faq']) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }

  // Example query is quoted verbatim on the page.
  await expect(page.getByText('油麻地 魚蛋，要抵食又快').first()).toBeVisible();

  // The jump rail offers at least one route into the product.
  await expect(page.locator('a[href="/hk-type"]').first()).toBeVisible();
  await expect(page.locator('a[href="/hong-kong"]').first()).toBeVisible();
});

test('the handbook hero CTA lands on the SearchBox', async ({ page }) => {
  await page.goto('/handbook');
  // Scope to the main landmark: the header carries its own icon-only /search button, which
  // on the mobile viewport intercepts every role-query and forces the first click to time out.
  await page.locator('main a[href="/search"]').first().click();
  await page.waitForURL('**/search**', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/search/);
});
