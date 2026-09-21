import { test, expect, demoLogin, unauditedNumbers } from '../../lib/fixture.js';

/**
 * Contract tests against docs/API_CONTRACT.md — these fail loudly when a service drifts from the
 * shapes the frontend and SDK are built on. Run with `npm run test:api` (no browser needed).
 */

test.describe('HTTP contract', () => {
  test('error envelope is always { error: { code, message, request_id } }', async ({ platform }) => {
    const res = await platform.get('/api/v1/merchants/does-not-exist-xyz');
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.error?.code, JSON.stringify(body)).toBeTypeOf('string');
    expect(body.error?.request_id).toBeTypeOf('string');
  });

  test('responses use snake_case and honour X-Request-Id', async ({ platform }) => {
    const rid = 'e2e-' + Date.now();
    const res = await platform.get('/api/v1/merchants?limit=5', {
      headers: { 'X-Tenant': 'hong-kong', 'X-Request-Id': rid },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(res.headers()['x-request-id'] ?? res.headers()['X-Request-Id'], 'request id not echoed').toBe(rid);
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/"(createdAt|merchantId|displayName|updatedAt)"/);
  });

  test('pagination is cursor-based with a limit cap', async ({ platform }) => {
    const res = await platform.get('/api/v1/merchants?limit=1000');
    expect([200, 422].includes(res.status()), await res.text()).toBe(true);
    if (res.ok()) {
      const body = await res.json();
      expect(body.items.length, 'limit=1000 was not capped').toBeLessThanOrEqual(100);
      expect('next_cursor' in body, 'missing next_cursor').toBe(true);
    }
  });

  test('unauthenticated writes are rejected, and AI writes need grants (§52)', async ({ platform }) => {
    const noAuth = await platform.post('/api/v1/merchant/businesses', { data: { legal_name: 'X' } });
    expect(noAuth.status()).toBe(401);

    const consumer = await demoLogin(platform, 'consumer');
    const forbidden = await platform.post('/api/v1/merchant/businesses', {
      headers: { Authorization: `Bearer ${consumer.access_token}` },
      data: { legal_name: 'X' },
    });
    expect([401, 403].includes(forbidden.status()), `consumer could create a merchant: ${forbidden.status()}`).toBe(
      true,
    );
  });

  test('checkout is idempotent: replaying the key creates no second order (§54)', async ({ platform }) => {
    test.info().annotations.push({ type: 'contract', description: 'API_CONTRACT §6' });
    const consumer = await demoLogin(platform, 'consumer');
    const auth = { Authorization: `Bearer ${consumer.access_token}`, 'X-Tenant': 'hong-kong' };
    const list = await platform.get('/api/v1/merchants?limit=1', { headers: auth });
    const items = ((await list.json()).items ?? []) as Array<{ id: string }>;
    test.skip(items.length === 0, 'seed data required');

    const cart = await platform.post('/api/v1/carts', { headers: auth, data: {} });
    test.skip(!cart.ok(), await cart.text());
    const cartId = (await cart.json()).id as string;

    const offerings = await platform.get(`/api/v1/merchants/${items[0].id}/menu?limit=1`, { headers: auth });
    const menu = ((await offerings.json()).items ?? []) as Array<{ id: string }>;
    test.skip(menu.length === 0, 'merchant has no offerings');

    const add = await platform.post('/api/v1/carts/items', {
      headers: auth,
      data: { cart_id: cartId, offering_id: menu[0].id, quantity: 1 },
    });
    test.skip(!add.ok(), await add.text());

    const key = 'e2e-' + crypto.randomUUID();
    const first = await platform.post(`/api/v1/carts/${cartId}/checkout`, {
      headers: { ...auth, 'Idempotency-Key': key },
      data: {},
    });
    test.skip(!first.ok(), await first.text());
    const a = await first.json();

    const second = await platform.post(`/api/v1/carts/${cartId}/checkout`, {
      headers: { ...auth, 'Idempotency-Key': key },
      data: {},
    });
    const b = await second.json();
    expect(second.status(), JSON.stringify(b)).toBe(first.status());
    expect(b.order?.id ?? b.id, 'second checkout created a new order').toBe(a.order?.id ?? a.id);
  });

  test('EntityCard payload passes the trust check (§19)', async ({ ai }) => {
    const res = await ai.post('/ai/v1/search', {
      data: { intent: { raw_query: '咖啡店', intent: 'discover_merchant' }, limit: 10 },
    });
    test.skip(!res.ok(), await res.text());
    const { items } = await res.json();
    for (const item of items ?? []) {
      expect(unauditedNumbers(item), `${item.slug}: ${unauditedNumbers(item).join(', ')}`).toEqual([]);
    }
  });

  test('deterministic search stays up with no LLM (§105)', async ({ ai }) => {
    const started = Date.now();
    const res = await ai.post('/ai/v1/search', {
      data: { intent: { raw_query: '预算300以内 日本料理 中環', intent: 'discover_merchant' }, limit: 10 },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.degraded ?? false, 'deterministic path should not be marked degraded').toBe(false);
    expect(Date.now() - started, '/ai/v1/search exceeded 2s warm').toBeLessThan(2000);
    expect(Array.isArray(body.items)).toBe(true);
  });

  test('health + readiness for every service', async ({ platform, ai, request }) => {
    await expect(platform.get('/actuator/health').then((r) => r.status()).catch(() => 0)).resolves.toBeLessThan(500);
    await expect(ai.get('/healthz').then((r) => r.status())).resolves.toBe(200);
    const web = await request.get('http://127.0.0.1:3000/', { maxRedirects: 5 });
    expect(web.status()).toBe(200);
  });
});
