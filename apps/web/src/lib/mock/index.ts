import type {
  EntityCard,
  Fact,
  GeoPoint,
  MatchExplanation,
  PriceModel,
} from '@nexus/ui/trust/types';
import { findFact, isStale, pickFact } from '../facts';
import { computeOpening, formatDistance, haversineMeters } from '../format';
import { DISTRICTS, SEED_MERCHANTS, buildAvailability, buildMerchantDetail, buildMe, buildReviewSummary, buildReviews, demoUuid, distanceMeters, factUuid, merchantLocation, travelMinutes, DEMO_COLLECTIONS, DEMO_GUIDES, type DistrictKey, type SeedMerchant } from './seed';
import type {
  Collection,
  CompareResult,
  CursorPage,
  Guide,
  Intent,
  MerchantDetail,
  MeProfile,
  OfferingDetail,
  OfferingSummary,
  ProgrammaticPage,
  Review,
  ReviewSummary,
  SearchResponse,
  SeoListing,
  StreamDoneEvent,
  StreamResultsEvent,
  StreamStage,
  StreamStatusEvent,
  StreamSummaryEvent,
  User,
} from '../types';
import type { AvailabilitySlot } from '../types';
import { MIN_LISTINGS_FOR_INDEX } from '../env';

/**
 * Mock data plane. Same function signatures and same payload shapes as `lib/api/*`, so
 * flipping `NEXT_PUBLIC_DATA_MODE` from `mock` to `live` changes only which module the
 * page calls — never how the page renders. Everything here is `flags.demo` / `model:'mock'`.
 */

export const mockNow = (): Date => new Date();

/** Synthetic distance from the user's context point when one is supplied. */
function distanceFrom(seed: SeedMerchant, geo: GeoPoint | null | undefined): number {
  if (!geo) return distanceMeters(seed);
  return haversineMeters(geo, merchantLocation(seed));
}

function hoursValue(seed: SeedMerchant) {
  return SEED_HOURS(seed);
}

function SEED_HOURS(seed: SeedMerchant) {
  return seed.hours;
}

function priceExplanationText(price: Fact, budget: number | null, labels: { budget: string; price: string }): string | null {
  const value = price.value as { amount?: string };
  if (!value?.amount) return null;
  if (budget !== null) return `${labels.budget} ${Number(value.amount) <= budget ? '符合' : '超出'} · ${value.amount}`;
  return `${labels.price} ${value.amount}`;
}

export interface CardBuildOptions {
  geo?: GeoPoint | null;
  budgetMax?: number | null;
  locale?: string;
  group?: string | null;
  /** Copy for explanation bullets — mock data must still be rendered in the viewer's language. */
  strings?: { budget: string; price: string; rating: string; distance: string; hours: string; availability: string; match: string };
}

/** EntityCard builder: the mock equivalent of what the AI service returns. */
export function buildCard(seed: SeedMerchant, options: CardBuildOptions = {}): EntityCard {
  const now = mockNow();
  const detail = buildMerchantDetail(seed, now);
  const strings = options.strings ?? { budget: '预算', price: '价格', rating: '评分', distance: '距离', hours: '营业时间', availability: '位况', match: '匹配' };
  const facts = detail.facts;
  const priceFact = pickFact(facts, 'price');
  const ratingFact = pickFact(facts, 'rating');
  const hoursFact = pickFact(facts, 'business_hours');
  const meters = distanceFrom(seed, options.geo ?? null);
  const distanceFact = pickFact(facts, 'distance');

  const open = hoursFact ? computeOpening(hoursValue(seed) ?? [], hoursFact.fact_id, now) : null;
  const availabilitySlots = buildAvailability(seed, now);
  const nextSlot = availabilitySlots.find((slot) => slot.status !== 'full') ?? null;

  const reasons: MatchExplanation[] = [];
  if (priceFact) {
    reasons.push({
      label: options.budgetMax ? 'within_budget' : 'price_known',
      text: priceExplanationText(priceFact, options.budgetMax ?? null, strings) ?? strings.price,
      value: (priceFact.value as { amount?: string }).amount ?? null,
      fact_id: priceFact.fact_id,
    });
  }
  if (ratingFact) {
    const value = ratingFact.value as { value?: number; count?: number };
    reasons.push({
      label: 'highly_rated',
      text: `${strings.rating} ${value.value}（${value.count}）`,
      value: String(value.value),
      fact_id: ratingFact.fact_id,
    });
  }
  if (distanceFact) {
    reasons.push({
      label: 'closest',
      text: `${strings.distance} ${formatDistance(meters, options.locale ?? 'zh-HK')}`,
      value: String(meters),
      fact_id: distanceFact.fact_id,
    });
  }
  if (nextSlot && hoursFact) {
    reasons.push({
      label: 'slot_available',
      text: `${strings.availability} ${nextSlot.starts_at.slice(5, 10)} · ${strings.match}`,
      value: nextSlot.slot_id,
      fact_id: hoursFact.fact_id,
    });
  }

  const score = organicScore(seed, { meters, priceAmount: priceFact ? Number((priceFact.value as { amount: string }).amount) : null, ratingValue: ratingFact ? (ratingFact.value as { value: number }).value : null, reasons: reasons.length });

  return {
    card_type: 'merchant',
    id: seed.id,
    slug: seed.slug,
    title: seed.name,
    subtitle: `${seed.tagline}`,
    href: `/m/${seed.slug}`,
    image: detail.images[0] ?? null,
    price: priceFact ? { amount: seed.priceAmount as string, currency: seed.currency, model: seed.priceModel as PriceModel } : null,
    rating: ratingFact && seed.ratingValue !== null ? { value: seed.ratingValue, count: seed.ratingCount } : null,
    distance: distanceFact ? { meters, travel_minutes: travelMinutes(seed), text: formatDistance(meters, options.locale ?? 'zh-HK') } : null,
    open: open ? { ...open, text: open.text ?? null } : null,
    availability: nextSlot
      ? { status: nextSlot.status === 'available' ? 'available' : 'limited', next_slot: nextSlot.starts_at, source_fact_id: (pickFact(facts, 'availability') ?? null)?.fact_id ?? null }
      : availabilitySlots.length > 0 ? { status: 'full' } : { status: 'unknown' },
    ai_match: { score, reasons },
    actions: [
      seed.seats
        ? { type: 'reserve', label: '预订', endpoint: '/api/v1/reservations', method: 'POST' }
        : { type: 'view_menu', label: '菜单', endpoint: `/api/v1/merchants/${seed.id}/menu`, method: 'GET' },
      { type: 'favorite', label: '收藏', endpoint: '/api/v1/me/favorites', method: 'POST' },
      { type: 'share', label: '分享', endpoint: '/api/v1/share', method: 'POST' },
    ],
    facts,
    flags: { sponsored: false, demo: true, unverified: !priceFact || !ratingFact },
    group: options.group ?? null,
    geo: merchantLocation(seed),
  };
}

