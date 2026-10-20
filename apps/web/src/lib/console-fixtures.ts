/**
 * Console fixture catalogue — the mock half of §23/§27/§47. Lives beside (never inside) the
 * consumer catalogue in `mock/index.ts` because the console payloads mirror *platform* controller
 * responses (`MerchantOverviewController`, `ConversationService.merchantInbox`), not wire types the
 * consumer pages read.
 *
 * Everything here is synthetic and `demo: true` (§109, §155): the numbers are deterministic
 * projections of the seed catalogue — the same ratings and prices the consumer pages already show
 * as demo data — multiplied by fixed constants. A revenue figure on this page is a projection of a
 * projection, which is exactly why the console stamps it `fixture:` and badges it 示例数据 instead
 * of letting it look like a live `v_merchant_funnel` row.
 */

import { SEED_MERCHANTS, DEMO_GUIDES, type SeedMerchant } from './mock/seed';
import type {
  ListingDraft,
  MerchantConversationThread,
  MerchantOverviewPayload,
  ReviewQueueItem,
} from './console-shared';

/** The demo identity shown when no `?business=` is picked; first seed merchant, by construction. */
export const DEMO_CONSOLE_BUSINESS = 'm-lung-yuen';

/** A merchant with an empty inbox — the §155 "no data yet" case must stay reachable in mock mode. */
export const DEMO_CONSOLE_EMPTY_INBOX = 'm-petal-tea';

export interface ConsoleBusinessChoice {
  id: string;
  slug: string;
  name: string;
}

export function consoleDemoBusinesses(): ConsoleBusinessChoice[] {
  return SEED_MERCHANTS.map((seed) => ({ id: seed.id, slug: seed.slug, name: seed.name }));
}

function findSeed(id: string): SeedMerchant | null {
  return SEED_MERCHANTS.find((seed) => seed.id === id || seed.slug === id) ?? null;
}

/**
 * Deterministic funnel projection: `ratingCount` is the demo catalogue's own popularity proxy, and
 * the multipliers are fixed so a reload never "grows" a merchant's numbers (§109: the demo must be
 * stable, or it becomes noise dressed as a trend). Revenue is projected orders × the demo price.
 */
export function fixtureMerchantOverview(businessId: string, now: Date = new Date()): MerchantOverviewPayload | null {
  const seed = findSeed(businessId);
  if (!seed) return null;
  const views = seed.ratingCount * 7 + 43;
  const clicks = Math.round(views * 0.24);
  const actions = Math.round(clicks * 0.19);
  const reservations = seed.seats ? Math.max(1, Math.round(actions * 0.6)) : 0;
  const orders = Math.max(1, actions - reservations);
  const unitPrice = Number.parseFloat(seed.priceAmount ?? '0');
  const revenue = Number.isFinite(unitPrice) ? unitPrice * orders : 0;
  return {
    merchant_id: seed.id,
    slug: seed.slug,
    display_name: seed.name,
    status: 'published',
    plan: 'pro',
    category_primary: seed.category,
    location_count: 1,
    rating: seed.ratingValue === null ? null : seed.ratingValue.toFixed(2),
    review_count: seed.ratingCount,
    funnel: {
      views,
      clicks,
      actions,
      reservations,
      orders,
      revenue: { amount: revenue.toFixed(2), currency: seed.currency },
    },
    funnel_source: 'fixture:v_merchant_funnel (synthetic projection of the demo catalogue)',
    revenue_definition: 'fixture projection: demo orders × demo average price — not real takings',
    computed_at: now.toISOString(),
    data_origin: 'demo',
  };
}

/** Thread fixtures mirroring `ConversationService.summary` rows, all `data_origin=demo`. */
export function fixtureConversations(businessId: string, now: Date = new Date()): MerchantConversationThread[] | null {
  const seed = findSeed(businessId);
  if (!seed) return null;
  if (businessId === DEMO_CONSOLE_EMPTY_INBOX) return [];
  const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return [
    {
      id: 'demo-thread-1',
      consumer_name: 'Demo Chan',
      merchant_name: seed.name,
      merchant_slug: seed.slug,
      channel: 'in_app',
      mode: 'hybrid',
      subject: seed.seats ? '周六晚上 6 位可以订吗？' : '想问店裡有现货吗？',
      status: 'handoff',
      last_message_at: iso(38),
      created_at: iso(95),
      handoffs: [
        {
          id: 'demo-handoff-1',
          reason: 'low_confidence',
          status: 'open',
          created_at: iso(40),
          resolved_at: null,
        },
      ],
      demo: true,
    },
    {
      id: 'demo-thread-2',
      consumer_name: 'Alex M.',
      merchant_name: seed.name,
      merchant_slug: seed.slug,
      channel: 'in_app',
      mode: 'ai',
      subject: 'What time do you close on Fridays?',
      status: 'closed',
      last_message_at: iso(60 * 26),
      created_at: iso(60 * 30),
      handoffs: [],
      demo: true,
    },
    {
      id: 'demo-thread-3',
      consumer_name: '王女士',
      merchant_name: seed.name,
      merchant_slug: seed.slug,
      channel: 'in_app',
      mode: 'human',
      subject: seed.offerings[0]?.title ?? 'Order question',
      status: 'open',
      last_message_at: iso(60 * 5),
      created_at: iso(60 * 6),
      handoffs: [],
      demo: true,
    },
  ];
}

