import { expect, test } from '../../lib/fixture.js';

/**
 * Admin console — the screen D1059 wired into the system page.
 * Runs under the mock plane: IS_MOCK grants any role without a network, so the page renders the
 * fixture read. The fixture is a DEMO, and the page must say so (§155) — that is one arm of the
 * test; the other arm is that the events section actually renders.
 */

test.describe('admin console — mock plane', () => {
  test('the system page renders the events section with demo provenance and the events badge', async ({ page }) => {
    await page.goto('/admin/system');
    await expect(page.getByRole('heading', { level: 1, name: /系統健康|System health/i })).toBeVisible();
    await expect(page.getByText(/事件流|Event stream/i).first()).toBeVisible();
    // Demo-provenance visible somewhere on the page (the demo banner is the canonical carrier).
    await expect(page.getByText(/demo|演示/i).first()).toBeVisible();
  });
});