/**
 * Organic score only — the weighting shape of §6 (relevance/quality/distance/price fit),
 * computed deterministically so mock ordering is stable and explainable. Sponsored slots are
 * never part of this (§67).
 */
function organicScore(seed: SeedMerchant, parts: { meters: number; priceAmount: number | null; ratingValue: number | null; reasons: number }): number {
  const dist = Math.max(0, 1 - Math.min(parts.meters, 12_000) / 12_000);
  const quality = parts.ratingValue === null ? 0.4 : Math.min(1, parts.ratingValue / 5);
  const priceFit = parts.priceAmount === null ? 0.35 : Math.max(0, 1 - Math.min(parts.priceAmount, 1000) / 1000);
  const richness = Math.min(1, parts.reasons / 4);
  const raw = 0.34 * quality + 0.26 * dist + 0.18 * priceFit + 0.12 * richness + 0.1 * (seed.ratingCount > 150 ? 1 : 0.6);
  return Math.round(Math.min(0.99, Math.max(0.35, raw)) * 100) / 100;
}

export function allCards(options: CardBuildOptions = {}): EntityCard[] {
  return SEED_MERCHANTS.map((seed) => buildCard(seed, options)).sort((a, b) => (b.ai_match?.score ?? 0) - (a.ai_match?.score ?? 0));
}

/* ------------------------------------------------------------------ query NLU */

const BUDGET_PATTERNS: Array<RegExp> = [/预算\s*(\d+)/, /budget\s*(\d+)/i, /港币?\s*(\d+)\s*(?:以内|以下)/, /(\d+)\s*(?:港币|hkdb?|hkd)/i];
const DISTRICT_WORDS: Array<[RegExp, DistrictKey]> = [
  [/沙田|sha tin/i, 'sha_tin'], [/中環|中环|central/i, 'central'], [/旺角|mong kok/i, 'mong_kok'],
  [/銅鑼灣|铜锣湾|causeway/i, 'causeway_bay'], [/灣仔|湾仔|wan chai/i, 'wan_chai'], [/尖沙咀|tsim sha/i, 'tsim_sha_tsui'],
  [/九龍灣|九龙湾|kowloon bay/i, 'kowloon_bay'], [/鴨脷洲|鸭脷洲|ap lei/i, 'ap_lei_chau'], [/荃灣|荃湾|tsuen wan/i, 'tsuen_wan'],
  [/將軍澳|将军澳|tseung/i, 'tseung_kwan_o'], [/佐敦|jordan/i, 'jordan'], [/上水|sheung shui/i, 'sheung_shui'],
];

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/餐厅|Restaurant|restaurant|食|美食|晚饭|晚餐/i, 'restaurant'], [/咖啡|cafe|coffee|面包|烘焙/i, 'cafe'],
  [/健身|gym|fitness|运动/i, 'fitness'], [/酒吧|bar/i, 'entertainment'], [/酒店|住宿|hotel|inn/i, 'hotel'],
  [/按摩|理疗|spa|recovery|beauty|美容/i, 'beauty'], [/跑|行山|活动|activities|体验/i, 'activities'], [/买|鞋|购物|shop/i, 'shopping'],
];

const TAG_HINTS: Array<[RegExp, string]> = [
  [/约会|date/i, 'date-night'], [/安静|quiet/i, 'quiet'], [/朋友|聚会|group|friends/i, 'friends'],
  [/便宜|平价|cheap|budget/i, 'cheap'], [/辣|spicy/i, 'spicy'], [/小孩|亲子|家庭|family/i, 'family'],
  [/深夜|晚上|late/i, 'late-night'], [/雨天|下雨|rain/i, 'rainy-day'], [/早餐|早上|早|early/i, 'early'],
  [/素食|vegetarian|素/i, 'no-spicy'], [/海景|sea view/i, 'sea-view'], [/工作|办公|laptop|wifi/i, 'work'],
];

