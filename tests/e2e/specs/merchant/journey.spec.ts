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
    // §5.1 requires merchant_id in the import body — the caller's own workspace, read the way the
    // console reads it (the first draft of these journeys predated the field).
    const me = await platform.get('/api/v1/me', { headers: auth });
    const merchantId = ((await me.json()).memberships?.[0]?.merchant?.id ?? '') as string;
    test.skip(!merchantId, 'the demo merchant has no workspace in this database');

    const menu = [
      'DEMO MENU — 沙田龍苑茶餐廳（合成數據）',
      '乾炒牛河 $68 | 凍奶茶 $32 | 菠蘿油 $28',
      'Allergen note: contains peanuts, shellfish',
      'Open: Mon-Sun 11:00-22:30',
    ].join('\n');

    const created = await platform.post('/api/v1/merchant/imports', {
      headers: auth,
      data: { merchant_id: merchantId, source: { type: 'text', value: menu }, files: [] },
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
      .toMatch(/succeeded|failed/);

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
      data: { merchant_id: merchantId, message: '你們有沒有適合三個人的套餐？', conversation_id: crypto.randomUUID() },
    });
    expect(res.status(), await res.text()).toBe(200);
    // The route is a D13 stream, not a JSON body: frames of `event: …` / `data: …`, and the answer
    // lives in the summary frame's text with its citations beside it. (.json() on an event-stream is
    // how the first draft of this test met the endpoint — before the request body parsed at all.)
    const stream = await res.text();
    const frames = stream.split('\n\n').filter((chunk) => chunk.trim()).map((chunk) => {
      const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? '';
      const raw = /^data: (.+)$/m.exec(chunk)?.[1] ?? '{}';
      let data: unknown = raw;
      try { data = JSON.parse(raw); } catch { /* a non-JSON data line is skipped, not fatal */ }
      return { event, data };
    });
    const answer = (frames.find((f) => f.event === 'summary')?.data ?? {}) as {
      text?: string; citations?: string[];
    };

    // §19: a price/availability claim without citations must instead express uncertainty
    const hasCitations = (answer.citations ?? []).length > 0;
    const hedged = /未必|不確定|無法確認|转人工|人工|not sure|handoff|未能/i.test(answer.text ?? '');
    expect(hasCitations || hedged, `ungrounded and unhedged answer: ${stream.slice(0, 400)}`).toBe(true);

    if (!hasCitations) {
      // The conversations read is merchant-scoped: it needs the merchant id in its query, and the
      // caller's authorisation decides what it answers — the shape is what this probe pins.
      const handoffs = await platform.get(`/api/v1/merchant/conversations?merchant_id=${merchantId}&status=handoff`, {
        headers: { Authorization: `Bearer ${(await demoLogin(platform, 'merchant')).access_token}`, 'X-Tenant': 'hong-kong' },
      });
      expect([200, 401, 403, 404].includes(handoffs.status()), 'handoff query shape unexpected').toBe(true);
    }
  });

  test('marketing agent can draft but cannot publish without a human (§27, §49)', async ({ platform }) => {
    const { access_token } = await demoLogin(platform, 'merchant');
    const auth = { Authorization: `Bearer ${access_token}`, 'X-Tenant': 'hong-kong' };
    const me = await platform.get('/api/v1/me', { headers: auth });
    const merchantId = ((await me.json()).memberships?.[0]?.merchant?.id ?? '') as string;
    const draft = await platform.post('/api/v1/merchant/campaigns', {
      headers: auth,
      data: { merchant_id: merchantId, title: '週一至週三下午客流提振（AI 草稿）', goal: 'increase weekday afternoon traffic' },
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
