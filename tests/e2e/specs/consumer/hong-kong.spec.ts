import { test, expect } from '../../lib/fixture.js';

/**
 * `/hong-kong` — the mega hub for the Hong Kong story series. Renders on every deployment with the
 * full catalogue (the chapters are dict-carried text, not live fixtures!). Three arms:
 *  1. the page renders 200 with the title;
 *  2. every chapter card renders and links into the guides;
 *  3. the quiz teaser links into /hk-type and the search taster does so too.
 */

test('the /hong-kong mega hub renders its identity, the seven chapters, the quiz teaser and the search taster', async ({ page }) => {
  await page.goto('/hong-kong');

  // Identity heading: the hero block with a real subline.
  await expect(page.locator('h1').first()).toBeVisible();

  // Chapter cards: one card per chapter, each linking into /guides/<slug>.
  const chapterCards = page.locator('a[href^="/guides/hk-"]');
  await expect(chapterCards.first()).toBeVisible();
  const count = await chapterCards.count();
  expect(count).toBeGreaterThanOrEqual(7);

  // Quiz teaser: links to /hk-type.
  const quizLink = page.locator('a[href="/hk-type"]').first();
  await expect(quizLink).toBeVisible();

  // Search taster: links to /search?…
  const searchLink = page.locator('a[href^="/search?q="]').first();
  await expect(searchLink).toBeVisible();
});
