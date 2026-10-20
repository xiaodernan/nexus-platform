/**
 * The server-side data plane for apps/web: the only place that decides between the mock fixtures
 * and a live service call. Pages never call `fetch` themselves, and the browser never calls a
 * service origin directly (API_CONTRACT §0) — client components go through `/api/nexus/**`.
 *
 * `NEXT_PUBLIC_DATA_MODE` (default `mock`) keeps `npm run dev` fully reviewable with nothing
 * running (§130), which is also the §105 requirement that the UI must work when the model is down.
 *
 * Failure policy: a live read that fails returns `degraded` with the error code rather than being
 * silently backfilled from mock data. Filling a live page with fixtures would be the §155 failure
 * this whole layer exists to prevent.
 */

import { IS_MOCK } from './env';
import { nexusGet } from './api/base';
import { toGuide, toGuidePage } from './platform-guides';
import {
  merchantDetailFrom,
  offeringFrom,
  pageFrom,
  reviewFrom,
  reviewSummaryFrom,
  slotsFrom,
  type WireAvailability,
  type WireMerchantProfile,
  type WireOffering,
  type WirePage,
  type WireReview,
  type WireReviewSummary,
} from './platform-catalog';
import {
  mockAvailability,
  mockCollection,
  mockCollections,
  mockGuide,
  mockGuides,
  mockHomeRails,
  mockMenu,
  mockMerchant,
  mockOffering,
  mockProgrammaticPage,
  mockProgrammaticRoutes,
  mockReviewSummary,
  mockReviews,
  mockSearch,
  type HomeRails,
} from './mock';
import type {
  AvailabilitySlot,
  Collection,
  CursorPage,
  EntityCard,
  GeoPoint,
  Guide,
  Intent,
  MerchantDetail,
  NexusResult,
  OfferingDetail,
  OfferingSummary,
  ProgrammaticPage,
  Review,
  ReviewSummary,
  SearchResponse,
} from './types';

if (typeof window !== 'undefined') {
  throw new Error('lib/data is server-only: the browser must call /api/nexus/**, never a service origin');
}

/** §105: a partial page with a stated reason beats a fake-complete page. */
function degraded<T>(data: T, mocked: boolean, reason: string): NexusResult<T> {
  return { data, mocked, degraded: true, degradedReason: reason };
}

function reasonOf(cause: unknown): string {
  const code = (cause as { code?: string } | null)?.code;
  return typeof code === 'string' ? code : 'upstream_unreachable';
}

/**
 * "The thing you asked for is not there" is a status, not a code: the platform names each 404 after
 * its subject (`merchant_not_found`, `review_summary_not_found`, `seo_route_not_found`), so comparing
 * `reasonOf` against the literal `'not_found'` — which base.ts only synthesises for a non-JSON body —
 * never matched a real response.
 */
function isNotFound(cause: unknown): boolean {
  return (cause as { status?: number } | null)?.status === 404;
}

/** The mock catalogues are complete arrays; the wire format for a list is the cursor envelope (§1). */
function pageOf<T>(items: T[]): CursorPage<T> {
  return { items, next_cursor: null, total_estimate: items.length };
}

/* ----------------------------------------------------------------- home (§6) */

export interface RailsRequest {
  geo: GeoPoint | null;
  locale: string;
  signedIn: boolean;
}

/**
 * Live rails are composed from documented reads only: `POST /ai/v1/search` with no query text and
 * a sort preference (EntityCards with facts), plus the viewer's own favourites. There is no
 * `/consumer/home` endpoint and this layer will not invent one.
 *
 * The sort preference belongs to the intent (§7.1), not to `filters` — that object is a strict
 * schema, and a `sort` key there is a 422, not a harmless extra.
 */
async function liveSearchRail(
  sort: Intent['sort_preference'],
  geo: GeoPoint | null,
  limit: number,
  locale: string,
): Promise<EntityCard[]> {
  const response = await nexusGet<SearchResponse>('ai', '/ai/v1/search', {
    method: 'POST',
    body: {
      query: '',
      intent: { raw_query: '', sort_preference: sort, language: locale },
      geo,
      limit,
      locale,
    },
  });
  return response.items ?? [];
}

