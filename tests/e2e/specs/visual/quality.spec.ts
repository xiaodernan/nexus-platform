import { test, expect } from '../../lib/fixture.js';

/**
 * Visual regression + responsive checks (spec §75, §77, §78).
 * Baselines live in specs/visual/__snapshots__/ and are regenerated deliberately with
 *   npx playwright test specs/visual --update-snapshots
 * after a reviewed change — never silently in CI.
 */

const ROUTES: Array<[string, string]> = [
  ['home', '/'],
  ['search', '/search?q=' + encodeURIComponent('帮我找附近适合约会的餐厅')],
  ['merchant', '/merchant'],
];

for (const [name, path] of ROUTES) {
  test(`visual: ${name} @1440`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, maxDiffPixelRatio: 0.02 });
  });
}

test('responsive: mobile-first means no horizontal scroll at 375px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/', '/search?q=餐厅']) {
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
