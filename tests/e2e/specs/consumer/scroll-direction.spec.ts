import { test, expect } from '../../lib/fixture.js';

/**
 * `/` and the chapter strip — the §五 scroll contract, pinned in a browser.
 *
 * The standing complaint ("往上滑看下面、往下滑看上面") is only ever true when something on
 * the plane intercepts a raw wheel delta and forwards it to a scroller that travels the other
 * way. This spec makes that untestable: the page itself is asserted to move down on a down
 * wheel and up on an up wheel, the horizontal chapter strip is asserted to bridge a down
 * wheel into sideways travel *without* moving the page (fine pointers only), and the four
 * busiest routes are asserted to never force a horizontal page scrollbar.
 */

test('wheel down scrolls the page down; wheel up scrolls the page up', async ({ page }) => {
  await page.goto('/');
  // The home route streams; give the document its own first paint.
  await page.locator('main').waitFor({ state: 'visible' });
  // A mouse wheel does not exist on the touch plane (mobile WebKit refuses it outright);
  // the contract this spec pins is the desktop pointer's.
  const fine = await page.evaluate(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  test.skip(!fine, 'touch plane: no wheel to send — the desktop wheel contract is what is pinned');

  await page.mouse.move(640, 420);
  const y0 = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 600);
  await page.waitForFunction((y) => window.scrollY > y, y0);
  const y1 = await page.evaluate(() => window.scrollY);
  expect(y1).toBeGreaterThan(y0);

  await page.mouse.wheel(0, -600);
  await page.waitForFunction((y) => window.scrollY < y, y1);
  const y2 = await page.evaluate(() => window.scrollY);
  expect(y2).toBeLessThan(y1);
});

test('on fine pointers the chapter strip bridges a vertical wheel sideways and leaves the page alone', async ({ page }) => {
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
