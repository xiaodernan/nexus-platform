/**
 * The home rails (§6) — one composer, one exported loader, zero sharing of mutable state.
 *
 * This module owns two things:
 *
 *  1. `RAIL_DEFS` — the canonical rail order and each rail's fetch shape, in exactly the order the
 *     home page renders them. Exporting it means the page's Suspense placeholders and the
 *     composer's `allSettled` can never drift apart.
 *  2. `loadRailCards` — the per-rail loader used by BOTH the streamed page sections and the
 *     all-in-one `homeRails()` composer (the one tests pin). A rail that cannot be fetched is an
 *     exception at this layer, by design: the composer turns rejections into absent rails (§105);
 *     the page turns each rejection into its own section's small warning note.
 *
 * Failure policy is unchanged (§105, D1011-era comments in data.ts): a live read that fails must
 * NOT be backfilled from mock fixtures; the page may say so, never pretend.
 *
 * Server-only by construction — the module throws in the browser, like `lib/data`.
 */

import { IS_MOCK } from './env';
import { nexusAuthedGet, nexusGet } from './api/base';
import { merchantDetailFrom, type WireMerchantProfile } from './platform-catalog';
import { merchantToCard } from './adapters';
import { mockHomeRails } from './mock';
import type { EntityCard, GeoPoint, Intent, SearchResponse } from './types';

if (typeof window !== 'undefined') {
  throw new Error('lib/rails-stream is server-only: the browser must call /api/nexus/**, never a service origin');
}

export interface RailsRequest {
  geo: GeoPoint | null;
  locale: string;
  signedIn: boolean;
}

export const RAIL_ORDER = ['popular_near_you', 'for_you', 'trending', 'recommended', 'recently_viewed'] as const;
export type RailKey = (typeof RAIL_ORDER)[number];

export const RAIL_DEFS: ReadonlyArray<{ key: RailKey; sort?: Intent['sort_preference']; limit?: number }> = [
  { key: 'popular_near_you', sort: 'distance', limit: 8 },
  { key: 'for_you', sort: 'rating', limit: 6 }, // becomes trending for anonymous viewers
  { key: 'trending', sort: 'trending', limit: 8 },
  { key: 'recommended', sort: 'price_low', limit: 6 },
  { key: 'recently_viewed' }, // favorites; anonymous viewers resolve to [] without a request
];

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

export async function loadRailCards(key: RailKey, request: RailsRequest): Promise<EntityCard[]> {
  if (IS_MOCK) return mockHomeRails(request.geo, request.signedIn)[key] ?? [];
  if (key === 'recently_viewed') {
    if (!request.signedIn) return [];
    // The platform serves bare rows, newest first — `[{ id, subject_type, subject_id, note,
    // created_at }]`, never cards, and `/api/v1/me/favorites` requires the caller's session (§3).
    // Hydration happens here, one authed read per *merchant* subject through the same projection the
    // `/m/[slug]` page uses. Offering/collection/guide rows are not card-hydratable on the platform
    // today (no public offering read door, no collection by id) and are *skipped, not guessed* —
    // the rail would rather be short than lie about a card the platform never served.
    const rows = await nexusAuthedGet<Array<{ subject_type: string; subject_id: string }>>(
      'platform',
      '/api/v1/me/favorites',
      { searchParams: { limit: 6 } },
    );
    const hydrated = await Promise.allSettled(
      (Array.isArray(rows) ? rows : [])
        .filter((row) => row.subject_type === 'merchant')
        .slice(0, 6)
        .map(async (row) => merchantToCard(merchantDetailFrom(
          await nexusAuthedGet<WireMerchantProfile>(
            'platform',
            `/api/v1/merchants/${encodeURIComponent(row.subject_id)}`,
          ),
        ))),
    );
    return hydrated.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  }
  const def = RAIL_DEFS.find((entry) => entry.key === key);
  if (!def?.sort || !def.limit) return [];
  const sort = key === 'for_you' && !request.signedIn ? 'trending' : def.sort;
  return liveSearchRail(sort, request.geo, def.limit, request.locale);
}