/** The starting values for the merchant's own edit form — the same fields `PATCH /businesses/{id}` accepts. */
export function fixtureListingDraft(businessId: string): ListingDraft | null {
  const seed = findSeed(businessId);
  if (!seed) return null;
  return {
    name: seed.name,
    tagline: seed.tagline,
    description: seed.description,
    phone: seed.phone,
    price_amount: seed.priceAmount ?? '',
  };
}

/* --------------------------------------------------------- admin queue (§27) */

/**
 * The review queue behind the §27 publish gate: AI guide drafts, a marketing-agent coupon draft
 * and merchant listing changes. `reviewed_by_human` is deliberately mixed — the queue's whole job
 * is showing which items a person has not looked at yet.
 */
export function fixtureReviewQueue(now: Date = new Date()): ReviewQueueItem[] {
  const iso = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
  const guideItems: ReviewQueueItem[] = DEMO_GUIDES.map((guide, index) => ({
    id: `demo-queue-guide-${guide.slug}`,
    kind: 'guide' as const,
    title: guide.title,
    summary: guide.description,
    actor: 'ai:seo',
    merchant_name: null,
    generated_by_ai: guide.generated_by === 'ai',
    reviewed_by_human: guide.reviewed_by_human,
    submitted_at: iso(6 + index * 9),
    status: 'pending' as const,
    source: 'fixture:console-review (mirrors GET /api/v1/admin/moderation)',
    demo: true,
  }));
  return [
    ...guideItems,
    {
      id: 'demo-queue-coupon-1',
      kind: 'coupon',
      title: '週一至週三下午 9 折（示例草案）',
      summary: '营销代理根据示例客流草案生成的优惠券；发布前必须有人类批准（§27），本条从未投放。',
      actor: 'ai:marketing',
      merchant_name: '龍苑 Kitchen',
      generated_by_ai: true,
      reviewed_by_human: false,
      submitted_at: iso(3),
      status: 'pending',
      source: 'fixture:console-review (mirrors GET /api/v1/admin/moderation)',
      demo: true,
    },
    {
      id: 'demo-queue-listing-1',
      kind: 'listing_change',
      title: '双人晚市套餐 价格 398 → 388',
      summary: '商户自己提交的改价（§47：资料由商户控制）；进入队列是因为价格事实会出现在比较与 SEO 页。',
      actor: 'merchant',
      merchant_name: '龍苑 Kitchen',
      generated_by_ai: false,
      reviewed_by_human: false,
      submitted_at: iso(1.5),
      status: 'pending',
      source: 'fixture:console-review (mirrors GET /api/v1/admin/moderation)',
      demo: true,
    },
    {
      id: 'demo-queue-listing-2',
      kind: 'listing_change',
      title: 'AI 导入菜单提案：新增 3 个商品',
      summary: '§22 导入管道的提案（confidence 0.7–0.93）：解析自商户提供的示例网址，需商户与平台双重确认。',
      actor: 'ai:import',
      merchant_name: '洋紫荊咖啡',
      generated_by_ai: true,
      reviewed_by_human: false,
      submitted_at: iso(20),
      status: 'pending',
      source: 'fixture:console-review (mirrors GET /api/v1/admin/moderation)',
      demo: true,
    },
    {
      id: 'demo-queue-listing-3',
      kind: 'listing_change',
      title: '营业时间更新：週一改休',
      summary: '示例：商户提交的营业时间变更，已通过人工审核但保留在队列里演示状态区分。',
      actor: 'merchant',
      merchant_name: '花瓣茶室',
      generated_by_ai: false,
      reviewed_by_human: true,
      submitted_at: iso(52),
      status: 'approved',
      source: 'fixture:console-review (mirrors GET /api/v1/admin/moderation)',
      demo: true,
    },
  ];
}
