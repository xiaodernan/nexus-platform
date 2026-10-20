/**
 * Server-side data plane for the merchant console (§23). Same split as `lib/data.ts`: pages never
 * fetch, this module decides between the `console-fixtures` catalogue and `nexusGet` reads against
 * the platform, and a failed live read comes back as a `failedRead` so the page can *show* the
 * failure instead of quietly serving fixtures (data.ts header: the §155 failure this layer exists
 * to prevent).
 *
 * Identity: there is no login page yet, so nothing here fabricates a session. `app/merchant/**`
 * decides "demo mode" vs "sign-in required" from the cookie in the page; this module only answers
 * the reads once that decision is made.
 */

import { IS_MOCK } from './env';
import { nexusGet } from './api/base';
import {
  analyticsEventSeries,
  analyticsProvidedFields,
  failedRead,
  okRead,
  IMPORT_CONFIDENCE_FLOOR,
  type AiAgentConfig,
  type ConsoleRead,
  type ImportJob,
  type ImportProposal,
  type KnowledgeDocument,
  type MerchantAnalytics,
  type MerchantAnalyticsPoint,
  type MerchantAnalyticsTotals,
  type MerchantApiKey,
  type MerchantCampaign,
  type MerchantConversationThread,
  type MerchantMember,
  type MerchantOfferingRow,
  type MerchantOverviewPayload,
  type MerchantReservation,
  type MerchantThreadDetail,
  type MerchantThreadMessage,
  type ReservationContact,
  type ReviewIntelligence,
  type ReviewIntelTheme,
} from './console-shared';
import { fixtureConversations, fixtureMerchantOverview } from './console-fixtures';
import { SEED_MERCHANTS, buildReviewSummary, type SeedMerchant } from './mock/seed';
import type { CursorPage, Money } from './types';

const OVERVIEW_SOURCE = 'GET /api/v1/merchant/businesses/{id}/overview';
const INBOX_SOURCE = 'GET /api/v1/merchant/conversations';

function reasonOf(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  return typeof code === 'string' ? code : 'upstream_unreachable';
}

/**
 * Per-business funnel overview (D15): platform-backed by `v_merchant_funnel`, and the payload
 * itself names its definition (`funnel_source`, `revenue_definition`) — the page renders those
 * strings rather than paraphrasing them, so a figure cannot outlive its definition.
 */
