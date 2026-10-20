import { describe, expect, it } from 'vitest';

import { findFact } from '@nexus/ui/trust/fact';
import { merchantToCard } from './adapters';
import {
  businessHoursFrom,
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

/**
 * The projection is tested against a captured `GET /api/v1/merchants/basil-still-0014` response
 * (2026-09-22, seeded database), trimmed to two offerings. Values are the service's own — the point of
 * the file is that a view-model field is either what the wire said or honestly absent, so a fixture
 * written to match the view-model would prove nothing (§19, §156).
 */

const PRICE_FACT_ID = '3c2f48c4-f2a7-535e-9016-dde6f9068ac8';
const HOURS_FACT_ID = '96ac3414-363b-5250-8ba3-c70796bd2a74';
const PRIMARY = 'dcf82d2d-b48f-5725-84e1-416e028d18a9';
const BRANCH = '396dced9-5dcd-5de2-8d83-50c2a79b2e97';

const profile: WireMerchantProfile = {
  card_type: 'merchant',
  id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
  slug: 'basil-still-0014',
  title: '朗澗小廚',
  subtitle: 'Hot Pot · Sha Tin',
  description: '朗澗小廚係沙田區內餐廳類目嘅火鍋專門店，提供$$價位。（示範資料，並非真實商戶。）',
  image: { url: '/demo/img/restaurant.svg', alt: 'SYNTHETIC DEMO DATA - NOT REAL BUSINESSES', credit: 'synthetic placeholder' },
  price: { amount: '136.70', currency: 'HKD', model: 'per_person' },
  rating: { value: 3.62, count: 8 },
  open: { is_open: false, as_of: '2026-09-21T22:24:21.757728700Z', source_fact_id: HOURS_FACT_ID },
  facts: [
    {
      fact_id: PRICE_FACT_ID,
      subject_type: 'merchant',
      subject_id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
      attribute: 'price',
      value: { band: '$$', model: 'per_person', amount: '136.70', currency: 'HKD', data_origin: 'demo' },
      source: 'merchant',
      confidence: 1,
      observed_at: '2026-09-22T03:00:00Z',
      expires_at: '2026-09-22T09:00:00Z',
      stale: false,
    },
    {
      fact_id: HOURS_FACT_ID,
      subject_type: 'merchant',
      subject_id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
      attribute: 'opening_hours',
      value: {
        zones: [
          { weekday: 0, opens: '12:30', closes: '15:00' },
          { weekday: 0, opens: '18:00', closes: '23:30' },
          { weekday: 2, opens: '18:30', closes: '00:00' },
        ],
        closed_weekday: null,
        data_origin: 'demo',
      },
      source: 'demo',
      confidence: 0.95,
      observed_at: '2026-09-22T03:00:00Z',
      expires_at: '2026-09-23T03:00:00Z',
      stale: false,
    },
  ],
  flags: { sponsored: false, demo: true, unverified: true },
  district: 'Sha Tin',
  city: 'Hong Kong',
  category: 'Hot Pot',
  categories: [
    { category_id: '138d5b70', slug: 'hotpot', name: 'Hot Pot', name_zh: '火鍋', kind: 'merchant', parent_slug: 'restaurant', parent_name: 'Restaurants' },
    { category_id: 'c327af11', slug: 'italian', name: 'Italian', name_zh: '意大利菜', kind: 'merchant', parent_slug: 'restaurant', parent_name: 'Restaurants' },
    { category_id: '5d005be1', slug: 'restaurant', name: 'Restaurants', name_zh: '餐廳', kind: 'merchant', parent_slug: null, parent_name: null },
  ],
  price_band: '$$',
  contact: { site: 'https://basil-still-0014.example.hk', phone: '2013-0000', data_origin: 'demo' },
  // The capture also carries `tags`, an `attributes` blob of amenity booleans (`opens_late`,
  // `wheelchair_access`, …), `data_origin` and `review_stats`. The projection reads none of them:
  // amenity chips need dictionary copy that does not exist yet, so the keys stay out of the wire
  // type rather than being typed to suggest they are handled.
  images: [{ alt: 'SYNTHETIC DEMO DATA - NOT REAL BUSINESSES', url: '/demo/img/restaurant.svg', credit: 'synthetic placeholder' }],
  locations: [
    {
      location_id: PRIMARY,
      label: null,
      address_line1: '1/F, Unit 8, 173 Ning Lane House, Sha Tin',
      address_line2: '沙田寧里173號 大廈8室',
      district: 'Sha Tin',
      city: 'Hong Kong',
      geo: { lat: 22.38, lng: 114.19 },
      mtr: { station: 'Sha Tin', walk_minutes: 15 },
      is_primary: true,
    },
    {
      location_id: BRANCH,
      label: 'Branch',
      address_line1: '1/F, Unit 3, 37 Lok Avenue Commercial Building, Ma On Shan',
      address_line2: null,
      district: 'Ma On Shan',
      city: 'Hong Kong',
      geo: { lat: 22.41, lng: 114.23 },
      mtr: { station: 'Ma On Shan', walk_minutes: 4 },
      is_primary: false,
    },
  ],
  // Weekday 1 rows exist at both locations; weekday 2 closes past midnight at the primary one.
  business_hours: [
    { weekday: 0, opens_at: '12:30', closes_at: '15:00', crosses_midnight: false, location_id: PRIMARY },
    { weekday: 0, opens_at: '18:00', closes_at: '23:30', crosses_midnight: false, location_id: PRIMARY },
    { weekday: 1, opens_at: '12:00', closes_at: '14:30', crosses_midnight: false, location_id: BRANCH },
    { weekday: 1, opens_at: '12:00', closes_at: '14:30', crosses_midnight: false, location_id: PRIMARY },
    { weekday: 1, opens_at: '18:00', closes_at: '23:30', crosses_midnight: false, location_id: PRIMARY },
    { weekday: 2, opens_at: '12:00', closes_at: '14:30', crosses_midnight: false, location_id: PRIMARY },
    { weekday: 2, opens_at: '18:30', closes_at: '00:00', crosses_midnight: true, location_id: PRIMARY },
  ],
  top_offerings: [],
  review_summary: null,
};

const priced: WireOffering = {
  offering_id: '934a8fd7-6624-5e7c-b777-c66341f6b8cd',
  merchant_id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
  kind: 'product',
  slug: 'seafood-broth-base',
  name: 'Seafood Broth Base',
  name_zh: '海皇湯底',
  description: 'Seafood Broth Base — made to order. (synthetic demo data)',
  description_zh: '以傳統方法處理；如需要走辛可於落單時註明。（示範資料）',
  price: { amount: '146.00', currency: 'HKD' },
  price_model: 'from_price',
  images: [{ alt: 'SYNTHETIC DEMO DATA - NOT REAL BUSINESSES', url: '/demo/img/restaurant.svg', credit: 'synthetic' }],
  rating: null,
  facts: [
    {
      fact_id: '7282feaf-5ef4-55ba-8a8f-7b16e130cf22',
      subject_type: 'offering',
      subject_id: '934a8fd7-6624-5e7c-b777-c66341f6b8cd',
      attribute: 'price',
      value: { max: '199.65', min: '146.00', model: 'from_price', amount: '146.00', currency: 'HKD' },
      source: 'merchant',
      confidence: 1,
      observed_at: '2026-09-21T22:21:58Z',
      expires_at: '2026-09-22T04:21:58Z',
      stale: false,
    },
  ],
  flags: { demo: true, estimated_price: false },
};

/** A real row from the same capture: priced on the column, with no `facts` row behind it. */
const unbacked: WireOffering = {
  offering_id: '5b2b3ab7-bfe5-526f-96a4-645eafe3191a',
  merchant_id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
  kind: 'product',
  slug: 'macau-pork-bone-pot-base-weekend',
  name: 'Macau Pork Bone Pot Base, Weekend',
  name_zh: '澳門豬骨煲湯底（週末限定）',
  price: { amount: '226.00', currency: 'HKD' },
  price_model: 'from_price',
  rating: null,
  facts: [],
  flags: { demo: true },
};

const merchant = { id: profile.id as string, slug: profile.slug as string, name: profile.title as string };

describe('merchantDetailFrom — the §4 profile as the page sees it', () => {
  const detail = merchantDetailFrom(profile);

  it('carries the profile fields the cast used to leave blank', () => {
    expect(detail).toMatchObject({
      id: '91a39914-ca22-5d36-b65c-a9197d53d1ec',
      slug: 'basil-still-0014',
      name: '朗澗小廚',
      category: 'Hot Pot',
      avg_price: { amount: '136.70', currency: 'HKD' },
      price_band: 'per_person',
      rating: { value: 3.62, count: 8 },
    });
    expect(detail.tagline).toBeNull();
    expect(detail.attributes).toEqual({ price_band: ['$$'] });
    expect(detail.cuisine).toEqual(['Italian', 'Restaurants']);
    expect(detail.images[0]).toMatchObject({ url: '/demo/img/restaurant.svg', credit: 'synthetic placeholder' });
    expect(detail.flags).toMatchObject({ demo: true, unverified: true });
  });

  it('states an address per location and the phone only against the primary one', () => {
    expect(detail.locations).toHaveLength(2);
    const [primary, branch] = detail.locations;
    expect(primary?.address).toBe('1/F, Unit 8, 173 Ning Lane House, Sha Tin, 沙田寧里173號 大廈8室');
    expect(primary?.mtr).toEqual({ station: 'Sha Tin', walk_minutes: 15 });
    expect(primary?.phone).toBe('2013-0000');
    expect(branch?.phone).toBeNull();
    expect(branch?.name).toBe('Branch');
    expect(branch?.address).toBe('1/F, Unit 3, 37 Lok Avenue Commercial Building, Ma On Shan');
  });

  it('refuses a profile that cannot name itself', () => {
    expect(() => merchantDetailFrom({ id: 'x', slug: 'y' })).toThrow(/merchant_profile_incomplete/);
  });
});

describe('businessHoursFrom — the two conventions the wire does not share', () => {
  const days = businessHoursFrom(profile.business_hours, profile.locations);

  it('reads the primary location only, so a branch schedule cannot leak into the profile', () => {
    // Platform weekday 1 is Tuesday; the BRANCH row for it is the extra one that must be dropped.
    const tuesday = days.find((day) => day.weekday === 2);
    expect(tuesday?.ranges).toEqual([
      { open: '12:00', close: '14:30', crosses_midnight: false },
      { open: '18:00', close: '23:30', crosses_midnight: false },
    ]);
  });

  it('numbers weekdays the way WEEKDAY_LABELS does (0=Sun), not the way the column does (0=Mon)', () => {
    expect(days.map((day) => day.weekday)).toEqual([1, 2, 3]);
    // Column 0 = Monday → UI 1; column 2 = Wednesday → UI 3, which keeps the cross-midnight row on its own day.
    const wednesday = days.find((day) => day.weekday === 3);
    expect(wednesday?.ranges?.[1]).toEqual({ open: '18:30', close: '00:00', crosses_midnight: true });
  });

  it('says nothing about a weekday the service never described', () => {
    // Column 1 = Tuesday had rows, column 3 = Thursday had none: absence, not a closure claim.
    expect(days.some((day) => day.weekday === 4)).toBe(false);
    expect(days.every((day) => day.closed === undefined)).toBe(true);
  });
});

describe('the trust chain the merchant page renders through', () => {
  const card = merchantToCard(merchantDetailFrom(profile), new Date('2026-09-22T04:00:00Z'));

  it('resolves the stored `opening_hours` fact as the hours claim the badge may cite', () => {
    const hours = findFact(card, 'business_hours');
    expect(hours?.fact_id).toBe(HOURS_FACT_ID);
    expect(card.open?.source_fact_id).toBe(HOURS_FACT_ID);
  });

  it('keeps a rating with no fact of its own unrenderable rather than showing the column', () => {
    expect(findFact(card, 'rating')).toBeNull();
    // The number still travels on the card; the renderer decides, and it must decide 未验证.
    expect(card.rating).toEqual({ value: 3.62, count: 8 });
  });

  it('opens the price from its own fact', () => {
    expect(findFact(card, 'price')?.fact_id).toBe(PRICE_FACT_ID);
  });
});

describe('offeringFrom', () => {
  const pricedView = offeringFrom(priced, merchant);
  const unbackedView = offeringFrom(unbacked, merchant);

  it('titles, prices and attributes a menu row without inventing anything', () => {
    expect(pricedView).toMatchObject({
      id: '934a8fd7-6624-5e7c-b777-c66341f6b8cd',
      slug: 'seafood-broth-base',
      title: '海皇湯底',
      kind: 'product',
      description: '以傳統方法處理；如需要走辛可於落單時註明。（示範資料）',
      price: { amount: '146.00', currency: 'HKD', model: 'from' },
      merchant,
    });
    expect(pricedView?.facts).toHaveLength(1);
  });

  it('leaves an unbacked price unbacked instead of borrowing the column as a fact', () => {
    expect(unbackedView?.price?.amount).toBe('226.00');
    expect(unbackedView?.facts).toEqual([]);
  });

  it('drops a row the card cannot render', () => {
    expect(offeringFrom({ offering_id: null, slug: 'x', name: 'Y' }, merchant)).toBeNull();
    expect(offeringFrom({ offering_id: 'x', slug: 'y' }, merchant)).toBeNull();
  });

  it('keeps a currency-less price out of the card rather than defaulting to HKD', () => {
    expect(offeringFrom({ ...priced, price: { amount: '146.00' } }, merchant)?.price).toBeNull();
  });
});

describe('pageFrom', () => {
  const menu: WirePage<WireOffering> = { items: [priced, unbacked], next_cursor: null, total_estimate: 20 };

  it('keeps the envelope and projects every readable row', () => {
    const page = pageFrom(menu, (row) => offeringFrom(row, merchant));
    expect(page.total_estimate).toBe(20);
    expect(page.items.map((item) => item.title)).toEqual(['海皇湯底', '澳門豬骨煲湯底（週末限定）']);
  });

  it('treats a missing page as an empty one', () => {
    expect(pageFrom<WireOffering, never>(null, () => null)).toEqual({ items: [], next_cursor: null, total_estimate: null });
  });
});

describe('reviewFrom / reviewSummaryFrom (§55 evidence)', () => {
  const row: WireReview = {
    review_id: 'fa336079-510c-5463-a8c1-dad17efae864',
    author: { user_id: null, display_name: '親子客' },
    rating: 2.3,
    title: '太吵',
    body: '週末早午餐，揀咗沙田呢間，服務有禮但普通。',
    helpful_count: 0,
    verified_purchase: false,
    verified_reservation: false,
    created_at: '2026-07-25T23:57:00Z',
    flags: { demo: true, verified_visit: false },
  };

  it('quotes the reviewer rather than rewriting them', () => {
    const review = reviewFrom(row);
    expect(review?.text).toBe('太吵：週末早午餐，揀咗沙田呢間，服務有禮但普通。');
    expect(review?.author.display_name).toBe('親子客');
    expect(review?.verified_reservation).toBe(false);
    expect(review?.flags.demo).toBe(true);
  });

  it('turns praise and complaint bullets into themes without a narrative it was not given', () => {
    const summary: WireReviewSummary = {
      merchant_id: merchant.id,
      overall: 3.6,
      praise: [{ label: { zh: '服務有禮' }, evidence_count: 4, review_ids: ['a', 'b'] }],
      complaints: [{ label: ' noisy ', evidence_count: 2, review_ids: ['b', 'c'] }],
      sample_size: 6,
      model: 'mock',
      generated_at: '2026-09-21T20:00:00Z',
      evidence_review_ids: ['a', 'b', 'c'],
      text: null,
      flags: { demo: true, sponsored: false },
    };
    const view = reviewSummaryFrom(summary);
    expect(view?.summary).toBeNull();
    expect(view?.themes).toEqual([
      { label: '服務有禮', sentiment: 'positive', mentions: 4, review_ids: ['a', 'b'] },
      { label: 'noisy', sentiment: 'negative', mentions: 2, review_ids: ['b', 'c'] },
    ]);
    expect(view?.evidence_review_ids).toEqual(['a', 'b', 'c']);
    expect(view?.model).toBe('mock');
  });

  it('has nothing to say about a bullet with no evidence count, and no summary without a generation time', () => {
    expect(reviewSummaryFrom({ praise: [{ label: 'x' }], generated_at: 'now' })?.themes).toEqual([]);
    expect(reviewSummaryFrom({ praise: [], generated_at: null })).toBeNull();
    expect(reviewSummaryFrom(null)).toBeNull();
  });
});

describe('slotsFrom', () => {
  const page: WireAvailability = {
    party_size: 2,
    slots: [
      { id: 's1', starts_at: '2026-09-22T04:00:00Z', capacity_total: 4, capacity_left: 2 },
      { id: 's2', starts_at: '2026-09-22T05:30:00Z', capacity_total: 4, capacity_left: 0 },
      { id: 's3', starts_at: '2026-09-22T06:00:00Z', capacity_total: 8, capacity_left: 8, pool: { capacity: 8 } },
      { id: null, starts_at: '2026-09-22T07:00:00Z', capacity_total: 4, capacity_left: 4 },
    ],
  };

  it('derives the strip status from the two capacity columns it is given', () => {
    expect(slotsFrom(page)).toEqual([
      { slot_id: 's1', starts_at: '2026-09-22T04:00:00Z', party_size: 2, status: 'limited', remaining: 2 },
      { slot_id: 's2', starts_at: '2026-09-22T05:30:00Z', party_size: 2, status: 'full', remaining: 0 },
      { slot_id: 's3', starts_at: '2026-09-22T06:00:00Z', party_size: 2, status: 'available', remaining: 8 },
    ]);
  });

  it('reads an absent slot list as no slots, not as a closed merchant', () => {
    expect(slotsFrom({})).toEqual([]);
    expect(slotsFrom(null)).toEqual([]);
  });
});
