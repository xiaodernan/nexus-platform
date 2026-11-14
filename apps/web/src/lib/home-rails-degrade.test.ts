import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as EnvModule from './env';
import type { EntityCard } from '@nexus/ui/trust/types';

/**
 * The home page's failure policy (§105), pinned where it is decided.
 *
 * `homeRails` composes five rails and has always said that "the rails that could not be fetched are
 * simply absent" — but it used to `throw` when every rail failed, which is the one case a reader of
 * that sentence would not expect, and which the page cannot render as anything but its error
 * boundary. Two facts made this worth a test rather than a comment:
 *
 *  (a) all-fail is a real state for a SIGNED-IN viewer (five rejecting rails), and it produced a
 *      crash page instead of the degraded banner the page already renders for four;
 *  (b) from `/` it was UNREACHABLE. The page passes `signedIn: false`, so the favourites rail is
 *      `Promise.resolve([])` and cannot reject: an anonymous viewer fails at most 4 of 5. The
 *      ledger filed the throw as the cause of six e2e reds it could not have caused — those are
 *      the four search rails being unreachable, which is a degraded page, not a crash.
 *
 * So the assertions are: every failure count from 1 to 5 degrades, none throws, the reason names
 * the count and the denominator, and the anonymous shape can only ever reach 4.
 */

const get = vi.hoisted(() => vi.fn());
const authedGet = vi.hoisted(() => vi.fn());

vi.mock('./env', async (importOriginal) => ({ ...(await importOriginal<typeof EnvModule>()), IS_MOCK: false }));
vi.mock('./api/base', () => ({ nexusGet: get, nexusAuthedGet: authedGet }));

const { homeRails } = await import('./data');

/** Only the field the rails carry through exists; nothing here reads a card. */
function card(id: string): EntityCard {
  return { id } as unknown as EntityCard;
}

/**
 * A minimal-but-valid wire merchant profile (the shape `merchantDetailFrom` projects). Required
 * fields only; the rail test needs a card out the other end, not the full captured 2026-09-22 row.
 */
const wireProfile = {
  card_type: 'merchant',
  id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
  slug: 'm-1',
  title: '测试熟食档',
  subtitle: 'Cha Chaan Teng · Sha Tin',
  description: null,
  image: null,
  price: { amount: '88.00', currency: 'HKD', model: 'per_person' },
  rating: { value: 4.5, count: 12 },
  open: { is_open: true, as_of: '2026-11-13T12:00:00Z', source_fact_id: 'fact-hours' },
  facts: [
    {
      fact_id: 'fact-hours',
      subject_type: 'merchant',
      subject_id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
      attribute: 'opening_hours',
      value: { zones: [{ weekday: 2, opens: '09:00', closes: '22:00' }], closed_weekday: null, data_origin: 'seed' },
      source: 'merchant',
      confidence: 1,
      observed_at: '2026-11-12T09:00:00Z',
      expires_at: null,
      stale: false,
    },
  ],
  flags: { sponsored: false, demo: true, unverified: true },
  district: 'Sha Tin',
  city: 'Hong Kong',
  category: 'Cha Chaan Teng',
  categories: [{ category_id: 'c1', slug: 'cha-chaan-teng', name: 'Cha Chaan Teng', name_zh: '茶餐廳', kind: 'merchant', parent_slug: null, parent_name: null }],
  price_band: '$',
  contact: null,
  images: [],
  locations: [
    {
      location_id: 'loc-1',
      label: null,
      address_line1: '1/F Test Plaza',
      address_line2: null,
      district: 'Sha Tin',
      city: 'Hong Kong',
      geo: { lat: 22.38, lng: 114.19 },
      mtr: null,
      is_primary: true,
    },
  ],
  business_hours: [],
  top_offerings: [],
  review_summary: null,
};

const request = { geo: { lat: 22.2817, lng: 114.1585 }, locale: 'zh-HK' };

beforeEach(() => {
  get.mockReset();
  authedGet.mockReset();
});

describe('homeRails — a page with a stated reason, never a crash', () => {
  it('degrades on all five failing instead of throwing', async () => {
    get.mockRejectedValue(new Error('upstream_unreachable'));
    // The favourites rail reads the *authed* platform plane, so its rejection lives behind a
    // different double — a signed-in all-fail is still a real, renderable state.
    authedGet.mockRejectedValue(new Error('upstream_unreachable'));

    const result = await homeRails({ ...request, signedIn: true });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('5 of 5 rails unavailable');
    expect(result.data).toEqual({
      popular_near_you: [],
      for_you: [],
      trending: [],
      recommended: [],
      recently_viewed: [],
    });
    expect(get).toHaveBeenCalledTimes(4);
    expect(authedGet).toHaveBeenCalledTimes(1);
  });

  it('degrades on four of five, the worst an anonymous viewer can reach', async () => {
    get.mockRejectedValue(new Error('upstream_unreachable'));

    const result = await homeRails({ ...request, signedIn: false });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('4 of 5 rails unavailable');
    // The favourites rail is never asked for an anonymous viewer: asking it can only 401 (§155).
    expect(get).toHaveBeenCalledTimes(4);
    expect(authedGet).not.toHaveBeenCalled();
    expect(get.mock.calls.every(([target]) => target === 'ai')).toBe(true);
  });

  it('degrades on one of five and keeps the four that answered', async () => {
    get
      .mockResolvedValueOnce({ items: [card('a')] })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ items: [card('b')] })
      .mockResolvedValueOnce({ items: [card('c')] });

    const result = await homeRails({ ...request, signedIn: false });

    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBe('1 of 5 rails unavailable');
    expect(result.data.popular_near_you).toEqual([card('a')]);
    expect(result.data.for_you).toEqual([]);
    expect(result.data.trending).toEqual([card('b')]);
    expect(result.data.recommended).toEqual([card('c')]);
  });

  it('is not degraded when every rail answers, and places each rail in its documented slot', async () => {
    get
      .mockResolvedValueOnce({ items: [card('near')] })
      .mockResolvedValueOnce({ items: [card('rating')] })
      .mockResolvedValueOnce({ items: [card('trending')] })
      .mockResolvedValueOnce({ items: [card('cheap')] });
    // The platform serves bare favourite rows (§3), never cards; the rail hydrates one read per
    // merchant subject through the same projection /m/[slug] uses.
    authedGet
      .mockResolvedValueOnce([{ subject_type: 'merchant', subject_id: 'm-1' }])
      .mockResolvedValueOnce(wireProfile);

    const result = await homeRails({ ...request, signedIn: true });

    expect(result.degraded).toBeUndefined();
    expect(result.mocked).toBe(false);
    expect(result.data.popular_near_you).toEqual([card('near')]);
    expect(result.data.for_you).toEqual([card('rating')]);
    expect(result.data.trending).toEqual([card('trending')]);
    expect(result.data.recommended).toEqual([card('cheap')]);
    expect(result.data.recently_viewed).toHaveLength(1);
    expect(result.data.recently_viewed[0]?.id).toBe('91a39914-ca22-5d36-b65c-a9197d53d1ec');
    expect(authedGet).toHaveBeenCalledTimes(2);
  });
});
