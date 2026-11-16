import { test, expect } from '../../lib/fixture.js';

/**
 * D1276 — the three-state locale cycle, pinned in a browser.
 *
 * The static census exists so a carrier of the wrong script is caught at build time. This spec
 * pins the runtime half of the same promise: one click zh-HK → zh-CN → en → zh-HK, the cookie
 * that the server's `currentLocale()` reads, `document.documentElement.lang`, the toggle's
 * aria-label, and one painted Simplified/Traditional/English string per arm (`nav.handbook`).
 * A locale cycle that writes no cookie, or that lands on the wrong arm after the wrap, or that
 * reloads into a page whose <html lang> doesn't match the picker fails red here.
 */

test('the locale toggle cycles zh-HK → zh-CN → en → zh-HK; cookie, lang attribute and painted copy all move', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/');
  const toggle = page.locator('[data-nexus-locale-toggle=""]');
  await expect(toggle).toBeVisible();
  const nexusLocale = async () => (await context.cookies()).find((c) => c.name === 'nexus_locale')?.value;

  // 1) the runner's Accept-Language is zh-HK and no cookie exists: the Traditional arm answers.
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');
  await expect(toggle).toHaveAttribute('aria-label', /簡體/);
  await expect(page.locator('body')).toContainText('說明書');

  // 2) first click lands on the Simplified arm — cookie, lang attribute, aria-label, painted copy.
  await toggle.click();
  await page.waitForLoadState('load');
  expect(await nexusLocale()).toBe('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  // On the Simplified arm the next stop in the cycle is English — the aria-label names the NEXT jump.
  await expect(toggle).toHaveAttribute('aria-label', '切换到英文版 — 整页一键互换');
  await expect(page.locator('body')).toContainText('说明书');

  // 3) second click lands on the English arm.
  await toggle.click();
  await page.waitForLoadState('load');
  expect(await nexusLocale()).toBe('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(toggle).toHaveAttribute('aria-label', /Traditional/);
  await expect(page.locator('body')).toContainText('Handbook');

  // 4) third click wraps back to the default Traditional arm — the cycle is closed, not a switch.
  await toggle.click();
  await page.waitForLoadState('load');
  expect(await nexusLocale()).toBe('zh-HK');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-HK');
  await expect(page.locator('body')).toContainText('說明書');
});