export async function homeRails(request: RailsRequest): Promise<NexusResult<HomeRails>> {
  if (IS_MOCK) return { data: mockHomeRails(request.geo, request.signedIn), mocked: true };

  const rails = await Promise.allSettled([
    liveSearchRail('distance', request.geo, 8, request.locale),
    liveSearchRail(request.signedIn ? 'rating' : 'trending', request.geo, 6, request.locale),
    liveSearchRail('trending', request.geo, 8, request.locale),
    liveSearchRail('price_low', request.geo, 6, request.locale),
    // `/me/favorites` is authenticated; asking it for an anonymous viewer can only 401.
    // A rail with nothing to show is empty, not a failed read (§155).
    request.signedIn
      ? nexusGet<{ items: Array<{ card: EntityCard }> }>('platform', '/api/v1/me/favorites', {
          searchParams: { limit: 6 },
          authorization: null,
        }).then((page) => page.items.map((entry) => entry.card))
      : Promise.resolve([] as EntityCard[]),
  ]);

  const take = (index: number): EntityCard[] => {
    const settled = rails[index];
    return settled?.status === 'fulfilled' ? settled.value : [];
  };
  const failed = rails.filter((rail) => rail.status === 'rejected').length;

  const data: HomeRails = {
    popular_near_you: take(0),
    for_you: take(1),
    trending: take(2),
    recommended: take(3),
    recently_viewed: take(4),
  };
  if (failed === rails.length) throw new Error('all rails failed');
  return failed ? degraded(data, false, `${failed} of ${rails.length} rails unavailable`) : { data, mocked: false };
}

/* ------------------------------------------------------------- search (§7) */

export interface SearchRequest {
  query: string;
  geo: GeoPoint | null;
  locale: string;
  limit?: number;
}

/** Deterministic search — also the §105 target when the SSE stream fails. */
export async function runSearch(request: SearchRequest): Promise<NexusResult<SearchResponse>> {
  if (IS_MOCK) {
    return {
      data: mockSearch({ query: request.query, geo: request.geo, limit: request.limit ?? 12 }),
      mocked: true,
    };
  }
  try {
    const data = await nexusGet<SearchResponse>('ai', '/ai/v1/search', {
      method: 'POST',
      body: {
        query: request.query,
        geo: request.geo,
        limit: request.limit ?? 12,
        context: { locale: request.locale },
      },
    });
    return { data, mocked: false, degraded: data.degraded === true, degradedReason: data.degraded ? 'ai_search_degraded' : null };
  } catch (cause) {
    throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { code: reasonOf(cause) });
  }
}

/* ------------------------------------------------------------ merchant (§4) */

export interface MerchantPage {
  detail: MerchantDetail;
  offerings: CursorPage<OfferingSummary>;
  reviews: CursorPage<Review>;
  summary: ReviewSummary | null;
  availability: AvailabilitySlot[];
}

export async function merchantBySlug(slug: string): Promise<NexusResult<MerchantPage | null>> {
  if (IS_MOCK) {
    const detail = mockMerchant(slug);
    if (!detail) return { data: null, mocked: true };
    return {
      data: {
        detail,
        offerings: mockMenu(slug),
        reviews: mockReviews(slug),
        summary: mockReviewSummary(slug),
        availability: mockAvailability(slug),
      },
      mocked: true,
    };
  }

  const id = encodeURIComponent(slug);
  let detail: MerchantDetail;
  try {
    detail = merchantDetailFrom(await nexusGet<WireMerchantProfile>('platform', `/api/v1/merchants/${id}`));
  } catch (cause) {
    if (isNotFound(cause)) return { data: null, mocked: false };
    throw cause;
  }
  const merchant = { id: detail.id, slug: detail.slug, name: detail.name };

  const [offerings, reviews, summary, availability] = await Promise.allSettled([
    nexusGet<WirePage<WireOffering>>('platform', `/api/v1/merchants/${detail.id}/menu`, { searchParams: { limit: 24 } }),
    nexusGet<WirePage<WireReview>>('platform', `/api/v1/merchants/${detail.id}/reviews`, { searchParams: { sort: 'recent', limit: 10 } }),
    nexusGet<WireReviewSummary>('platform', `/api/v1/merchants/${detail.id}/reviews/summary`),
    nexusGet<WireAvailability>('platform', `/api/v1/merchants/${detail.id}/availability`),
  ]);

  // `summary` is the one optional section: the endpoint answers 404 for a merchant the model has not
  // summarised yet, and an absent section is not a failed read (§105 keeps `degraded` for a stated reason).
  const summaryMissing = summary.status === 'rejected' && isNotFound(summary.reason);
  const failed = [offerings, reviews, availability].filter((part) => part.status === 'rejected').length
    + (summary.status === 'rejected' && !summaryMissing ? 1 : 0);

  const emptyPage = <T>() => ({ items: [] as T[], next_cursor: null, total_estimate: 0 }) as CursorPage<T>;
  const data: MerchantPage = {
    detail,
    offerings: offerings.status === 'fulfilled'
      ? pageFrom(offerings.value, (row) => offeringFrom(row, merchant))
      : emptyPage<OfferingSummary>(),
    reviews: reviews.status === 'fulfilled' ? pageFrom(reviews.value, reviewFrom) : emptyPage<Review>(),
    summary: summary.status === 'fulfilled'
      ? reviewSummaryFrom(summary.value)
      : (detail.review_summary ?? null),
    availability: availability.status === 'fulfilled' ? slotsFrom(availability.value) : [],
  };
  return failed ? degraded(data, false, `${failed} merchant sections unavailable`) : { data, mocked: false };
}

