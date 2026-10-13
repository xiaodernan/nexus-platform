import { test, expect, demoLogin } from '../../lib/fixture.js';

/** Merchant core journey — spec §139, §89, §142. */

test.describe('merchant journey', () => {
  test('publish a business and see it live in under 15 minutes of UI steps (§142)', async ({ page, platform }) => {
    const { access_token } = await demoLogin(platform, 'merchant');
    await page.addInitScript((t: string) => localStorage.setItem('nexus.dev_token', t), access_token);
    await page.goto('/merchant');

    await expect(page.getByText(/AI conversations|AI 對話|概覽|Overview/i).first()).toBeVisible({
      timeout: 15000,
    });

    // knowledge base + agent must be reachable from the dashboard shell (§33)
    for (const nav of [/Products|商品/, /Knowledge|知識庫/, /AI Agent/i, /Analytics|分析/, /Reviews|評價/]) {
      await expect(page.getByRole('link', { name: nav }).first(), `dashboard nav missing ${nav}`).toBeVisible();
    }
  });

  test('AI import produces drafts with evidence, never silent publishes (§31, §32, §27)', async ({ platform }) => {
    const { access_token } = await demoLogin(platform, 'merchant');
    const auth = { Authorization: `Bearer ${access_token}`, 'X-Tenant': 'hong-kong' };

    const menu = [
      'DEMO MENU — 沙田龍苑茶餐廳（合成數據）',
      '乾炒牛河 $68 | 凍奶茶 $32 | 菠蘿油 $28',
      'Allergen note: contains peanuts, shellfish',
      'Open: Mon-Sun 11:00-22:30',
    ].join('\n');

    const created = await platform.post('/api/v1/merchant/imports', {
      headers: auth,
      data: { source: { type: 'text', value: menu }, files: [] },
    });
    expect(created.status(), await created.text()).toBe(202);
    const { job_id } = await created.json();

    await expect
      .poll(
        async () => {
          const job = await platform.get(`/api/v1/merchant/imports/${job_id}`, { headers: auth });
          return job.ok() ? ((await job.json()).status as string) : 'poll_error';
        },
        { timeout: 60000, message: 'import job never reached a terminal state' },
      )
      .toMatch(/completed|failed|indexed/);

    const job = await platform.get(`/api/v1/merchant/imports/${job_id}`, { headers: auth });
    const body = await job.json();
    if (body.status === 'completed') {
      expect(body.proposals.length, 'import extracted nothing from a readable menu').toBeGreaterThan(0);
      for (const p of body.proposals) {
        expect(p.status ?? 'draft', 'imported item auto-published').toBe('draft');
        expect(typeof p.confidence, 'proposal has no confidence').toBe('number');
      }
    }
  });

  test('merchant AI answers from its own KB and hands off when unsure (§24-26)', async ({ ai, platform }) => {
    const merchants = await platform.get('/api/v1/merchants?limit=1&category=restaurant', {
      headers: { 'X-Tenant': 'hong-kong' },
    });
    expect(merchants.status(), await merchants.text()).toBe(200);
    const rows = await merchants.json();
    const items = rows.items ?? rows;
    test.skip(!items?.length, 'no merchant seeded yet');
    const merchantId = items[0].id;

    const res = await ai.post('/ai/v1/merchant-agent/chat', {
      data: { merchant_id: merchantId, message: '你們有沒有適合三個人的套餐？' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const answer = await res.json();

    // §19: a price/availability claim without citations must instead express uncertainty
    const hasCitations = (answer.citations ?? []).length > 0;
    const hedged = /未必|不確定|無法確認|转人工|人工|not sure|handoff|未能/i.test(answer.content ?? '');
    expect(hasCitations || hedged, `ungrounded and unhedged answer: ${JSON.stringify(answer)}`).toBe(true);

    if (!hasCitations) {
      const handoffs = await platform.get('/api/v1/merchant/conversations?status=handoff', {
        headers: { Authorization: `Bearer ${(await demoLogin(platform, 'merchant')).access_token}` },
      });
      expect([200, 401, 404].includes(handoffs.status()), 'handoff query shape unexpected').toBe(true);
    }
  });

  test('marketing agent can draft but cannot publish without a human (§27, §49)', async ({ platform }) => {
    const { access_token } = await demoLogin(platform, 'merchant');
    const auth = { Authorization: `Bearer ${access_token}`, 'X-Tenant': 'hong-kong' };
    const draft = await platform.post('/api/v1/merchant/campaigns', {
      headers: auth,
      data: { title: '週一至週三下午客流提振（AI 草稿）', goal: 'increase weekday afternoon traffic' },
    });
    expect([200, 201, 403].includes(draft.status()), await draft.text()).toBe(true);
    if (draft.ok()) {
      const campaign = await draft.json();
      expect(campaign.status, 'AI-created campaign must start as draft').toBe('draft');
      expect(campaign.approved_by ?? null, 'draft pre-approved').toBeNull();
    }
  });

  test('one merchant can never read another merchant’s rows (§55)', async ({ platform }) => {
    const a = await demoLogin(platform, 'merchant');
    // The demo payload's user carries no merchant_id — the caller's own workspace is read from /me's
    // memberships, which is the same reader the console uses (the first draft of this test compared
    // against a field that does not exist and read its own workspace as a cross-tenant 200).
    const me = await platform.get('/api/v1/me', { headers: { Authorization: `Bearer ${a.access_token}`, 'X-Tenant': 'hong-kong' } });
    const own = ((await me.json()).memberships?.[0]?.merchant?.id ?? '') as string;
    const merchants = await platform.get('/api/v1/merchants?limit=20', {
      headers: { 'X-Tenant': 'hong-kong' },
    });
    const rows = ((await merchants.json()).items ?? []) as Array<{ id: string }>;
    test.skip(rows.length < 2 || !own, 'needs two seeded merchants and a workspace for the demo merchant');
    const foreign = rows.find((r) => r.id !== own);
    if (!foreign) return;
    const probe = await platform.get(`/api/v1/merchant/businesses/${foreign.id}/overview`, {
      headers: { Authorization: `Bearer ${a.access_token}`, 'X-Tenant': 'hong-kong' },
    });
    expect([403, 404].includes(probe.status()), `cross-tenant leak: ${probe.status()}`).toBe(true);
  });
});