/** Deterministic stand-in for `POST /ai/v1/query/understand` (mock provider, D4). */
export function understandQuery(query: string, context: { locale?: string; geo?: GeoPoint | null } = {}): Intent {
  const now = mockNow();
  let budgetMax: number | null = null;
  for (const pattern of BUDGET_PATTERNS) {
    const match = pattern.exec(query);
    if (match?.[1]) {
      budgetMax = Number.parseInt(match[1], 10);
      break;
    }
  }
  const districtEntry = DISTRICT_WORDS.find(([pattern]) => pattern.test(query));
  const district = districtEntry ? DISTRICTS[districtEntry[1]] : null;
  const categoryEntry = CATEGORY_HINTS.find(([pattern]) => pattern.test(query));
  const tags = TAG_HINTS.filter(([pattern]) => pattern.test(query)).map(([, tag]) => tag);
  const avoidSpicy = /不吃辣|不要辣|no spicy|清汤/i.test(query);
  const nearMe = /附近|near me|我这边/i.test(query);
  const weekend = /周末|週六|周六|saturday|weekend/i.test(query);
  const evening = /晚上|晚市|夜晚|evenight|evening|pm|点/i.test(query);

  const startsAt = new Date(now.getTime() + (weekend ? 4 : evening ? 0.2 : 1) * 86_400_000);
  if (evening) startsAt.setHours(19, 0, 0, 0);

  return {
    raw_query: query,
    intent: /订|book|reserve/i.test(query) ? 'reserve' : categoryEntry ? 'discover_merchant' : 'discover_merchant',
    category: categoryEntry ? categoryEntry[1] : null,
    location: district
      ? { type: 'district', value: district.name, resolved: district.geo, radius_m: null }
      : nearMe
        ? { type: 'near_me', value: null, resolved: context.geo ?? null, radius_m: 3000 }
        : /* A coarse centre is for *ranking* by distance, not for filtering: imposing a radius the
             visitor never asked for turns the default location into a hard 3 km wall, which made
             three of the five §6 starter prompts come back empty. */
          context.geo
          ? { type: 'near_me', value: null, resolved: context.geo, radius_m: null }
          : null,
    time: weekend || evening ? { type: 'explicit', starts_at: startsAt.toISOString() } : { type: 'none' },
    budget: budgetMax !== null ? { min: null, max: budgetMax, currency: 'HKD', per: 'party' } : null,
    party_size: null,
    preferences: tags.map((tag) => ({ key: 'scene', value: tag, polarity: 1 as const })).concat(avoidSpicy ? [{ key: 'ambience', value: 'no-spicy', polarity: 1 as const }] : []),
    constraints: avoidSpicy ? [{ key: 'cuisine_avoid', value: 'spicy' }] : [],
    sort_preference: /近|最近|close|near/i.test(query) ? 'distance' : /便宜|平价|cheap|低/i.test(query) ? 'price_low' : /评分|最好|top|rated/i.test(query) ? 'rating' : 'relevance',
    urgency: /现在|今晚|today|now/i.test(query) ? 'now' : 'normal',
    language: context.locale ?? 'zh-HK',
    confidence: {
      category: categoryEntry ? 0.9 : 0.35,
      budget: budgetMax !== null ? 0.88 : 0,
      time: weekend || evening ? 0.7 : 0,
      location: district ? 0.94 : context.geo ? 0.6 : 0,
    },
    // §8: never guess party size or a time the user did not state.
    unknowns: [budgetMax === null ? 'budget' : null, weekend || evening ? null : 'time', 'party_size'].filter((value): value is string => Boolean(value)),
  };
}

/**
 * Multi-turn merge (§34, contract's `state_merger`): the three documented refinement rules
 * are implemented here so mock mode behaves like the service: 太贵了 → budget×0.7,
 * 近一点 → sort=distance + tighter radius, 不吃辣 → append constraint.
 */
export function mergeIntent(previous: Intent | null, followUp: string): Intent {
  const base = previous ?? understandQuery(followUp);
  const next: Intent = structuredClone(base);
  next.raw_query = followUp;

  if (/太贵|贵了|太貴|expensive|too much|cheap/i.test(followUp)) {
    if (next.budget && next.budget.max != null) {
      next.budget = { ...next.budget, max: Math.round(next.budget.max * 0.7) };
      next.sort_preference = next.sort_preference === 'relevance' ? 'price_low' : next.sort_preference;
    } else {
      // §8: with no stated budget there is nothing to scale, so neither plane invents one — the
      // honest effect of "太贵了" is to order by price. Mirrors `state_merger._adjust_budget`.
      next.sort_preference = 'price_low';
    }
  }
  if (/近一点|近一些|太遠|太远|closer|nearer|近啲/i.test(followUp)) {
    next.sort_preference = 'distance';
    next.location = { type: next.location?.type ?? 'near_me', value: next.location?.value ?? null, resolved: next.location?.resolved ?? null, radius_m: Math.max(600, Math.round((next.location?.radius_m ?? 3000) * 0.6)) };
  }
  if (/不吃辣|不要辣|no spicy|清汤|清湯/i.test(followUp)) {
    if (!next.constraints.some((constraint) => constraint.key === 'cuisine_avoid')) {
      next.constraints = [...next.constraints, { key: 'cuisine_avoid', value: 'spicy' }];
    }
  }
  if (/安静|靜一点|quiet/i.test(followUp)) {
    next.preferences = [...next.preferences.filter((preference) => preference.key !== 'ambience'), { key: 'ambience', value: 'quiet', polarity: 1 }];
  }
  if (/周末|周六|晚上|tonight|weekend/i.test(followUp)) {
    const starts = new Date(mockNow().getTime() + 3 * 86_400_000);
    starts.setHours(19, 0, 0, 0);
    next.time = { type: 'explicit', starts_at: starts.toISOString() };
  }
  return next;
}

/* -------------------------------------------------------------------- search */

/**
 * Query → match tokens. CJK is not space-separated, so a whole sentence arrives as one token and
 * `haystack.includes("帮我找附近适合朋友聚会的餐厅")` is always false: an unsegmented matcher threw
 * away *every* Chinese query with the §6 relevance floor, i.e. the default demo returned an empty
 * page for its own example prompts. Two-character windows are the smallest meaningful unit here.
 */
function queryTokens(query: string): string[] {
  const parts = query
    .toLowerCase()
    .split(/[\s,，、。;；!?！？：:()（）]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
  const tokens: string[] = [];
  for (const part of parts) {
    if (/[\u4e00-\u9fff]/.test(part)) {
      const characters = [...part];
      if (characters.length === 2) tokens.push(part);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        tokens.push((characters[index] ?? '') + (characters[index + 1] ?? ''));
      }
    } else {
      tokens.push(part);
    }
  }
  return tokens;
}