/* ------------------------------------------------------------ offering (§4) */

export async function offeringBySlug(slug: string): Promise<NexusResult<OfferingDetail | null>> {
  if (IS_MOCK) return { data: mockOffering(slug), mocked: true };
  try {
    const data = await nexusGet<OfferingDetail>('platform', `/api/v1/offerings/${encodeURIComponent(slug)}`);
    return { data, mocked: false };
  } catch (cause) {
    if (isNotFound(cause)) return { data: null, mocked: false };
    throw cause;
  }
}

/* ------------------------------------------------- growth + programmatic SEO (§8, §29) */

/**
 * The reads behind the growth + programmatic surface. A by-slug read answers `null` rather than
 * throwing for a slug or route outside the grammar: a 404 is a legitimate answer, and `notFound()`
 * in the page is what turns it into an honest status code.
 *
 * The §30 index/no-index decision is *data*, so it travels on the payload (`indexable`) instead of
 * being recomputed in the web layer — the platform owns the quality bar, and a page that disagrees
 * with its own sitemap entry is the kind of drift this split prevents.
 */

export async function guideBySlug(slug: string): Promise<NexusResult<Guide | null>> {
  if (IS_MOCK) return { data: mockGuide(slug), mocked: true };
  try {
    // Projected, not cast: the platform serves `items` (stored blocks + a resolved `card` each) and the
    // view-model wants `body_blocks`, which it never served. A bare cast is what made this page throw
    // `undefined.map` in live mode — see `platform-guides.ts`.
    const payload = await nexusGet<Record<string, unknown>>('platform', `/api/v1/guides/${encodeURIComponent(slug)}`);
    return { data: toGuide(payload), mocked: false };
  } catch (cause) {
    if (isNotFound(cause)) return { data: null, mocked: false };
    throw cause;
  }
}

/**
 * The list reads degrade to an empty page instead of throwing. `/guides` and `/collections` are
 * reachable from the navigation, and a catalogue the platform has not published yet should answer
 * with its own empty state plus the reason (§105) rather than an error page behind a nav link.
 */
export async function guideList(): Promise<NexusResult<CursorPage<Guide>>> {
  if (IS_MOCK) return { data: pageOf(mockGuides()), mocked: true };
  try {
    const page = await nexusGet<CursorPage<Record<string, unknown>>>('platform', '/api/v1/guides');
    return { data: toGuidePage(page), mocked: false };
  } catch (cause) {
    return degraded(pageOf<Guide>([]), false, reasonOf(cause));
  }
}

export async function collectionBySlug(slug: string): Promise<NexusResult<Collection | null>> {
  if (IS_MOCK) return { data: mockCollection(slug), mocked: true };
  try {
    return {
      data: await nexusGet<Collection>('platform', `/api/v1/collections/${encodeURIComponent(slug)}`),
      mocked: false,
    };
  } catch (cause) {
    if (isNotFound(cause)) return { data: null, mocked: false };
    throw cause;
  }
}

export async function collectionList(): Promise<NexusResult<CursorPage<Collection>>> {
  if (IS_MOCK) return { data: pageOf(mockCollections()), mocked: true };
  try {
    return { data: await nexusGet<CursorPage<Collection>>('platform', '/api/v1/collections'), mocked: false };
  } catch (cause) {
    return degraded(pageOf<Collection>([]), false, reasonOf(cause));
  }
}

export interface SeoRoute {
  city: string;
  category: string;
  subcategory: string | null;
  listings: number;
}

export async function programmaticRoutes(city: string): Promise<NexusResult<SeoRoute[]>> {
  if (IS_MOCK) return { data: mockProgrammaticRoutes().filter((route) => route.city === city), mocked: true };
  const data = await nexusGet<{ routes: SeoRoute[] }>('platform', '/api/v1/seo/routes', { searchParams: { city } });
  return { data: data.routes ?? [], mocked: false };
}

export async function programmaticPage(
  city: string,
  category: string,
  subcategory: string | null,
): Promise<NexusResult<ProgrammaticPage | null>> {
  if (IS_MOCK) return { data: mockProgrammaticPage(city, category, subcategory ?? undefined), mocked: true };
  try {
    const data = await nexusGet<ProgrammaticPage>('platform', '/api/v1/seo/page', {
      searchParams: { city, category, ...(subcategory ? { subcategory } : {}) },
    });
    return { data, mocked: false };
  } catch (cause) {
    if (isNotFound(cause)) return { data: null, mocked: false };
    throw cause;
  }
}
