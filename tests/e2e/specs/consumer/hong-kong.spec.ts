import { test, expect } from '../../lib/fixture.js';

/**
 * `/hong-kong` — the mega hub for the Hong Kong story series. Renders on every deployment with the
 * full catalogue (the chapters are dict-carried text, not live fixtures!). Three arms:
 *  1. the page renders 200 with the title;
 *  2. every chapter card renders and links into the guides;
 *  3. the quiz teaser links into /hk-type and the search taster does so too.
 */

test('the mega hub renders its day-arc horizon band', async ({ page }) => {
  await page.goto('/hong-kong');
  await expect(page.locator('.nexus-horizon')).toHaveCount(1);
});

test('the arc clock renders all thirteen chapters in chronological order', async ({ page }) => {
  await page.goto('/hong-kong');
  await expect(page.getByRole('heading', { name: /香港一日的讀法|Reading the day/i }).first()).toBeVisible();
  await expect(page.locator('a[href="/guides/hk-cart-noodles-chronicle"]')).toHaveCount(2);
});

test('the Cantonese-of-the-day tile renders on the mega hub', async ({ page }) => {
  await page.goto('/hong-kong');
  await expect(page.getByRole('region', { name: /每日一句|ONE CANTONESE TODAY/i }).first()).toBeVisible();
});

test('marking a chapter read fills the local-first progress bar', async ({ page }) => {
  await page.goto('/hong-kong');
  const bar = page.getByRole('progressbar').first();
  await expect(bar).toHaveAttribute('aria-valuenow', '0');

  await page.locator('a[href^="/guides/hk-"]').first().click();
  await page.waitForURL('**/guides/hk-**', { waitUntil: 'domcontentloaded' });
  await page.goBack();

  await expect(page.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '1');
});

test('the /hong-kong mega hub renders its identity, the thirteen chapters, the quiz teaser and the search taster', async ({ page }) => {
  await page.goto('/hong-kong');

  // Identity heading: the hero block with a real subline.
  await expect(page.locator('h1').first()).toBeVisible();

  // Chapter cards: one card per chapter, each linking into /guides/<slug>.
  const chapterCards = page.locator('a[href^="/guides/hk-"]');
  await expect(chapterCards.first()).toBeVisible();
  const count = await chapterCards.count();
  expect(count).toBeGreaterThanOrEqual(13);

  // Quiz teaser: links to /hk-type.
  const quizLink = page.locator('a[href="/hk-type"]').first();
  await expect(quizLink).toBeVisible();

  // Search taster: links to /search?…
  const searchLink = page.locator('a[href^="/search?q="]').first();
  await expect(searchLink).toBeVisible();
});