/**
 * The seed catalogue stores its structure in English slugs (`subcategories: ['japanese','ramen']`,
 * `tags: ['friends']`), but a shopper types 日料. A surface-text matcher therefore never reaches
 * the topical fields for Chinese at all: three of the five §6 starter prompts (朋友聚会 / 情侣约会 /
 * 下雨天的鞋 / 预算日料) scored 0 on every merchant and the relevance floor returned an empty page
 * for the demo's own examples. This maps the wording people actually type onto the vocabulary the
 * records are written in; scene words come from `TAG_HINTS` so the two lists cannot drift apart.
 */
const CUISINE_VOCABULARY: Array<[RegExp, string[]]> = [
  [/日料|日本料理|日式|和食|寿司|刺身|拉麵|拉面|居酒屋/, ['japanese', 'ramen']],
  [/火鍋|火锅|打边炉|麻辣/, ['hotpot', 'sichuan']],
  [/點心|点心|饮茶|飲茶|早茶|粤菜|粵菜/, ['dimsum', 'cantonese']],
  [/韓式|韩式|泡菜|烧肉|烤肉|bbq/i, ['korean', 'bbq']],
  [/素食|斋菜|素菜|vegetarian|veg/i, ['vegetarian']],
  [/咖啡|手冲|手沖|cafe|coffee|早午餐|brunch/i, ['coffee', 'brunch']],
  [/面包|麵包|烘焙|可颂|可頌|bakery/i, ['bakery']],
  [/健身|举铁|舉鐵|力量|gym|fitness/i, ['gym', 'strength']],
  [/按摩|理疗|理療|舒压|舒壓|恢复|恢復|recovery/, ['massage', 'recovery']],
  [/酒吧|鸡尾酒|雞尾酒|喝一杯|cocktail/i, ['bar', 'cocktails']],
  [/酒店|住宿|过夜|過夜|民宿|hotel|inn/i, ['boutique-hotel']],
  [/鞋|雨天|下雨|雨伞|雨傘|rainy/i, ['footwear', 'rainy-day']],
  [/跑步|行山|远足|遠足|跑团|running|hiking/i, ['running', 'outdoor']],
];

/** Query → slug-vocabulary tokens the records are indexed under (scenes + cuisines). */
function vocabularyTokens(query: string): string[] {
  const scenes = TAG_HINTS.filter(([pattern]) => pattern.test(query)).map(([, tag]) => tag);
  const cuisines: string[] = [];
  for (const [pattern, slugs] of CUISINE_VOCABULARY) {
    if (pattern.test(query)) cuisines.push(...slugs);
  }
  return Array.from(new Set([...scenes, ...cuisines]));
}

function matchesQuery(seed: SeedMerchant, query: string): number {
  const haystack = `${seed.name} ${seed.tagline} ${seed.description} ${seed.category} ${seed.subcategories.join(' ')} ${seed.tags.join(' ')} ${DISTRICTS[seed.district]?.name ?? ''} ${DISTRICTS[seed.district]?.zh ?? ''}`.toLowerCase();
  const tokens = queryTokens(query);
  const vocabulary = vocabularyTokens(query);
  if (tokens.length === 0 && vocabulary.length === 0) return 0.4;
  const hits = tokens.filter(
    (token) => haystack.includes(token) || (token.length >= 3 && !/[\u4e00-\u9fff]/.test(token) && haystack.includes(token.slice(0, 3))),
  ).length;
  const topicHits = vocabulary.filter((token) => haystack.includes(token)).length;
  /* A sentence carries function-word windows (帮我 / 适合 / 一个) that no record will ever contain,
     so dividing hits by the raw window count understates a genuine topical hit. Take the stronger
     of the two signals: prose overlap, or coverage of the vocabulary the record is filed under. */
  return Math.max(tokens.length ? hits / tokens.length : 0, vocabulary.length ? topicHits / vocabulary.length : 0);
}

export interface MockSearchOptions {
  query?: string;
  intent?: Intent | null;
  geo?: GeoPoint | null;
  limit?: number;
  category?: string | null;
  district?: string | null;
  openNow?: boolean;
  maxPrice?: number | null;
}

