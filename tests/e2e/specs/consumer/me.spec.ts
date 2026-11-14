import { test, expect } from '../../lib/fixture.js';
import { WEB } from '../../playwright.config.js';

/**
 * The consumer account hub (`/me`) — D1075/D1076 end-to-end: anonymous readers stop at the sign-in
 * desk (§46/§48), the demo consumer sees their identity panel, saved-merchant grid, inbox,
 * reservations and orders — and every section prints a stable heading regardless of what the data
 * plane answers. The visual suite keeps `/me`'s pixels honest; this spec keeps the wiring honest.
 */

test('anonymous reader stops at the sign-in desk, never the hub', async ({ page }) => {
  await page.goto('/me');

  // The stop carries a way out to /signin and never a single account section.
  await expect(page.getByRole('link', { name: /登入|繼續/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '我的收藏' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '提醒' })).toHaveCount(0);
});

test('the demo consumer reads the hub: identity, saved merchants, inbox, reservations, orders', async ({ page }, testInfo) => {
  const resp = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  // Mock plane answers 501 data_mode_mock — the demo identity exists server-side with no session,
  // so the hub renders without one. Live plane answers 200 for the seeded consumer. Anything else
  // (502/503/504, i.e. no live stack) leaves this spec unrunnable on this host; CI exercises it.
  if (resp.status() === 501 || resp.ok()) {
    // proceed with the assertions below
  } else {
    testInfo.skip(true, `demo door answered ${resp.status()} — the signed-in arm needs the seeded stack (CI)`);
    return;
  }

  await page.goto('/me');

  // Identity panel: the monogram H1 area — display name non-empty, eyebrow caption present.
  const identityHeading = page.locator('h1').first();
  await expect(identityHeading).toBeVisible();
  expect((await identityHeading.innerText()).trim().length).toBeGreaterThan(0);

  // Every section heading renders regardless of what the data plane answered — a failed read shows
  // the §1 code in-section, never a missing section.
  for (const name of ['我的收藏', '我的搜尋', '提醒', '我的訂位', '我的訂單']) {
    await expect(page.getByRole('heading', { name }).first()).toBeVisible();
  }

  // Saved merchants grid: card links point through /m/<slug>. Might be absent on a fresh plane with
  // no seeded favourites — the empty state is the other honest outcome, and both are correct.
  const savedGrid = page.locator('a[href^="/m/"]');
  const emptyState = page.getByText('還沒有收藏');
  const cards = await savedGrid.count();
  const empty = await emptyState.count();
  expect(cards + empty).toBeGreaterThan(0);

  // The nav rail links the surface; the footer carries it too.
  await expect(page.getByRole('link', { name: '我的' }).first()).toBeVisible();
});
