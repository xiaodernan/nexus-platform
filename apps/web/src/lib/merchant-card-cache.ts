/**
 * The public merchant card as a cacheable artifact.
 *
 * `/api/v1/merchants/{idOrSlug}` is a **public** documented read — the `/m/[slug]` page composes it
 * anonymously today. Public cards therefore carry no caller variance and are ideal material for the
 * cross-request Data Cache: one hydration per merchant per ten minutes, globally, instead of one per
 * page view. Nothing user-specific ever passes through this module — the session cookie is
 * deliberately absent from every call, so the cache key needs no per-user segment.
 *
 * Freshness discipline (§19): the projection is byte-stable JSON, facts carry their own observed-at
 * stamps, and the computed open-state may lag by at most `revalidate` seconds. Cards render stale
 * open badges before they ever render invented numbers — the fact pipeline still decides §19.
 */

import { unstable_cache } from 'next/cache';

import { nexusGet } from './api/base';
import { merchantDetailFrom, type WireMerchantProfile } from './platform-catalog';
import { merchantToCard } from './adapters';
import type { EntityCard } from '@nexus/ui/trust/types';

export const MERCHANT_CARD_TAG = 'merchant-card';
/** Ten minutes: under the fact's own observed-at granularity, over turbulence of the cache plane. */
export const MERCHANT_CARD_TTL_S = 600;

async function loadMerchantCard(idOrSlug: string): Promise<EntityCard | null> {
  const wire = await nexusGet<WireMerchantProfile>('platform', `/api/v1/merchants/${encodeURIComponent(idOrSlug)}`);
  return merchantToCard(merchantDetailFrom(wire));
}

export const getMerchantCard = unstable_cache(
  loadMerchantCard,
  ['merchant-card'],
  {
    revalidate: MERCHANT_CARD_TTL_S,
    tags: [MERCHANT_CARD_TAG],
  },
);
