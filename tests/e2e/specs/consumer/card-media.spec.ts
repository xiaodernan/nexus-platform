import { test, expect } from '../../lib/fixture.js';
import type { Page } from '@playwright/test';

/**
 * Card artwork on a server-rendered surface must actually be visible (U-G's stranded-opacity class,
 * second copy).
 *
 * `CardMedia` (packages/ui/src/trust/Renderers.tsx) renders the `<img>` at `opacity-0` and flips it
 * to `opacity-100` from React's `onLoad`. On a server-rendered page the browser has usually finished
 * the tiny local SVG before hydration attaches the handler — and a load event that already fired
 * never fires again — so the card keeps its skeleton for the life of the page. Measured on the live
 * dev plane 2026-10-27, before the fix: home 28/28 images `complete` with computed opacity 0 (cold and
 * warm, at 3s and at 8s), a merchant detail page 12/12 the same, while the streamed search surface —
 * where React creates the element, so `onLoad` is attached before the load lands — reads 8/8 opaque.
 * Re-running this spec against the ref callback emptied (the D558 arm) reproduces it from the tests'
 * own navigation: 28/28 home, 7/7 on the merchant the home page links to first, control still green.
 *
 * The search case is the control: it is the same component working. If it ever goes opaque-less the
 * fix has been bought by hiding artwork everywhere, not by making it appear.
 */

/** Every card image, with the two facts that decide whether a consumer can see it. */
async function artwork(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('img'))
      .filter((i) => (i.getAttribute('src') ?? '').startsWith('/demo/img/'))
      .map((i) => ({
        src: i.getAttribute('src') ?? '',
        complete: i.complete && i.naturalWidth > 0,
        opacity: Number.parseFloat(getComputedStyle(i).opacity),
      })),
  );
}

/**
 * `networkidle` never arrives against a dev server (its HMR socket keeps the network busy), so each
 * open waits on the surface's own hook — a card — then on the browser's own load report, then on the
 * fade to finish. The last wait is a deadline, not a sleep: hydration is what starts the fade, and on
 * a dev bundle it can outlast any fixed settle. It cannot rescue the defect, because the broken
 * component never sets `loaded` at all — the 2026-10-27 reading held at opacity 0 through 8 seconds.
 */
async function open(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('article[data-card-type]').first()).toBeVisible({ timeout: 20000 });
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll('img[src^="/demo/img/"]')).every(
          (i) => i.complete && i.naturalWidth > 0 && Number.parseFloat(getComputedStyle(i).opacity) >= 0.99,
        ),
      null,
      { timeout: 15000 },
    )
    .catch(() => {});
  await page.waitForTimeout(400);
}

/** The first merchant the home page links to — so this spec never pins a seeded slug. */
async function firstMerchantHref(page: Page) {
  const link = page.locator('a[href^="/m/"]').first();
  await expect(link, 'home links to no merchant card').toBeVisible();
  return (await link.getAttribute('href')) ?? '/';
}

function verdict(name: string, seen: Awaited<ReturnType<typeof artwork>>) {
  const stuck = seen.filter((i) => i.complete && i.opacity < 0.99);
  expect(seen.length, `${name} rendered no /demo/img/ card artwork to judge`).toBeGreaterThan(0);
  expect(
    stuck,
    `${stuck.length}/${seen.length} of ${name}'s card images are loaded and still invisible ` +
      `(CardMedia's onLoad never fired after hydration): ${JSON.stringify(stuck.slice(0, 3))}`,
  ).toEqual([]);
}

for (const [name, path] of [
  ['home', '/'],
  ['merchant detail', null],
] as Array<[string, string | null]>) {
  test(`card artwork is visible on the SSR'd ${name}`, async ({ page }) => {
    // Two opens, each with its own 15-second settle, do not fit Playwright's 30s default; without
    // this the red arrives as "browser has been closed", which is a harness timeout, not a verdict.
    test.slow();
    await open(page, '/');
    await open(page, path ?? await firstMerchantHref(page));
    verdict(name, await artwork(page));
  });
}

test('card artwork is visible on the streamed search surface (the control)', async ({ page }) => {
  test.slow();
  await open(page, '/search?q=' + encodeURIComponent('餐厅'));
  const seen = await artwork(page);
  expect(seen.length, 'search returned no cards with artwork').toBeGreaterThan(0);
  expect(seen.filter((i) => !i.complete || i.opacity < 0.99), JSON.stringify(seen.slice(0, 3))).toEqual(
    [],
  );
});