/** Deterministic hybrid-ish search: relevance floor → score → group (§13, §17, §36). */
export function mockSearch(options: MockSearchOptions = {}): SearchResponse {
  const started = Date.now();
  const intent = options.intent ?? (options.query ? understandQuery(options.query, { geo: options.geo ?? null }) : null);
  const budgetMax = intent?.budget?.max ?? null;
  const query = options.query ?? intent?.raw_query ?? '';
  const geo = intent?.location?.resolved ?? options.geo ?? null;

  const scored = SEED_MERCHANTS.map((seed) => {
    const relevance = matchesQuery(seed, query);
    const card = buildCard(seed, { geo, budgetMax, group: null });
    const price = findFact(card, 'price') ? Number((card.price as { amount: string }).amount) : null;
    const dist = distanceFrom(seed, geo);
    return { seed, card, relevance, price, dist };
  });

  const categoryFilter = options.category ?? intent?.category ?? null;
  const avoidSpicy = intent?.constraints?.some((constraint) => constraint.key === 'cuisine_avoid' && constraint.value === 'spicy');
  const radius = intent?.location?.radius_m ?? null;

  const filtered = scored.filter((entry) => {
    if (categoryFilter && entry.seed.category !== categoryFilter) return false;
    if (options.district && entry.seed.district !== options.district) return false;
    if (options.maxPrice != null && entry.price !== null && entry.price > options.maxPrice) return false;
    if (budgetMax !== null && entry.price !== null && entry.price > budgetMax) return false;
    if (radius !== null && entry.dist > radius) return false;
    if (avoidSpicy && entry.seed.tags.includes('spicy')) return false;
    if (options.openNow) {
      const hoursFact = pickFact(entry.card.facts, 'business_hours');
      const open = hoursFact ? computeOpening(entry.seed.hours ?? [], hoursFact.fact_id, mockNow()) : null;
      if (!open?.is_open) return false;
    }
    // relevance floor: a complete miss on a non-empty query is dropped, not ranked by popularity (§6).
    if (query.trim().length > 1 && entry.relevance < 0.15) return false;
    return true;
  });

  const sort = intent?.sort_preference ?? options.query?.includes('近') ?? false ? (intent?.sort_preference ?? 'relevance') : (intent?.sort_preference ?? 'relevance');
  filtered.sort((a, b) => {
    if (sort === 'distance') return a.dist - b.dist;
    if (sort === 'price_low') return (a.price ?? Number.MAX_SAFE_INTEGER) - (b.price ?? Number.MAX_SAFE_INTEGER);
    if (sort === 'rating') return ((b.card.rating?.value ?? 0) as number) - ((a.card.rating?.value ?? 0) as number);
    return b.card.ai_match!.score * (0.5 + a.relevance) - a.card.ai_match!.score * (0.5 + b.relevance);
  });

  const limited = filtered.slice(0, options.limit ?? 12);
  const groups = new Map<string, number>();
  const items = limited.map((entry, index) => {
    const group = index === 0 ? 'best_match' : entry.price !== null && (budgetMax === null || entry.price <= budgetMax) && index < 4 ? 'best_value' : index < 3 ? 'closest' : 'most_popular';
    groups.set(group, (groups.get(group) ?? 0) + 1);
    return { ...entry.card, group };
  });

  return {
    items,
    facets: {
      total_candidates: filtered.length,
      groups: Object.fromEntries(groups),
      districts: Array.from(new Set(limited.map((entry) => entry.seed.district))),
      price_range: limited.length
        ? { min: Math.min(...limited.flatMap((entry) => (entry.price === null ? [] : [entry.price]))), max: Math.max(...limited.flatMap((entry) => (entry.price === null ? [] : [entry.price]))) }
        : null,
    },
    took_ms: Date.now() - started,
    strategy: 'hybrid_v1_mock',
    degraded: false,
  };
}

/* ----------------------------------------------------------------- grouping (§36) */

export interface ResultGroup {
  key: 'best_match' | 'best_value' | 'closest' | 'most_popular';
  cards: EntityCard[];
}

export function groupResults(cards: EntityCard[]): ResultGroup[] {
  const order: ResultGroup['key'][] = ['best_match', 'best_value', 'closest', 'most_popular'];
  const buckets = new Map<ResultGroup['key'], EntityCard[]>(order.map((key) => [key, []]));
  for (const card of cards) {
    const key = (card.group as ResultGroup['key'] | null | undefined) ?? 'most_popular';
    buckets.set(key, [...(buckets.get(key) ?? []), card]);
  }
  return order.map((key) => ({ key, cards: buckets.get(key) ?? [] })).filter((group) => group.cards.length > 0);
}

/* --------------------------------------------------------------- comparison (§37) */

export function mockCompare(ids: string[]): CompareResult {
  const cards = ids.map((id) => SEED_MERCHANTS.find((seed) => seed.id === id)).filter((seed): seed is SeedMerchant => Boolean(seed)).map((seed) => buildCard(seed));
  const attribute = (label: string, pick: (card: EntityCard) => { display: string; fact_id: string | null; stale?: boolean }) => ({
    attribute: label,
    cards: cards.map((card) => {
      const value = pick(card);
      return { value: value.display, display: value.display, fact_id: value.fact_id, stale: value.stale };
    }),
  });
  return {
    rows: [
      // Attribute labels are localised by the caller through `compareRows`; mock keeps machine keys
      // so the UI maps them via dictionaries instead of baked-in copy.
      attribute('price', (card) => {
        const fact = findFact(card, 'price');
        return { display: fact ? `${card.price?.amount}` : '', fact_id: fact?.fact_id ?? null, stale: fact ? isStale(fact) : false };
      }),
      attribute('rating', (card) => {
        const fact = findFact(card, 'rating');
        return { display: fact && card.rating ? `${card.rating.value}` : '', fact_id: fact?.fact_id ?? null };
      }),
      attribute('distance', (card) => {
        const fact = findFact(card, 'distance');
        return { display: fact && card.distance ? (card.distance.text ?? `${card.distance.meters}m`) : '', fact_id: fact?.fact_id ?? null };
      }),
      attribute('opening', (card) => {
        const fact = findFact(card, 'business_hours');
        return { display: fact && card.open ? (card.open.is_open ? 'open' : 'closed') : '', fact_id: fact?.fact_id ?? null };
      }),
      attribute('availability', (card) => {
        const slot = card.availability?.next_slot ?? null;
        const fact = slot ? pickFact(card.facts, 'availability') : null;
        return { display: slot ?? '', fact_id: fact?.fact_id ?? null };
      }),
      attribute('match', (card) => ({ display: card.ai_match ? String(card.ai_match.score) : '', fact_id: card.ai_match?.reasons[0]?.fact_id ?? null })),
    ],
    cards,
    degraded: false,
  };
}

/* --------------------------------------------------------------- stream (§116) */

export interface MockStreamEventMap {
  status: StreamStatusEvent;
  intent: Intent;
  results: StreamResultsEvent;
  summary: StreamSummaryEvent;
  done: StreamDoneEvent;
}

export type MockStreamEvent =
  | { event: 'status'; data: StreamStatusEvent }
  | { event: 'intent'; data: Intent }
  | { event: 'results'; data: StreamResultsEvent }
  | { event: 'summary'; data: StreamSummaryEvent }
  | { event: 'done'; data: StreamDoneEvent }
  | { event: 'error'; data: { code: string; message: string } };

