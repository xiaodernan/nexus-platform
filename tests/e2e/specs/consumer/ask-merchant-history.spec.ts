import { test, expect } from '../../lib/fixture.js';
import { WEB } from '../../playwright.config.js';

const MERCHANT_ID = '8fcdeff4-1795-51c7-8a14-12a456055e99';
const MERCHANT_SLUG = 'basil-leaf-0419';

/**
 * §142's consumer half: the earlier conversation, the agent's answer and the merchant team
 * member's reply are visible to THIS consumer on this merchant's page after a plain reload —
 * the circle only closes when the customer can find what was said. RBAC boundary included:
 * an anonymous visitor must NOT see a signed-in consumer's thread (the BFF 401s and the widget
 * paints its ask surface, nothing else).
 */

test('a signed-in consumer sees the earlier thread and the merchant reply after a reload (§142)', async ({ page }) => {
  const marker = `有BB椅嗎 ${Date.now()}`;

  // Consumer signs in and asks.
  const consumer = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  expect(consumer.ok()).toBeTruthy();
  const ask = await page.request.post(`${WEB}/api/nexus/conversations/ask`, {
    data: {
      merchant_id: MERCHANT_ID,
      merchant_slug: MERCHANT_SLUG,
      message: marker,
      locale: 'zh-HK',
      conversation_id: null,
    },
    headers: { 'content-type': 'application/json' },
  });
  expect(ask.ok()).toBeTruthy();

  // Merchant team replies through the same BFF round (same jar; merchant role).
  const merchant = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'merchant' },
    headers: { 'content-type': 'application/json' },
  });
  expect(merchant.ok()).toBeTruthy();
  const reply = `可以，預約時請說明 ${Date.now()}`;
  const conversationId = ask.headers()['x-conversation-id'];
  expect(conversationId).toBeTruthy();
  const answered = await page.request.post(
    `${WEB}/api/nexus/conversations/${conversationId}/reply`,
    {
      data: { content: reply },
      headers: { 'content-type': 'application/json' },
    },
  );
  expect(answered.ok()).toBeTruthy();

  // Consumer signs in again — plain page reload, the React state does not survive it.
  const consumerAgain = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  expect(consumerAgain.ok()).toBeTruthy();
  await page.goto('/m/basil-leaf-0419');

  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('有BB椅嗎', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(reply).first()).toBeVisible({ timeout: 30_000 });
});

test('an anonymous visitor cannot read another consumer\u2019s thread (RBAC, D5)', async ({ page, browser }) => {
  const marker = `門位如何 ${Date.now()}`;

  // A consumer asks; the thread exists in the database after this line.
  const consumer = await page.request.post(`${WEB}/api/nexus/auth`, {
    data: { role: 'consumer' },
    headers: { 'content-type': 'application/json' },
  });
  expect(consumer.ok()).toBeTruthy();
  const ask = await page.request.post(`${WEB}/api/nexus/conversations/ask`, {
    data: {
      merchant_id: MERCHANT_ID,
      merchant_slug: MERCHANT_SLUG,
      message: marker,
      locale: 'zh-HK',
      conversation_id: null,
    },
    headers: { 'content-type': 'application/json' },
  });
  expect(ask.ok()).toBeTruthy();

  // The anonymous view: the ask surface renders, the stored thread does not.
  // IMPORTANT: the request above used page.request, which carries the consumer cookie —
  // so `page` itself is a signed-in consumer right now and cannot prove anonymity. Prove it
  // with a FRESH browser context that never saw that session. (The D997 family of flakes
  // fails when hydration and the assertion race in this shared context.)
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto('/m/basil-leaf-0419');
    await expect(anonPage.getByRole('button', { name: '送出問題' })).toBeVisible();
    await expect(anonPage.getByText(marker)).toHaveCount(0);
  } finally {
    await anon.close();
  }
});
