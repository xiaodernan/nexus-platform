import { test, expect } from '../../lib/fixture.js';
import { WEB } from '../../playwright.config.js';

const MERCHANT_ID = '8fcdeff4-1795-51c7-8a14-12a456055e99';

/**
 * §142's return half — the loop `ask` starts. A consumer asks, the merchant-agent answers, and
 * then a human on the merchant team takes the thread over from the Next console: the reply is
 * typed into the composer, lands through `POST /api/nexus/conversations/{id}/reply` → the
 * platform's `send_message` RBAC scope, and is rendered back in the thread labelled as the
 * merchant's turn. The consumer's next visit would see it in the same thread.
 */

test('the merchant team member replies and the turn lands in the thread (§142)', async ({ page }) => {
  const reply = `收到，請預約時說明有BB椅需求 ${Date.now()}`;

  // Consumer signs in and asks through the same BFF the browser uses.
  const consumer = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  expect(consumer.ok()).toBeTruthy();

  const ask = await page.request.post(`${WEB}/api/nexus/conversations/ask`, {
    data: {
      merchant_id: MERCHANT_ID,
      merchant_slug: 'basil-leaf-0419',
      message: '有BB椅嗎',
      locale: 'zh-HK',
      conversation_id: null,
    },
    headers: { 'content-type': 'application/json' },
  });
  expect(ask.ok()).toBeTruthy();
  const conversationId = ask.headers()['x-conversation-id'];
  expect(conversationId).toBeTruthy();

  // The merchant team signs in through the same BFF (overwriting the consumer's cookie).
  const merchant = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'merchant' },
    headers: { 'content-type': 'application/json' },
  });
  expect(merchant.ok()).toBeTruthy();

  // Open the thread and answer it from the composer.
  await page.goto(`/merchant/conversations/${conversationId}`);
  const box = page.locator('textarea#merchant-reply');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await box.pressSequentially(reply);
  await page.getByRole('button', { name: '送出回覆' }).click();

  // The page refreshes and shows the merchant's own turn.
  await expect(page.getByText(reply)).toBeVisible({ timeout: 30_000 });
});

test('the composer is not rendered for anonymous visitors', async ({ page }) => {
  await page.goto('/merchant/conversations');
  // Signed out: the console refuses to show anything, certainly no composer.
  await expect(page.getByText('需要登錄後查看').first()).toBeVisible();
  await expect(page.locator('textarea#merchant-reply')).toHaveCount(0);
});
