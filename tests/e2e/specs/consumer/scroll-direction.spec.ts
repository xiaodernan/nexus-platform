import { test, expect } from '../../lib/fixture.js';

/**
 * `/` and the chapter strip — the §五 scroll contract, pinned in a browser.
 *
 * The product's default (the D328/D329 wave): the wheel follows the reader — a down
 * wheel moves the viewport up, so what a native page shows on an up wheel is what the
 * reader sees on their down wheel — because the owner's driver inverts the OS sign and
 * the reversed interceptor is the product-level counter-act. The header toggle flips the
 * page back to the native OS sign for readers whose driver behaves; the chapter strip
 * keeps its deliberate sideways bridge under both contracts (the interceptor exempts the
 * strip), and no busy route ever grows a horizontal page scrollbar.
 */

test('wheel down scrolls the page up by default; the toggle restores the native sign', async ({ page }) => {
  await page.goto('/');
  await page.locator('main').waitFor({ state: 'visible' });
  const fine = await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  test.skip(!fine, 'touch plane: no wheel to send — the desktop wheel contract is what is pinned');

  await page.mouse.move(640, 420);
  // The page needs scroll room on both sides: pin the middle after walking down.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(150);
  const y0 = await page.evaluate(() => window.scrollY);
  expect(y0).toBeGreaterThan(0);

  // The default contract: a down wheel travels the viewport up — the reader's down wheel
  // shows the content a native page shows above, counter-acting the inverted driver.
  await page.mouse.wheel(0, 600);
  await page.waitForFunction((y) => window.scrollY < y, y0);
  const y1 = await page.evaluate(() => window.scrollY);
  expect(y1).toBeLessThan(y0);

  await page.mouse.wheel(0, -600);
  await page.waitForFunction((y) => window.scrollY > y, y1);
  const y2 = await page.evaluate(() => window.scrollY);
  expect(y2).toBeGreaterThan(y1);

  // The header toggle restores the native OS sign: a down wheel scrolls the page down.
  const toggle = page.getByRole('button', { name: /滾輪|滚轮|wheel|捲動|direction/i }).first();
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.mouse.wheel(0, 600);
  await page.waitForFunction((y) => window.scrollY > y, y2);
  const y3 = await page.evaluate(() => window.scrollY);
  expect(y3).toBeGreaterThan(y2);

  // Flip back — the reversed contract returns for the rest of the session.
  await toggle.click();
  await page.mouse.wheel(0, 600);
  await page.waitForFunction((y) => window.scrollY < y, y3);
});

test('on fine pointers the chapter strip bridges a vertical wheel sideways and leaves the page alone', async ({
  page,
}) => {
  await page.goto('/hong-kong');
  const strip = page.locator('section[aria-labelledby="arc-timeline-title"] ol');
  await strip.scrollIntoViewIfNeeded();

  const fine = await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  test.skip(!fine, 'touch plane: the rail wheel bridge is deliberately not attached');

  const before = await strip.evaluate((el) => ({
    scrollLeft: el.scrollLeft,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    pageY: window.scrollY,
  }));
  expect(before.scrollWidth).toBeGreaterThan(before.clientWidth); // the strip is bridgeable at all

  const box = await strip.boundingBox();
  if (!box) throw new Error('the chapter strip lost its box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  await page.mouse.wheel(0, 300);
  await expect.poll(async () => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before.scrollLeft);
  // The bridge consumed the delta — the page did not travel.
  expect(await page.evaluate(() => window.scrollY)).toBe(before.pageY);

  await page.mouse.wheel(0, -300);
  await expect.poll(async () => strip.evaluate((el) => el.scrollLeft)).toBeLessThan(before.scrollLeft + 300);
});

test('the busy routes never force a horizontal page scrollbar', async ({ page }) => {
  for (const route of ['/', '/hong-kong', '/handbook', '/world']) {
    await page.goto(route);
    await page.locator('main').waitFor({ state: 'visible' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${route} forces the page wider than the viewport`).toBeLessThanOrEqual(0);
  }
});
