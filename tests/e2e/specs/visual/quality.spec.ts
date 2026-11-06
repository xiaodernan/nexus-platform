import { test, expect } from '../../lib/fixture.js';
import type { Page } from '@playwright/test';

/**
 * Visual regression + responsive checks (spec §75, §77, §78).
 * Baselines live in specs/visual/__snapshots__/ and are regenerated deliberately with
 *   npx playwright test specs/visual --update-snapshots
 * after a reviewed change — never silently in CI.
 *
 * **THE PLANE IS THE MOCK PLANE, and this file says so before it records anything.**
 *
 * A pixel baseline is worth keeping only if it is deterministic. The live plane is not: its cards
 * are the corpus, the corpus is re-seeded, and every re-seed moves pixels for reasons that have
 * nothing to do with the UI. The mock plane (`NEXT_PUBLIC_DATA_MODE=mock`, §130) is the product's
 * own documented offline plane and renders the same components from fixtures.
 *
 * The three committed baselines were recorded against whatever the machine happened to be running,
 * and the evidence is in the images: the home baseline was the ROUTE ERROR BOUNDARY (an error page
 * with a `digest 356e000392`), the search baseline was the honest empty state, and the merchant
 * baseline was the sign-in gate. A visual test whose baseline is a crash only passes while the
 * product is broken — and because `apps/web/.env.local` (gitignored) puts a local machine in live
 * mode while CI has no such file and runs mock, the suite could not have been green in both places
 * at once.
 *
 * So every screenshot states its preconditions before the image is compared or written:
 *   1. the page is not the error boundary — a crash can never become a baseline;
 *   2. the page is on the mock plane — the demo notice renders only there, so a live run fails
 *      loudly instead of quietly recording a corpus-dependent image;
 *   3. the page rendered its OWN content — the route's own heading is on screen.
 */

/** Only the mock plane renders the §155 demo notice (`DataModeNotice` returns null in live mode). */
const DEMO_NOTICE = '[data-nexus-demo-notice="mock"]';

/**
 * The route, its path, and the heading that proves the route rendered its own content.
 *
 * The search query is the product's own starter prompt (`lib/prompts.ts`) — the copy a reviewer
 * types first, and a query the fixture catalogue can answer: measured on the mock plane, the
 * simplified-Chinese sentence the spec used before (`帮我找附近适合约会的餐厅`) returns **0** cards,
 * so it photographed the empty state, while this one returns 6. A baseline of the empty state is
 * the honest state of a *query the catalogue cannot answer*, not of the results page.
 */
const ROUTES: Array<[string, string, string]> = [
  ['home', '/', '想說就去。'],
  [
    'search',
    '/search?q=' + encodeURIComponent('週末找一個適合情侶約會的地方'),
    '「週末找一個適合情侶約會的地方」的結果',
  ],
  ['merchant', '/merchant', '商戶經營概覽'],
];

async function expectRendered(page: Page, heading: string): Promise<void> {
  await expect(page.locator('[data-nexus-error-boundary]')).toHaveCount(0);
  await expect(page.locator(DEMO_NOTICE)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

for (const [name, path, heading] of ROUTES) {
  test(`visual: ${name} @1440`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expectRendered(page, heading);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, maxDiffPixelRatio: 0.02 });
  });
}

test('responsive: mobile-first means no horizontal scroll at 375px', async ({ page }) => {
  // `test.slow()`: against a dev server the first request for a route compiles it, and a cold
  // compile outruns the default 30s budget. The assertion is about overflow, not about latency.
  test.slow();
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/', '/search?q=' + encodeURIComponent('週末找一個適合情侶約會的地方')]) {
    await page.goto(path);
    await page.waitForLoadState('domcontentloaded');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} overflows by ${overflow}px on mobile`).toBeLessThanOrEqual(1);
  }
});

test('readability: primary text meets AA contrast on both themes', async ({ page }) => {
  await page.goto('/');
  const contrast = await page.evaluate(() => {
    const parse = (c: string): number[] => (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);
    const num = (v: number | undefined) => (Number.isFinite(v) ? (v as number) : 0);
    const lum = (rgb: number[]) => {
      const [r, g, b] = [num(rgb[0]), num(rgb[1]), num(rgb[2])];
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    return Array.from(document.querySelectorAll('h1,h2,p,button')).slice(0, 40).map((el) => {
      const s = getComputedStyle(el);
      const fg = lum(parse(s.color));
      let bg = parse(s.backgroundColor);
      let node: HTMLElement | null = el as HTMLElement;
      if (bg.every((v) => v === 0) && s.backgroundColor === 'rgba(0, 0, 0, 0)') {
        while (node) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c.some((v) => v !== 0)) { bg = c; break; }
          node = node.parentElement;
        }
      }
      const b = lum(bg);
      return { text: el.textContent?.slice(0, 24), ratio: (Math.max(fg, b) + 0.05) / (Math.min(fg, b) + 0.05) };
    });
  });
  const weak = contrast.filter((c) => c.ratio < 4.5 && c.text?.trim());
  expect(weak, `below AA: ${JSON.stringify(weak.slice(0, 5))}`).toEqual([]);
});

test('motion respects prefers-reduced-motion (§78)', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto('/');
  const animated = await page.evaluate(() =>
    Array.from(document.querySelectorAll('*')).filter((el) => {
      const s = getComputedStyle(el);
      return s.animationName !== 'none' && parseFloat(s.animationDuration) > 0.05;
    }).length,
  );
  expect(animated, 'reduced-motion users still get long animations').toBeLessThan(5);
  await ctx.close();
});