export async function merchantOverviewRead(businessId: string): Promise<ConsoleRead<MerchantOverviewPayload>> {
  const source = OVERVIEW_SOURCE.replace('{id}', businessId);
  if (IS_MOCK) {
    const data = fixtureMerchantOverview(businessId);
    if (!data) return failedRead({ source, errorCode: 'not_found' });
    return okRead({ data, origin: 'mock', source, asOf: data.computed_at, demo: true });
  }
  try {
    const data = await nexusGet<MerchantOverviewPayload>('platform', `/api/v1/merchant/businesses/${encodeURIComponent(businessId)}/overview`);
    return okRead({ data, origin: 'live', source, asOf: data.computed_at ?? null, demo: data.data_origin === 'demo' });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/**
 * The conversations inbox (§25/§26): threads with their handoff rows, newest first. An empty
 * inbox is its own honest state — the page renders "no conversations yet", never the fixture list.
 */
export async function merchantInboxRead(businessId: string): Promise<ConsoleRead<MerchantConversationThread[]>> {
  const source = `${INBOX_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const data = fixtureConversations(businessId);
    if (!data) return failedRead({ source, errorCode: 'not_found' });
    const asOf = data.reduce<string | null>(
      (latest, thread) => (thread.last_message_at && (!latest || thread.last_message_at > latest) ? thread.last_message_at : latest),
      null,
    );
    return okRead({ data, origin: 'mock', source, asOf, demo: true });
  }
  try {
    const page = await nexusGet<CursorPage<MerchantConversationThread>>('platform', '/api/v1/merchant/conversations', {
      searchParams: { merchant_id: businessId, limit: 20 },
    });
    const items = (page.items ?? []).map((thread) => ({ ...thread, demo: false }));
    const asOf = items.reduce<string | null>(
      (latest, thread) => (thread.last_message_at && (!latest || thread.last_message_at > latest) ? thread.last_message_at : latest),
      null,
    );
    return okRead({ data: items, origin: 'live', source, asOf, demo: false });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ====================================================================== */
/* §23 workspace reads — the rest of the merchant console                 */
/*                                                                        */
/* Contract gaps, stated where they are consumed rather than hidden:      */
/*  - §5 documents offering *writes* only, so the offerings list is the    */
/*    documented public menu projection (§4) for the same merchant id.    */
/*  - §5 documents `POST /merchant/campaigns` but **no list read**, so a   */
/*    console cannot show existing drafts; `CAMPAIGNS_SOURCE` names the    */
/*    route the read would need and the page shows the failure.            */
/*  - §5 documents `POST /merchant/ai-agent/config` but **no read** of the */
/*    current config, so the settings page cannot preload the switch.      */
/*  - §9 documents `GET /api/v1/admin/{users|merchants|orders|…}` but no   */
/*    controller serves them yet (the admin list family). Those reads      */
/*    degrade visibly in `console-admin.ts`.                               */
/* Every read degrades to a visible failure — no fixture backfill in live. */
/* ====================================================================== */

const OFFERINGS_SOURCE = 'GET /api/v1/merchants/{id}/menu';
/** Served since §34 by `MerchantContentController#reservationInbox` (§5/§23). */
const RESERVATIONS_SOURCE = 'GET /api/v1/merchant/reservations';
const THREAD_SOURCE = 'GET /api/v1/conversations/{id}';
const REVIEW_INTEL_SOURCE = 'GET /api/v1/merchants/{id}/reviews/summary';
/** GAP: §5 documents `POST /api/v1/merchant/campaigns` only. */
const CAMPAIGNS_SOURCE = 'GET /api/v1/merchant/campaigns';
const IMPORT_SOURCE = 'GET /api/v1/merchant/imports/{job_id}';
const ANALYTICS_SOURCE = 'GET /api/v1/merchant/analytics';
const MEMBERS_SOURCE = 'GET /api/v1/merchant/members';
/** GAP: §5 documents `POST /api/v1/merchant/ai-agent/config` only. */
const AGENT_CONFIG_SOURCE = 'GET /api/v1/merchant/ai-agent/config';
const KNOWLEDGE_SOURCE = 'GET /api/v1/merchant/knowledge-base';
/** GAP: §5 documents `POST /api/v1/merchant/api-keys` + `DELETE /{id}` only. */
const API_KEYS_SOURCE = 'GET /api/v1/merchant/api-keys';

/* --------------------------------------------------- wire narrowing helpers */

/**
 * Every field below is narrowed rather than cast: a wire payload that does not say something makes
 * the field `null`, and `null` renders as "not stated". This is the same rule `platform-catalog.ts`
 * applies to the consumer profile, kept local because these are operator shapes, not card shapes.
 */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function flag(value: unknown): boolean {
  return value === true;
}

function money(value: unknown): Money | null {
  const record = value as { amount?: unknown; currency?: unknown } | null;
  const amount = str(record?.amount);
  if (!amount) return null;
  return { amount, currency: str(record?.currency) ?? 'HKD' };
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
}

function zeroMoney(currency = 'HKD'): Money {
  return { amount: '0.00', currency };
}

/* ------------------------------------------------------------- mock fixtures */

function seedOf(businessId: string): SeedMerchant | null {
  return SEED_MERCHANTS.find((seed) => seed.id === businessId || seed.slug === businessId) ?? null;
}

function iso(now: Date, minutesAgo: number): string {
  return new Date(now.getTime() - minutesAgo * 60_000).toISOString();
}

function fixtureOfferings(seed: SeedMerchant): MerchantOfferingRow[] {
  return seed.offerings.map((offering, index) => ({
    id: `demo-offering-${seed.id}-${index + 1}`,
    slug: offering.slug,
    title: offering.title,
    kind: offering.kind,
    price: { amount: offering.price, currency: seed.currency },
    status: 'active',
    updated_at: iso(new Date(), 60 * 24 * (index + 1)),
    demo: true,
  }));
}

function fixtureReservations(seed: SeedMerchant, now: Date): MerchantReservation[] {
  if (!seed.seats) return [];
  const at = (hoursFromNow: number) => new Date(now.getTime() + hoursFromNow * 3_600_000).toISOString();
  const contact = (name: string, phone: string) => ({ name, phone, email: null });
  return [
    {
      id: 'demo-res-1',
      code: 'NX-RES-DEMO01',
      consumer_name: 'Demo Chan',
      offering_title: seed.offerings[0]?.title ?? null,
      party_size: 2,
      slot_start: at(3),
      status: 'requested',
      notes: '安静角落位（示例备注）',
      created_at: iso(now, 45),
      contact: contact('Demo Chan', '+852 9000 0001'),
      price: { amount: '376.00', currency: seed.currency },
      source: 'in_app',
      updated_at: iso(now, 45),
      demo: true,
    },
    {
      id: 'demo-res-2',
      code: 'NX-RES-DEMO02',
      consumer_name: 'Alex M.',
      offering_title: seed.offerings[0]?.title ?? null,
      party_size: 4,
      slot_start: at(5),
      status: 'confirmed',
      notes: null,
      created_at: iso(now, 180),
      contact: contact('Alex M.', '+852 9000 0002'),
      price: { amount: '752.00', currency: seed.currency },
      source: 'in_app',
      updated_at: iso(now, 120),
      demo: true,
    },
    {
      id: 'demo-res-3',
      code: 'NX-RES-DEMO03',
      consumer_name: '王女士',
      offering_title: seed.offerings[1]?.title ?? null,
      party_size: 3,
      slot_start: at(-1),
      status: 'seated',
      notes: null,
      created_at: iso(now, 300),
      contact: contact('王女士', '+852 9000 0003'),
      price: { amount: '564.00', currency: seed.currency },
      source: 'phone',
      updated_at: iso(now, 60),
      demo: true,
    },
    {
      id: 'demo-res-4',
      code: 'NX-RES-DEMO04',
      consumer_name: 'K. Chan',
      offering_title: seed.offerings[1]?.title ?? null,
      party_size: 6,
      slot_start: at(-6),
      status: 'completed',
      notes: null,
      created_at: iso(now, 900),
      contact: contact('K. Chan', '+852 9000 0004'),
      price: { amount: '1128.00', currency: seed.currency },
      source: 'in_app',
      updated_at: iso(now, 300),
      demo: true,
    },
    {
      id: 'demo-res-5',
      code: 'NX-RES-DEMO05',
      consumer_name: 'Mora L.',
      offering_title: seed.offerings[0]?.title ?? null,
      party_size: 2,
      slot_start: at(26),
      status: 'cancelled',
      notes: '客人取消（示例）',
      created_at: iso(now, 1_400),
      contact: contact('Mora L.', '+852 9000 0005'),
      price: { amount: '376.00', currency: seed.currency },
      source: 'in_app',
      updated_at: iso(now, 1_200),
      demo: true,
    },
  ];
}

function fixtureThreadDetail(seed: SeedMerchant, threadId: string, now: Date): MerchantThreadDetail {
  const isHandoff = threadId === 'demo-thread-1';
  const messages: MerchantThreadMessage[] = [
    {
      id: 'demo-msg-1',
      role: 'consumer',
      content: seed.seats ? '周六晚上 6 位可以订吗？' : '想问店裡有现货吗？',
      created_at: iso(now, 95),
      agent_run_id: null,
      fact_ids: [],
      degraded: false,
    },
    {
      id: 'demo-msg-2',
      role: 'assistant',
      content: seed.seats
        ? '周六 19:00 有 5 个位，可预订 6 位以內。需要我帮你看其他时段吗？'
        : '目前架上资料显示有货，实际库存以到店为准。',
      created_at: iso(now, 94),
      agent_run_id: 'demo-run-1',
      fact_ids: [],
      degraded: false,
    },
    {
      id: 'demo-msg-3',
      role: 'consumer',
      content: '可以帮我留安静一点的角落位吗？另外可以带蛋糕吗？',
      created_at: iso(now, 40),
      agent_run_id: null,
      fact_ids: [],
      degraded: false,
    },
    ...(isHandoff
      ? [
          {
            id: 'demo-msg-4',
            role: 'assistant',
            content: '这个问题涉及店内政策，我不确定答案，已转交店员回复。',
            created_at: iso(now, 39),
            agent_run_id: 'demo-run-2',
            fact_ids: [],
            degraded: true,
          },
        ]
      : []),
  ];
  return {
    id: threadId,
    status: isHandoff ? 'handoff' : 'open',
    mode: isHandoff ? 'hybrid' : 'ai',
    consumer_name: isHandoff ? 'Demo Chan' : 'Alex M.',
    messages,
    handoffs: isHandoff
      ? [{ id: 'demo-handoff-1', reason: 'low_confidence', status: 'open', created_at: iso(now, 40), resolved_at: null }]
      : [],
    demo: true,
  };
}

/**
 * The fixture summary is the *same* synthetic summary the consumer merchant page renders as demo
 * data (`buildReviewSummary`), not a second, more flattering one for the merchant's own screen.
 */
function fixtureReviewIntel(seed: SeedMerchant, now: Date): ReviewIntelligence {
  const summary = buildReviewSummary(seed, now);
  const themes: ReviewIntelTheme[] = (summary?.themes ?? []).map((theme) => ({
    label: theme.label,
    sentiment: theme.sentiment,
    mentions: theme.mentions,
    review_ids: theme.review_ids,
  }));
  const total = seed.ratingCount;
  const distribution: Record<string, number> = {
    '5': Math.round(total * 0.52),
    '4': Math.round(total * 0.28),
    '3': Math.round(total * 0.12),
    '2': Math.round(total * 0.05),
    '1': Math.max(0, total - Math.round(total * 0.97)),
  };
  return {
    summary: summary?.summary ?? null,
    themes,
    evidence_review_ids: summary?.evidence_review_ids ?? [],
    generated_at: summary?.generated_at ?? null,
    model: summary?.model ?? 'mock',
    published_reviews: seed.reviewSeed.length,
    average_rating: seed.ratingValue,
    distribution,
    provenance: { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:review', generated_at: summary?.generated_at ?? null },
    demo: true,
  };
}

function fixtureCampaigns(_seed: SeedMerchant, now: Date): MerchantCampaign[] {
  return [
    {
      id: 'demo-campaign-1',
      name: '週一至週三下午客流提升（AI 草案）',
      channel: 'in_app',
      status: 'draft',
      body: '週一至週三 14:00–17:00 到店，出示本頁即可享 9 折（示例草案，尚未发布）。',
      audience: '過去 90 天曾到店、且偏好下午時段的客人（示例分群）',
      provenance: { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:marketing', generated_at: iso(now, 150) },
      approved_by: null,
      published_at: null,
      created_at: iso(now, 150),
      evidence_fact_ids: [],
      demo: true,
    },
    {
      id: 'demo-campaign-2',
      name: '週末分享套餐推薦（AI 草案）',
      channel: 'whatsapp',
      status: 'draft',
      body: '週末限定分享套餐，4 人以上贈送甜品（示例草案）。',
      audience: '曾查詢 4 人以上訂位的客人（示例分群）',
      provenance: { generated_by_ai: true, reviewed_by_human: false, actor: 'ai:marketing', generated_at: iso(now, 300) },
      approved_by: null,
      published_at: null,
      created_at: iso(now, 300),
      evidence_fact_ids: [],
      demo: true,
    },
    {
      id: 'demo-campaign-3',
      name: '雨天到店優惠（已由人類核准）',
      channel: 'email',
      status: 'approved',
      body: '下雨天到店出示本頁享 95 折（示例，已由人類核准但未發布）。',
      audience: '全體訂閱者（示例）',
      provenance: { generated_by_ai: true, reviewed_by_human: true, actor: 'ai:marketing', generated_at: iso(now, 1_200) },
      approved_by: 'demo-owner',
      published_at: null,
      created_at: iso(now, 1_200),
      evidence_fact_ids: [],
      demo: true,
    },
    {
      id: 'demo-campaign-4',
      name: '店內自製海報文案',
      channel: 'offline',
      status: 'draft',
      body: '由店主自行撰寫的文案（非 AI 生成）。',
      audience: null,
      provenance: { generated_by_ai: false, reviewed_by_human: false, actor: 'merchant', generated_at: iso(now, 600) },
      approved_by: null,
      published_at: null,
      created_at: iso(now, 600),
      evidence_fact_ids: [],
      demo: true,
    },
  ];
}

function fixtureImportJob(seed: SeedMerchant, now: Date): ImportJob {
  const proposals: ImportProposal[] = [
    {
      id: 'demo-proposal-1',
      kind: 'product',
      name: `${seed.offerings[0]?.title ?? '招牌菜'}（由菜單解析）`,
      price: { amount: seed.offerings[0]?.price ?? '0.00', currency: seed.currency },
      category: seed.category,
      confidence: 0.93,
      evidence_fact_ids: [`demo-fact-${seed.id}-1`],
      source_span: '第 2 頁「招牌」欄',
    },
    {
      id: 'demo-proposal-2',
      kind: 'product',
      name: `${seed.offerings[1]?.title ?? '小食'}（由菜單解析）`,
      price: { amount: seed.offerings[1]?.price ?? '0.00', currency: seed.currency },
      category: seed.category,
      confidence: 0.71,
      evidence_fact_ids: [`demo-fact-${seed.id}-2`],
      source_span: '第 3 頁「小食」欄',
    },
    {
      id: 'demo-proposal-3',
      kind: 'service',
      name: '包場服務（低信度，需人手核對）',
      price: null,
      category: null,
      confidence: 0.42,
      evidence_fact_ids: [],
      source_span: '第 5 頁備註（文字模糊）',
    },
  ];
  return {
    job_id: 'demo-import-job-1',
    status: 'done',
    source_type: 'url',
    source_ref: `https://${seed.domain}/menu`,
    created_at: iso(now, 240),
    updated_at: iso(now, 210),
    documents: 1,
    chunks: 12,
    proposals,
    error: null,
    degraded: false,
    demo: true,
  };
}

function fixtureAnalytics(seed: SeedMerchant, from: string, to: string, metric: string, now: Date): MerchantAnalytics {
  const views = seed.ratingCount * 7 + 43;
  const clicks = Math.round(views * 0.24);
  const leads = Math.round(clicks * 0.19);
  const reservations = seed.seats ? Math.max(1, Math.round(leads * 0.6)) : 0;
  const orders = Math.max(1, leads - reservations);
  const unit = Number.parseFloat(seed.priceAmount ?? '0');
  const revenue = Number.isFinite(unit) ? unit * orders : 0;
  const days = 7;
  const points: MerchantAnalyticsPoint[] = Array.from({ length: days }, (_, index) => {
    const day = new Date(now.getTime() - (days - index - 1) * 86_400_000).toISOString().slice(0, 10);
    const share = (index + 1) / ((days * (days + 1)) / 2);
    return {
      date: day,
      views: Math.round(views * share),
      ai_impressions: Math.round(views * share * 0.35),
      search_appearances: Math.round(views * share * 0.62),
      clicks: Math.round(clicks * share),
      leads: Math.round(leads * share),
      reservations: Math.round(reservations * share),
      orders: Math.round(orders * share),
      repeat_customers: Math.round(orders * share * 0.18),
      revenue: { amount: (revenue * share).toFixed(2), currency: seed.currency },
    };
  });
  const totals: MerchantAnalyticsTotals = {
    views,
    ai_impressions: Math.round(views * 0.35),
    search_appearances: Math.round(views * 0.62),
    clicks,
    leads,
    reservations,
    orders,
    repeat_customers: Math.round(orders * 0.18),
    revenue: { amount: revenue.toFixed(2), currency: seed.currency },
  };
  return {
    from,
    to,
    metric,
    points,
    totals,
    definitions: {
      views: 'fixture projection: demo catalogue popularity × fixed multiplier — not real traffic',
      revenue: 'fixture projection: demo orders × demo average price — not real takings',
    },
    computed_at: now.toISOString(),
    data_origin: 'demo',
    degraded: false,
    provided: [
      'views',
      'ai_impressions',
      'search_appearances',
      'clicks',
      'leads',
      'reservations',
      'orders',
      'repeat_customers',
      'revenue',
    ],
    event_series: points.map((point) => ({ date: point.date, events: point.views })),
    window: { from, to, days, metric },
    source: 'fixture:console-merchant (deterministic projection of the demo catalogue)',
    note: 'Fixture projection — a demonstration of the windowed screen, not a measurement of real traffic (§109).',
  };
}

function fixtureMembers(seed: SeedMerchant, now: Date): MerchantMember[] {
  return [
    {
      id: 'demo-member-1',
      name: `${seed.name} 店主`,
      email: 'owner@example.hk',
      role: 'owner',
      permissions: ['write_profile', 'publish_listing', 'write_products', 'read_analytics', 'admin_members', 'publish_campaign'],
      status: 'active',
      created_at: iso(now, 60 * 24 * 90),
      demo: true,
    },
    {
      id: 'demo-member-2',
      name: '值班經理',
      email: 'manager@example.hk',
      role: 'manager',
      permissions: ['send_message', 'read_analytics', 'read_products'],
      status: 'active',
      created_at: iso(now, 60 * 24 * 30),
      demo: true,
    },
    {
      id: 'demo-member-3',
      name: 'AI Agent',
      email: null,
      role: 'ai_agent',
      permissions: ['read_products'],
      status: 'active',
      created_at: iso(now, 60 * 24 * 20),
      demo: true,
    },
  ];
}

function fixtureAgentConfig(seed: SeedMerchant, now: Date): AiAgentConfig {
  return {
    enabled: true,
    greeting: `你好，這裡是${seed.name}，請問有咩可以幫到你？`,
    tone: 'friendly',
    handoff_threshold: 0.55,
    languages: ['zh-HK', 'en'],
    outside_hours_message: '我們現在休息中，請留下需求，開店後會盡快回覆。',
    updated_at: iso(now, 60 * 24 * 3),
    updated_by: 'demo-owner',
    demo: true,
  };
}

function fixtureApiKeys(seed: SeedMerchant, now: Date): MerchantApiKey[] {
  return [
    {
      id: 'demo-key-1',
      label: `${seed.name} POS 同步`,
      prefix: 'nxk_demo_1a2b',
      scopes: ['read_products', 'write_products'],
      created_at: iso(now, 60 * 24 * 40),
      last_used_at: iso(now, 90),
      revoked_at: null,
      demo: true,
    },
    {
      id: 'demo-key-2',
      label: '報表工具（已撤銷）',
      prefix: 'nxk_demo_9z8y',
      scopes: ['read_analytics'],
      created_at: iso(now, 60 * 24 * 60),
      last_used_at: iso(now, 60 * 24 * 12),
      revoked_at: iso(now, 60 * 24 * 10),
      demo: true,
    },
  ];
}

/* ---------------------------------------------------------------- offerings */

interface WireOfferingRow {
  id?: unknown;
  slug?: unknown;
  title?: unknown;
  name?: unknown;
  kind?: unknown;
  price?: unknown;
  avg_price?: unknown;
  status?: unknown;
  updated_at?: unknown;
  data_origin?: unknown;
}

function toOfferingRow(row: WireOfferingRow): MerchantOfferingRow | null {
  const id = str(row.id);
  const title = str(row.title) ?? str(row.name);
  if (!id || !title) return null;
  return {
    id,
    slug: str(row.slug),
    title,
    kind: str(row.kind) ?? 'product',
    price: money(row.price) ?? money(row.avg_price),
    status: str(row.status),
    updated_at: str(row.updated_at),
    demo: row.data_origin === 'demo',
  };
}

/** §23 products/services list. GAP: §5 documents offering writes only, so this is the §4 menu read. */
export async function merchantOfferingsRead(businessId: string): Promise<ConsoleRead<MerchantOfferingRow[]>> {
  const source = OFFERINGS_SOURCE.replace('{id}', businessId);
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureOfferings(seed);
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const page = await nexusGet<CursorPage<WireOfferingRow>>('platform', `/api/v1/merchants/${encodeURIComponent(businessId)}/menu`, {
      searchParams: { limit: 50 },
    });
    const data = (page.items ?? []).map(toOfferingRow).filter((row): row is MerchantOfferingRow => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------- reservations */

interface WireReservation {
  id?: unknown;
  reservation_id?: unknown;
  code?: unknown;
  consumer_name?: unknown;
  customer_name?: unknown;
  offering_title?: unknown;
  party_size?: unknown;
  slot_start?: unknown;
  starts_at?: unknown;
  status?: unknown;
  notes?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  source?: unknown;
  price?: unknown;
  contact?: unknown;
  data_origin?: unknown;
}

/** The guest contact block from `GET /api/v1/merchant/reservations` (§5); each field may be absent. */
function toContact(value: unknown): ReservationContact | null {
  const record = value as { name?: unknown; phone?: unknown; email?: unknown } | null;
  if (!record || typeof record !== 'object') return null;
  const name = str(record.name);
  const phone = str(record.phone);
  const email = str(record.email);
  if (!name && !phone && !email) return null;
  return { name, phone, email };
}

function toReservation(row: WireReservation): MerchantReservation | null {
  const id = str(row.reservation_id) ?? str(row.id);
  if (!id) return null;
  return {
    id,
    code: str(row.code),
    consumer_name: str(row.consumer_name) ?? str(row.customer_name),
    offering_title: str(row.offering_title),
    party_size: num(row.party_size),
    slot_start: str(row.slot_start) ?? str(row.starts_at),
    status: str(row.status) ?? 'requested',
    notes: str(row.notes),
    created_at: str(row.created_at),
    contact: toContact(row.contact),
    price: money(row.price),
    source: str(row.source),
    updated_at: str(row.updated_at),
    demo: row.data_origin === 'demo',
  };
}

/** §23 today's bookings. GAP: §5 has no merchant reservations read — see RESERVATIONS_SOURCE. */
export async function merchantReservationsRead(businessId: string): Promise<ConsoleRead<MerchantReservation[]>> {
  const source = `${RESERVATIONS_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureReservations(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const page = await nexusGet<CursorPage<WireReservation>>('platform', '/api/v1/merchant/reservations', {
      searchParams: { merchant_id: businessId, limit: 50 },
    });
    const data = (page.items ?? []).map(toReservation).filter((row): row is MerchantReservation => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------ thread detail */

interface WireMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  text?: unknown;
  created_at?: unknown;
  agent_run_id?: unknown;
  fact_ids?: unknown;
  degraded?: unknown;
}

function toMessage(row: WireMessage, index: number): MerchantThreadMessage | null {
  const content = str(row.content) ?? str(row.text);
  if (content === null) return null;
  const role = str(row.role) ?? 'unknown';
  return {
    id: str(row.id) ?? `${role}-${index}`,
    role,
    content,
    created_at: str(row.created_at),
    agent_run_id: str(row.agent_run_id),
    fact_ids: strList(row.fact_ids),
    degraded: flag(row.degraded),
  };
}

/**
 * One conversation with its turns (§7 `GET /api/v1/conversations/{id}`). The read is keyed on the
 * conversation id alone, so a thread the merchant does not own is the platform's 403/404 to return,
 * not something this layer guesses at.
 */
export async function merchantThreadRead(threadId: string): Promise<ConsoleRead<MerchantThreadDetail>> {
  const source = THREAD_SOURCE.replace('{id}', threadId);
  if (IS_MOCK) {
    const seed = seedOf(threadId) ?? SEED_MERCHANTS[0];
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureThreadDetail(seed, threadId, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const payload = await nexusGet<{
      conversation?: { id?: unknown; status?: unknown; mode?: unknown; consumer_name?: unknown; data_origin?: unknown };
      messages?: unknown;
      handoffs?: unknown;
      id?: unknown;
      status?: unknown;
      mode?: unknown;
      consumer_name?: unknown;
      data_origin?: unknown;
    }>('platform', `/api/v1/conversations/${encodeURIComponent(threadId)}`);
    const conversation = payload.conversation ?? payload;
    const messages = rows(payload.messages)
      .map((row, index) => toMessage(row, index))
      .filter((row): row is MerchantThreadMessage => row !== null);
    const handoffs = rows(payload.handoffs).map((row) => ({
      id: str(row.id) ?? '',
      reason: str(row.reason),
      status: str(row.status),
      created_at: str(row.created_at),
      resolved_at: str(row.resolved_at),
    }));
    const data: MerchantThreadDetail = {
      id: str(conversation.id) ?? threadId,
      status: str(conversation.status) ?? 'open',
      mode: str(conversation.mode) ?? 'ai',
      consumer_name: str(conversation.consumer_name),
      messages,
      handoffs,
      demo: conversation.data_origin === 'demo',
    };
    return okRead({ data, origin: 'live', source, asOf: data.messages.at(-1)?.created_at ?? null, demo: data.demo });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------- review intelligence §54/55 */

interface WireReviewIntel {
  summary?: unknown;
  themes?: unknown;
  evidence_review_ids?: unknown;
  generated_at?: unknown;
  model?: unknown;
  review_stats?: { published_reviews?: unknown; average_rating?: unknown; distribution?: unknown };
  published_reviews?: unknown;
  average_rating?: unknown;
  distribution?: unknown;
  generated_by_ai?: unknown;
  reviewed_by_human?: unknown;
  data_origin?: unknown;
}

function toReviewIntel(payload: WireReviewIntel): ReviewIntelligence {
  const stats = payload.review_stats ?? {};
  const themes: ReviewIntelTheme[] = rows(payload.themes).map((row) => {
    const sentiment = str(row.sentiment);
    return {
      label: str(row.label) ?? str(row.theme) ?? '(unlabelled)',
      sentiment: sentiment === 'positive' || sentiment === 'negative' ? sentiment : 'neutral',
      mentions: num(row.mentions) ?? 0,
      review_ids: strList(row.review_ids),
    };
  });
  const distribution: Record<string, number> = {};
  const rawDistribution = payload.distribution ?? stats.distribution;
  if (rawDistribution && typeof rawDistribution === 'object' && !Array.isArray(rawDistribution)) {
    for (const [key, value] of Object.entries(rawDistribution as Record<string, unknown>)) {
      const count = num(value);
      if (count !== null) distribution[key] = count;
    }
  }
  return {
    summary: str(payload.summary),
    themes,
    evidence_review_ids: strList(payload.evidence_review_ids),
    generated_at: str(payload.generated_at),
    model: str(payload.model),
    published_reviews: num(payload.published_reviews) ?? num(stats.published_reviews),
    average_rating: num(payload.average_rating) ?? num(stats.average_rating),
    distribution,
    provenance: {
      generated_by_ai: payload.generated_by_ai !== false,
      reviewed_by_human: flag(payload.reviewed_by_human),
      actor: str(payload.model) ? `ai:review:${String(payload.model)}` : 'ai:review',
      generated_at: str(payload.generated_at),
    },
    demo: payload.data_origin === 'demo',
  };
}

/**
 * §54/§55 review intelligence. A 404 (`review_summary_not_found`) means the review agent has not
 * run — that is a real state, and the page renders it as "no summary yet" rather than as a failure
 * of the reviews themselves, so the caller gets the code and decides.
 */
export async function merchantReviewIntelRead(merchantId: string): Promise<ConsoleRead<ReviewIntelligence>> {
  const source = REVIEW_INTEL_SOURCE.replace('{id}', merchantId);
  if (IS_MOCK) {
    const seed = seedOf(merchantId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureReviewIntel(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: data.generated_at, demo: true });
  }
  try {
    const payload = await nexusGet<WireReviewIntel>('platform', `/api/v1/merchants/${encodeURIComponent(merchantId)}/reviews/summary`);
    const data = toReviewIntel(payload);
    return okRead({ data, origin: 'live', source, asOf: data.generated_at, demo: data.demo });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* -------------------------------------------------------------- campaigns §27 */

interface WireCampaign {
  id?: unknown;
  name?: unknown;
  title?: unknown;
  channel?: unknown;
  status?: unknown;
  body?: unknown;
  content?: unknown;
  audience?: unknown;
  segment?: unknown;
  generated_by_ai?: unknown;
  reviewed_by_human?: unknown;
  actor?: unknown;
  approved_by?: unknown;
  published_at?: unknown;
  created_at?: unknown;
  evidence_fact_ids?: unknown;
  data_origin?: unknown;
}

function toCampaign(row: WireCampaign): MerchantCampaign | null {
  const id = str(row.id);
  if (!id) return null;
  return {
    id,
    name: str(row.name) ?? str(row.title) ?? '(untitled draft)',
    channel: str(row.channel) ?? 'unknown',
    status: str(row.status) ?? 'draft',
    body: str(row.body) ?? str(row.content),
    audience: str(row.audience) ?? str(row.segment),
    provenance: {
      generated_by_ai: flag(row.generated_by_ai),
      reviewed_by_human: flag(row.reviewed_by_human),
      actor: str(row.actor),
      generated_at: str(row.created_at),
    },
    approved_by: str(row.approved_by),
    published_at: str(row.published_at),
    created_at: str(row.created_at),
    evidence_fact_ids: strList(row.evidence_fact_ids),
    demo: row.data_origin === 'demo',
  };
}

/** §27 campaign drafts. GAP: §5 documents the create and approve-publish writes, not this list. */
export async function merchantCampaignsRead(businessId: string): Promise<ConsoleRead<MerchantCampaign[]>> {
  const source = `${CAMPAIGNS_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureCampaigns(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const page = await nexusGet<CursorPage<WireCampaign>>('platform', '/api/v1/merchant/campaigns', {
      searchParams: { merchant_id: businessId, limit: 50 },
    });
    const data = (page.items ?? []).map(toCampaign).filter((row): row is MerchantCampaign => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ----------------------------------------------------------- import job §22 */

interface WireImportProposal {
  id?: unknown;
  offering_draft?: { name?: unknown; title?: unknown; price?: unknown; currency?: unknown; category?: unknown; kind?: unknown };
  kind?: unknown;
  name?: unknown;
  title?: unknown;
  price?: unknown;
  currency?: unknown;
  category?: unknown;
  confidence?: unknown;
  evidence_fact_ids?: unknown;
  source_span?: unknown;
}

function toProposal(row: WireImportProposal, index: number): ImportProposal {
  const draft = row.offering_draft ?? {};
  const priceAmount = num(draft.price) ?? num(row.price);
  const currency = str(draft.currency) ?? str(row.currency) ?? 'HKD';
  return {
    id: str(row.id) ?? `proposal-${index}`,
    kind: str(draft.kind) ?? str(row.kind) ?? 'product',
    name: str(draft.name) ?? str(draft.title) ?? str(row.name) ?? str(row.title) ?? '(unnamed proposal)',
    price: priceAmount === null ? null : { amount: String(priceAmount), currency },
    category: str(draft.category) ?? str(row.category),
    confidence: num(row.confidence),
    evidence_fact_ids: strList(row.evidence_fact_ids),
    source_span: str(row.source_span),
  };
}

interface WireImportJob {
  job_id?: unknown;
  id?: unknown;
  status?: unknown;
  source?: { type?: unknown; value?: unknown };
  source_type?: unknown;
  source_ref?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  documents?: unknown;
  chunks?: unknown;
  proposals?: unknown;
  error?: unknown;
  degraded?: unknown;
  data_origin?: unknown;
}

function toImportJob(payload: WireImportJob): ImportJob {
  const documents = num(payload.documents);
  return {
    job_id: str(payload.job_id) ?? str(payload.id) ?? '',
    status: str(payload.status) ?? 'queued',
    source_type: str(payload.source?.type) ?? str(payload.source_type),
    source_ref: str(payload.source?.value) ?? str(payload.source_ref),
    created_at: str(payload.created_at),
    updated_at: str(payload.updated_at),
    documents,
    chunks: num(payload.chunks),
    proposals: rows(payload.proposals).map((row, index) => toProposal(row, index)),
    error: str(payload.error),
    degraded: flag(payload.degraded),
    demo: payload.data_origin === 'demo',
  };
}

/** §22 import job status + proposals. Nothing here publishes anything — proposals are proposals. */
export async function merchantImportJobRead(jobId: string): Promise<ConsoleRead<ImportJob>> {
  const source = IMPORT_SOURCE.replace('{job_id}', jobId);
  if (IS_MOCK) {
    const seed = seedOf(jobId) ?? SEED_MERCHANTS[0];
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = { ...fixtureImportJob(seed, new Date()), job_id: jobId };
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: data.updated_at, demo: true });
  }
  try {
    const data = toImportJob(await nexusGet<WireImportJob>('platform', `/api/v1/merchant/imports/${encodeURIComponent(jobId)}`));
    return okRead({ data, origin: 'live', source, asOf: data.updated_at, demo: data.demo });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------- knowledge base §24–26, §52 */

interface WireKnowledgeDocument {
  document_id?: unknown;
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  source_uri?: unknown;
  mime_type?: unknown;
  lang?: unknown;
  status?: unknown;
  error?: unknown;
  chunk_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  data_origin?: unknown;
}

function toKnowledgeDocument(row: WireKnowledgeDocument): KnowledgeDocument | null {
  const id = str(row.document_id) ?? str(row.id);
  if (!id) return null;
  return {
    id,
    kind: str(row.kind),
    title: str(row.title),
    source_uri: str(row.source_uri),
    mime_type: str(row.mime_type),
    lang: str(row.lang),
    status: str(row.status) ?? 'unknown',
    error: str(row.error),
    chunk_count: num(row.chunk_count),
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    demo: row.data_origin === 'demo',
  };
}

function fixtureKnowledge(seed: SeedMerchant, now: Date): KnowledgeDocument[] {
  const base = [
    { title: `${seed.name} 官方網站`, kind: 'website', uri: `https://${seed.domain}/`, status: 'indexed', chunks: 12 },
    { title: '菜單 PDF（2026 春季）', kind: 'menu', uri: `https://${seed.domain}/menu.pdf`, status: 'indexed', chunks: 24 },
    { title: '常見問題（人手整理）', kind: 'faq', uri: null, status: 'pending', chunks: 0 },
  ];
  return base.map((entry, index) => ({
    id: `demo-doc-${seed.id}-${index + 1}`,
    kind: entry.kind,
    title: entry.title,
    source_uri: entry.uri,
    mime_type: entry.kind === 'website' ? 'text/html' : entry.kind === 'menu' ? 'application/pdf' : 'text/plain',
    lang: index === 2 ? 'zh-HK' : null,
    status: entry.status,
    error: null,
    chunk_count: entry.chunks,
    created_at: iso(now, 60 * 24 * (index + 4)),
    updated_at: iso(now, 60 * 24 * (index + 1)),
    demo: true,
  }));
}

/**
 * §24–26 the knowledge base the AI agent answers from. The read reports document rows and chunk
 * counts and **never** chunk text (§52: `nexus_ai` is the only writer of `chunks.embedding`), so the
 * console shows what is indexed and what is merely queued — it cannot show, or claim, more.
 */
export async function merchantKnowledgeRead(businessId: string): Promise<ConsoleRead<KnowledgeDocument[]>> {
  const source = `${KNOWLEDGE_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureKnowledge(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const page = await nexusGet<CursorPage<WireKnowledgeDocument>>('platform', '/api/v1/merchant/knowledge-base', {
      searchParams: { merchant_id: businessId, limit: 50 },
    });
    const data = (page.items ?? []).map(toKnowledgeDocument).filter((row): row is KnowledgeDocument => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------ analytics §56 */
interface WireAnalyticsPoint extends Record<string, unknown> {
  date?: unknown;
  revenue?: unknown;
}

interface WireAnalytics {
  from?: unknown;
  to?: unknown;
  metric?: unknown;
  window?: unknown;
  metrics?: unknown;
  points?: unknown;
  totals?: unknown;
  series?: unknown;
  definitions?: unknown;
  computed_at?: unknown;
  as_of?: unknown;
  data_origin?: unknown;
  degraded?: unknown;
  source?: unknown;
  note?: unknown;
}

const ANALYTICS_COUNT_FIELDS = [
  'views',
  'ai_impressions',
  'search_appearances',
  'clicks',
  'leads',
  'reservations',
  'orders',
  'repeat_customers',
] as const;

function toTotals(source: Record<string, unknown> | null, fallbackCurrency = 'HKD'): MerchantAnalyticsTotals {
  const record = source ?? {};
  return {
    views: num(record.views) ?? 0,
    ai_impressions: num(record.ai_impressions) ?? 0,
    search_appearances: num(record.search_appearances) ?? 0,
    clicks: num(record.clicks) ?? 0,
    leads: num(record.leads) ?? 0,
    reservations: num(record.reservations) ?? 0,
    orders: num(record.orders) ?? 0,
    repeat_customers: num(record.repeat_customers) ?? 0,
    revenue: money(record.revenue) ?? zeroMoney(fallbackCurrency),
  };
}

/**
 * §56 analytics. A count the payload omits is 0 because the platform computes these from the event
 * stream — "no events" and "zero events" are the same number. Money is the exception: it keeps the
 * §1 shape and defaults to a zero in the stated currency rather than to a bare 0.
 */
export async function merchantAnalyticsRead(
  businessId: string,
  range: { from: string; to: string; metric: string },
): Promise<ConsoleRead<MerchantAnalytics>> {
  const source = `${ANALYTICS_SOURCE}?from=${range.from}&to=${range.to}&metric=${range.metric}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureAnalytics(seed, range.from, range.to, range.metric, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: data.computed_at, demo: true });
  }
  try {
    const payload = await nexusGet<WireAnalytics>('platform', '/api/v1/merchant/analytics', {
      searchParams: { from: range.from, to: range.to, metric: range.metric, merchant_id: businessId },
    });
    // The served read reports `metrics` (six totals) + `series` (events per day) + `window`, and no
    // per-metric time series. `provided` records exactly which totals the payload carried so the page
    // can print "—" for one it did not measure instead of a fabricated 0 (§19/§109).
    const metricsRecord = (payload.metrics as Record<string, unknown> | null) ?? null;
    const windowRecord = (payload.window as Record<string, unknown> | null) ?? null;
    const points: MerchantAnalyticsPoint[] = rows(payload.points).map((row) => {
      const point = row as WireAnalyticsPoint;
      return { date: str(point.date) ?? '', ...toTotals(point) };
    });
    const eventSeries = analyticsEventSeries(rows(payload.series));
    const data: MerchantAnalytics = {
      from: str(windowRecord?.from) ?? str(payload.from) ?? range.from,
      to: str(windowRecord?.to) ?? str(payload.to) ?? range.to,
      metric: str(windowRecord?.metric) ?? str(payload.metric) ?? range.metric,
      points,
      totals: toTotals(metricsRecord ?? rows(payload.totals)[0] ?? (payload.totals as Record<string, unknown> | null)),
      definitions: Object.fromEntries(
        Object.entries((payload.definitions as Record<string, unknown> | null) ?? {})
          .map(([key, value]) => [key, str(value)])
          .filter((entry): entry is [string, string] => entry[1] !== null),
      ),
      computed_at: str(payload.computed_at) ?? str(payload.as_of),
      data_origin: str(payload.data_origin) ?? 'live',
      degraded: flag(payload.degraded),
      provided: metricsRecord ? analyticsProvidedFields(metricsRecord) : [],
      event_series: eventSeries,
      window: windowRecord
        ? {
            from: str(windowRecord.from) ?? range.from,
            to: str(windowRecord.to) ?? range.to,
            days: num(windowRecord.days) ?? 0,
            metric: str(windowRecord.metric) ?? range.metric,
          }
        : null,
      source: str(payload.source),
      note: str(payload.note),
    };
    return okRead({ data, origin: 'live', source, asOf: data.computed_at, demo: data.data_origin === 'demo' });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/* ------------------------------------------------------------- settings §5 */

interface WireMember {
  id?: unknown;
  member_id?: unknown;
  name?: unknown;
  display_name?: unknown;
  email?: unknown;
  role?: unknown;
  permissions?: unknown;
  status?: unknown;
  created_at?: unknown;
  joined_at?: unknown;
  data_origin?: unknown;
}

function toMember(row: WireMember): MerchantMember | null {
  const id = str(row.member_id) ?? str(row.id);
  if (!id) return null;
  return {
    id,
    name: str(row.display_name) ?? str(row.name),
    email: str(row.email),
    role: str(row.role) ?? 'staff',
    permissions: strList(row.permissions),
    status: str(row.status),
    created_at: str(row.joined_at) ?? str(row.created_at),
    demo: row.data_origin === 'demo',
  };
}

/** §5/§48 team members. The served read answers `{members:[...]}`, not a §1 `Paging` envelope. */
export async function merchantMembersRead(businessId: string): Promise<ConsoleRead<MerchantMember[]>> {
  const source = `${MEMBERS_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureMembers(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const payload = await nexusGet<{ members?: unknown; items?: unknown }>('platform', '/api/v1/merchant/members', {
      searchParams: { merchant_id: businessId },
    });
    const data = rows(payload.members ?? payload.items)
      .map((row) => toMember(row as WireMember))
      .filter((row): row is MerchantMember => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/** GAP: §5 documents `POST /merchant/ai-agent/config` but no read of the current config. */
export async function merchantAgentConfigRead(businessId: string): Promise<ConsoleRead<AiAgentConfig>> {
  const source = `${AGENT_CONFIG_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureAgentConfig(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: data.updated_at, demo: true });
  }
  try {
    const payload = await nexusGet<Record<string, unknown>>('platform', '/api/v1/merchant/ai-agent/config', {
      searchParams: { merchant_id: businessId },
    });
    const data: AiAgentConfig = {
      enabled: flag(payload.enabled),
      greeting: str(payload.greeting) ?? '',
      tone: str(payload.tone) ?? '',
      handoff_threshold: num(payload.handoff_threshold),
      languages: strList(payload.languages),
      outside_hours_message: str(payload.outside_hours_message) ?? '',
      updated_at: str(payload.updated_at),
      updated_by: str(payload.updated_by),
      demo: payload.data_origin === 'demo',
    };
    return okRead({ data, origin: 'live', source, asOf: data.updated_at, demo: data.demo });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

/** §5 key list. The served read answers `{api_keys:[...]}`; only a prefix is ever returned. */
export async function merchantApiKeysRead(businessId: string): Promise<ConsoleRead<MerchantApiKey[]>> {
  const source = `${API_KEYS_SOURCE}?merchant_id=${businessId}`;
  if (IS_MOCK) {
    const seed = seedOf(businessId);
    if (!seed) return failedRead({ source, errorCode: 'not_found' });
    const data = fixtureApiKeys(seed, new Date());
    return okRead({ data, origin: 'mock', source: `${source} (fixtures)`, asOf: new Date().toISOString(), demo: true });
  }
  try {
    const payload = await nexusGet<{ api_keys?: unknown; items?: unknown }>('platform', '/api/v1/merchant/api-keys', {
      searchParams: { merchant_id: businessId },
    });
    const data = rows(payload.api_keys ?? payload.items)
      .map((row) => {
        const id = str(row.api_key_id) ?? str(row.id) ?? str(row.key_id);
        if (!id) return null;
        return {
          id,
          label: str(row.name) ?? str(row.label) ?? '(unlabelled key)',
          prefix: str(row.prefix) ?? str(row.key_prefix),
          scopes: strList(row.scopes),
          created_at: str(row.created_at),
          last_used_at: str(row.last_used_at),
          revoked_at: str(row.revoked_at),
          demo: row.data_origin === 'demo',
        } satisfies MerchantApiKey;
      })
      .filter((row): row is MerchantApiKey => row !== null);
    return okRead({ data, origin: 'live', source, asOf: null, demo: data.some((row) => row.demo) });
  } catch (cause) {
    return failedRead({ source, errorCode: reasonOf(cause), requestId: (cause as { requestId?: string }).requestId ?? null });
  }
}

export { ANALYTICS_COUNT_FIELDS, IMPORT_CONFIDENCE_FLOOR };

export type {
  AiAgentConfig,
  ConsoleRead,
  ImportJob,
  ImportProposal,
  KnowledgeDocument,
  MerchantAnalytics,
  MerchantApiKey,
  MerchantCampaign,
  MerchantConversationThread,
  MerchantMember,
  MerchantOfferingRow,
  MerchantOverviewPayload,
  MerchantReservation,
  MerchantThreadDetail,
  ReviewIntelligence,
};