export interface StreamInput {
  query: string;
  conversationId?: string | null;
  previousIntent?: Intent | null;
  geo?: GeoPoint | null;
  locale?: string;
  /** §105 test hook: force the stream to fail so the fallback path is demonstrable. */
  forceError?: boolean;
}

/**
 * Emits the §7 SSE event sequence locally. Stage texts come from the caller's dictionary,
 * which is why `stageTexts` is a required argument — the mock cannot invent copy.
 */
export async function* mockSearchStream(
  input: StreamInput,
  stageTexts: Record<StreamStage, string> & { found: (count: number) => string },
): AsyncGenerator<MockStreamEvent> {
  const intent = input.previousIntent ? mergeIntent(input.previousIntent, input.query) : understandQuery(input.query, { geo: input.geo ?? null, locale: input.locale });
  yield { event: 'status', data: { stage: 'understanding', text: stageTexts.understanding } };
  await delay(140);
  if (input.forceError) {
    yield { event: 'error', data: { code: 'ai_unavailable', message: 'forced failure for §105 fallback demo' } };
    return;
  }
  yield { event: 'intent', data: intent };
  yield { event: 'status', data: { stage: 'searching', text: stageTexts.searching } };
  await delay(160);
  const search = mockSearch({ intent, geo: input.geo ?? null });
  yield { event: 'status', data: { stage: 'comparing', text: stageTexts.comparing } };
  await delay(140);
  yield { event: 'results', data: { set_id: demoUuid('set'), items: search.items } };
  yield { event: 'status', data: { stage: 'summarizing', text: stageTexts.summarizing } };
  await delay(120);
  yield {
    event: 'summary',
    data: {
      text: stageTexts.found(search.items.length),
      citations: search.items.flatMap((card) => card.facts?.slice(0, 2).map((fact) => fact.fact_id) ?? []),
    },
  };
  yield {
    event: 'done',
    data: {
      agent_run_id: demoUuid('run'),
      latency_ms: 620,
      cost_usd: 0,
      degraded: false,
      provider: 'mock',
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ catalogues */

export function mockMerchant(slug: string): MerchantDetail | null {
  const seed = SEED_MERCHANTS.find((merchant) => merchant.slug === slug);
  return seed ? buildMerchantDetail(seed, mockNow()) : null;
}

export function mockMenu(slug: string, limit = 20): CursorPage<OfferingSummary> {
  const merchant = SEED_MERCHANTS.find((entry) => entry.slug === slug);
  if (!merchant) return { items: [], next_cursor: null, total_estimate: 0 };
  const items = merchant.offerings.map((offering) => buildOffering(merchant, offering));
  return { items: items.slice(0, limit), next_cursor: null, total_estimate: items.length };
}

function buildOffering(seed: SeedMerchant, offering: SeedMerchant['offerings'][number]): OfferingSummary {
  return buildMerchantDetail(seed, mockNow()).top_offerings.find((entry) => entry.slug === offering.slug) ?? {
    id: `${seed.id}:${offering.slug}`, slug: offering.slug, title: offering.title, kind: offering.kind, description: offering.description,
    price: { amount: offering.price, currency: seed.currency, model: 'per_item' }, merchant: { id: seed.id, slug: seed.slug, name: seed.name },
    facts: [], flags: { demo: true },
  };
}

export function mockOffering(slug: string): OfferingDetail | null {
  for (const seed of SEED_MERCHANTS) {
    const offering = seed.offerings.find((entry) => entry.slug === slug);
    if (!offering) continue;
    const summary = buildOffering(seed, offering);
    const detail = buildMerchantDetail(seed, mockNow());
    return {
      ...summary,
      merchant: { id: seed.id, slug: seed.slug, name: seed.name, district: DISTRICTS[seed.district]?.name ?? 'Hong Kong', geo: merchantLocation(seed) },
      highlights: seed.tags.slice(0, 3),
      rating: detail.rating,
      availability: { status: seed.seats ? 'available' : 'unknown', next_slot: buildAvailability(seed, mockNow())[0]?.starts_at ?? null },
    };
  }
  return null;
}

export function mockReviews(slug: string, sort: 'recent' | 'helpful' = 'recent'): CursorPage<Review> {
  const seed = SEED_MERCHANTS.find((merchant) => merchant.slug === slug);
  if (!seed) return { items: [], next_cursor: null, total_estimate: 0 };
  const reviews = buildReviews(seed, mockNow()).slice();
  reviews.sort((a, b) => (sort === 'helpful' ? b.helpful_count - a.helpful_count : Date.parse(b.created_at) - Date.parse(a.created_at)));
  return { items: reviews, next_cursor: null, total_estimate: reviews.length };
}

export function mockReviewSummary(slug: string): ReviewSummary | null {
  const seed = SEED_MERCHANTS.find((merchant) => merchant.slug === slug);
  return seed ? buildReviewSummary(seed, mockNow()) : null;
}

export function mockAvailability(slug: string): AvailabilitySlot[] {
  const seed = SEED_MERCHANTS.find((merchant) => merchant.slug === slug);
  return seed ? buildAvailability(seed, mockNow()) : [];
}

export interface GeoMarkerPayload {
  id: string;
  slug: string;
  name: string;
  geo: GeoPoint;
  category: string;
  price: number | null;
  rating: number | null;
  meters_from_user: number;
  demo: boolean;
}

export function mockGeoMarkers(geo: GeoPoint | null): GeoMarkerPayload[] {
  return SEED_MERCHANTS.map((seed) => {
    const detail = buildMerchantDetail(seed, mockNow());
    const priceFact = pickFact(detail.facts, 'price');
    const ratingFact = detail.rating && pickFact(detail.facts, 'rating') ? detail.rating : null;
    return {
      id: seed.id, slug: seed.slug, name: seed.name, geo: merchantLocation(seed), category: seed.category,
      price: priceFact ? Number((priceFact.value as { amount: string }).amount) : null,
      rating: ratingFact ? ratingFact.value : null,
      meters_from_user: distanceFrom(seed, geo),
      demo: true,
    };
  });
}

/* ---------------------------------------------------------------- home rails (§6) */

export interface HomeRails {
  popular_near_you: EntityCard[];
  for_you: EntityCard[];
  trending: EntityCard[];
  recommended: EntityCard[];
  recently_viewed: EntityCard[];
}

export function mockHomeRails(geo: GeoPoint | null = null, signedIn = false): HomeRails {
  const cards = allCards({ geo });
  const byRating = [...cards].sort((a, b) => (b.rating?.value ?? 0) - (a.rating?.value ?? 0));
  const byCount = [...cards].sort((a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0));
  const byPrice = [...cards].sort((a, b) => Number(a.price?.amount ?? 9e9) - Number(b.price?.amount ?? 9e9));
  return {
    popular_near_you: [...cards].sort((a, b) => (a.distance?.meters ?? 0) - (b.distance?.meters ?? 0)).slice(0, 8),
    // §CONSUMER open question: guests must still see an honest rail — trending near the coarse
    // location, not a fake "For You" derived from a profile the visitor does not have.
    for_you: signedIn ? byRating.slice(0, 6) : byCount.slice(0, 6),
    trending: byCount.slice(0, 8),
    recommended: byPrice.slice(0, 6),
    recently_viewed: signedIn ? cards.slice(2, 6) : [],
  };
}

/* ------------------------------------------------------------------- account */

export function mockMe(): MeProfile {
  const profile = buildMe(mockNow());
  const favoriteCards = new Map(SEED_MERCHANTS.map((seed) => [seed.id, buildCard(seed)]));
  return {
    ...profile,
    favorites: profile.favorites.map((favorite, index) => ({
      ...favorite,
      card: favoriteCards.get(favorite.subject_id) ?? allCards()[index] ?? (null as never),
    })),
  };
}

export function mockDemoSession(): { user: User; access_token: string; refresh_token: string; demo: true } {
  const profile = buildMe(mockNow());
  return {
    user: { ...profile.user, demo: true },
    access_token: 'mock.demo.access',
    refresh_token: 'mock.demo.refresh',
    demo: true,
  };
}

export function mockLogin(email: string, display_name = '示例用戶'): User {
  const profile = buildMe(mockNow());
  return { ...profile.user, email, display_name: display_name || profile.user.display_name, demo: true };
}

/* ----------------------------------------------------------------- collections */

export function mockCollections(): Collection[] {
  const cards = allCards();
  return DEMO_COLLECTIONS.map((collection, index) => ({
    ...collection,
    items: cards.slice(index * 2, index * 2 + 5),
    updated_at: new Date(mockNow().getTime() - index * 86_400_000).toISOString(),
  }));
}

export function mockCollection(slug: string): Collection | null {
  return mockCollections().find((collection) => collection.slug === slug) ?? null;
}

export function mockGuides(): Guide[] {
  const cards = allCards();
  return DEMO_GUIDES.map((guide, index) => ({
    ...guide,
    body_blocks: guide.body_blocks.map((block) => (block.type === 'cards' ? { ...block, items: cards.slice(index, index + 3) } : block)),
  }));
}

export function mockGuide(slug: string): Guide | null {
  return mockGuides().find((guide) => guide.slug === slug) ?? null;
}

/* ------------------------------------------------------- programmatic SEO (§29) */

export const SEO_CITY = { slug: 'hong-kong', name: 'Hong Kong', zh: '香港' };

export const SEO_CATEGORIES: Array<{ slug: string; name: string; zh: string; seedCategory: string | null; subcategories: Array<{ slug: string; name: string; zh: string; match: (seed: SeedMerchant) => boolean }> }> = [
  {
    slug: 'restaurants', name: 'Restaurants', zh: '餐廳', seedCategory: 'restaurant',
    subcategories: [
      { slug: 'cantonese', name: 'Cantonese', zh: '粵菜', match: (seed) => seed.subcategories.includes('cantonese') || seed.tags.includes('cantonese') },
      { slug: 'japanese', name: 'Japanese', zh: '日式', match: (seed) => seed.subcategories.some((entry) => ['japanese', 'ramen'].includes(entry)) },
      { slug: 'spicy', name: 'Spicy', zh: '辣味', match: (seed) => seed.tags.includes('spicy') },
      { slug: 'vegetarian', name: 'Vegetarian', zh: '素食', match: (seed) => seed.subcategories.includes('vegetarian') },
      { slug: 'dimsum', name: 'Dim sum', zh: '點心', match: (seed) => seed.subcategories.includes('dimsum') },
      { slug: 'korean', name: 'Korean', zh: '韓式', match: (seed) => seed.subcategories.includes('korean') },
      { slug: 'date-night', name: 'Date night', zh: '約會', match: (seed) => seed.tags.includes('date-night') },
      { slug: 'family', name: 'Family friendly', zh: '親子', match: (seed) => seed.tags.includes('family') },
      { slug: 'quiet', name: 'Quiet', zh: '安靜', match: (seed) => seed.tags.includes('quiet') },
      { slug: 'sha-tin', name: 'Sha Tin', zh: '沙田', match: (seed) => seed.district === 'sha_tin' },
      { slug: 'central', name: 'Central', zh: '中環', match: (seed) => seed.district === 'central' },
      { slug: 'mong-kok', name: 'Mong Kok', zh: '旺角', match: (seed) => seed.district === 'mong_kok' },
    ],
  },
  {
    slug: 'cafes', name: 'Cafes', zh: '咖啡與烘焙', seedCategory: 'cafe',
    subcategories: [
      { slug: 'coffee', name: 'Coffee', zh: '咖啡', match: (seed) => seed.subcategories.includes('coffee') },
      { slug: 'bakery', name: 'Bakery', zh: '面包', match: (seed) => seed.subcategories.includes('bakery') },
      { slug: 'quiet', name: 'Quiet', zh: '安靜', match: (seed) => seed.tags.includes('quiet') },
      { slug: 'early', name: 'Open early', zh: '早開', match: (seed) => seed.tags.includes('early') },
    ],
  },
  {
    slug: 'fitness', name: 'Fitness', zh: '健身', seedCategory: 'fitness',
    subcategories: [
      { slug: 'gym', name: 'Gym', zh: '健身室', match: (seed) => seed.subcategories.includes('gym') },
      { slug: 'late-night', name: 'Late night', zh: '深夜', match: (seed) => seed.tags.includes('late-night') },
      { slug: 'recovery', name: 'Recovery', zh: '恢復', match: (seed) => seed.subcategories.includes('recovery') },
    ],
  },
  {
    slug: 'entertainment', name: 'Bars & Entertainment', zh: '酒吧與娛樂', seedCategory: 'entertainment',
    subcategories: [
      { slug: 'late-night', name: 'Late night', zh: '深夜', match: (seed) => seed.tags.includes('late-night') },
      { slug: 'quiet', name: 'Quiet', zh: '安靜', match: (seed) => seed.tags.includes('quiet') },
    ],
  },
  {
    slug: 'shopping', name: 'Shopping', zh: '購物', seedCategory: 'shopping',
    subcategories: [{ slug: 'rainy-day', name: 'Rainy day', zh: '雨天', match: (seed) => seed.tags.includes('rainy-day') }],
  },
];

function seedToSeoListing(seed: SeedMerchant): SeoListing {
  const now = mockNow();
  const detail = buildMerchantDetail(seed, now);
  const priceFact = pickFact(detail.facts, 'price');
  const ratingFact = detail.rating ? pickFact(detail.facts, 'rating') : null;
  return {
    slug: seed.slug, name: seed.name, district: DISTRICTS[seed.district]?.name ?? 'Hong Kong', category: seed.category,
    subcategory: seed.subcategories[0] ?? null,
    avg_price: priceFact ? { amount: seed.priceAmount as string, currency: seed.currency } : null,
    rating: ratingFact && detail.rating ? detail.rating : null,
    price_fact_id: priceFact?.fact_id ?? null, rating_fact_id: ratingFact?.fact_id ?? null,
    facts: detail.facts, demo: true,
  };
}

/** The HKD ceiling `under_budget_count` is counted against; a fixture, but a stated one (§19). */
const UNDER_BUDGET_HKD = 200;

/**
 * Programmatic page data (§29/§30). `indexable` is false below the quality bar so the page
 * is built but noindexed — we never publish a thin page just to have a URL.
 */
export function mockProgrammaticPage(city: string, categorySlug: string, subcategorySlug?: string): ProgrammaticPage | null {
  if (city !== SEO_CITY.slug) return null;
  const category = SEO_CATEGORIES.find((entry) => entry.slug === categorySlug);
  if (!category) return null;
  const subcategory = subcategorySlug ? category.subcategories.find((entry) => entry.slug === subcategorySlug) : null;
  if (subcategorySlug && !subcategory) return null;

  const matched = SEED_MERCHANTS.filter((seed) => {
    if (category.seedCategory && seed.category !== category.seedCategory) return false;
    if (!subcategory) return true;
    return subcategory.match(seed);
  });

  const cards = matched.map((seed) => buildCard(seed, { geo: null, group: null }));
  const listings = matched.map((seed) => seedToSeoListing(seed));
  const prices = cards.map((card) => Number(card.price?.amount ?? NaN)).filter((value) => Number.isFinite(value));
  const now = mockNow();

  return {
    city: SEO_CITY.slug,
    category: category.slug,
    subcategory: subcategory?.slug ?? null,
    heading: `${subcategory ? subcategory.zh : category.zh} · ${SEO_CITY.zh}`,
    intro: '',
    listings,
    cards,
    facets: {
      open_now_count: cards.filter((card) => card.open?.is_open).length,
      under_budget_count: cards.filter((card) => card.price && Number(card.price.amount) <= UNDER_BUDGET_HKD).length,
      // The caption states the ceiling the count used, so the page cannot drift from its own number.
      under_budget_hkd: UNDER_BUDGET_HKD,
      districts: Array.from(new Set(matched.map((seed) => DISTRICTS[seed.district]?.name ?? ''))),
      price_range: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    },
    updated_at: now.toISOString(),
    indexable: listings.length >= MIN_LISTINGS_FOR_INDEX,
    reason: listings.length >= MIN_LISTINGS_FOR_INDEX ? 'enough_listings' : 'too_few_listings',
  };
}

/** All (category, subcategory) pairs that actually have listings — feeds generateStaticParams + sitemap. */
export function mockProgrammaticRoutes(): Array<{ city: string; category: string; subcategory: string | null; listings: number }> {
  const routes: Array<{ city: string; category: string; subcategory: string | null; listings: number }> = [];
  for (const category of SEO_CATEGORIES) {
    const parent = SEED_MERCHANTS.filter((seed) => !category.seedCategory || seed.category === category.seedCategory);
    routes.push({ city: SEO_CITY.slug, category: category.slug, subcategory: null, listings: parent.length });
    for (const subcategory of category.subcategories) {
      const count = parent.filter(subcategory.match).length;
      if (count > 0) routes.push({ city: SEO_CITY.slug, category: category.slug, subcategory: subcategory.slug, listings: count });
    }
  }
  return routes;
}

export { SEED_MERCHANTS, DISTRICTS, demoUuid, factUuid };
export type { DistrictKey, GeoPoint };
