import { describe, expect, it } from 'vitest';

import {
  offeringDetailFrom,
  type WireOfferingDetail,
} from './platform-catalog';

/**
 * D1089 — the offering detail projector contract. The page used to cast the wire straight onto the
 * view-model (`nexusGet<OfferingDetail>` without projection), which compiled and rendered blank for
 * any `undefined` the wire did not send. These arms fail the same way the merchant-profile arms did.
 */

const PRICE_FACT = 'offer-price-fact';
const DETAIL: WireOfferingDetail = {
  offering_id: 'o-1',
  merchant_id: 'm-1',
  kind: 'product',
  slug: 'noodle-box',
  name: 'Noodle Box',
  name_zh: '牛肉麵盒',
  description: 'A tin of noodles',
  price: { amount: '48.00', currency: 'HKD' },
  price_model: 'per_person',
  images: [{ url: '/demo/img/noodles.svg', alt: 'Noodle box', credit: 'synthetic' }],
  rating: { value: 4.5, count: 11 },
  facts: [
    {
      fact_id: PRICE_FACT,
      subject_type: 'offering',
      subject_id: 'o-1',
      attribute: 'price',
      value: { band: '$', model: 'per_person', amount: '48.00', currency: 'HKD', data_origin: 'demo' },
      source: 'merchant',
      confidence: 1,
      observed_at: '2026-11-13T09:00:00Z',
      expires_at: null,
      stale: false,
    },
  ],
  flags: { demo: true, sponsored: false, unverified: true },
  merchant: {
    id: 'm-1',
    slug: 'noodle-shop',
    name: '麵舖',
    district: 'Sha Tin',
    city: 'Hong Kong',
    geo: { lat: 22.38, lng: 114.19 },
  },
};

describe('offeringDetailFrom — wire to view-model, never blank', () => {
  it('projects the full wire exactly: view-model fields match §4', () => {
    const detail = offeringDetailFrom(DETAIL);
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe('o-1');
    expect(detail?.slug).toBe('noodle-box');
    expect(detail?.title).toBe('牛肉麵盒');
    expect(detail?.kind).toBe('product');
    expect(detail?.price?.amount).toBe('48.00');
    expect(detail?.price?.currency).toBe('HKD');
    expect(detail?.price?.model).toBe('per_person');
    expect(detail?.image?.url).toBe('/demo/img/noodles.svg');
    expect(detail?.flags?.demo).toBe(true);
    expect(detail?.facts).toHaveLength(1);
    expect(detail?.merchant.id).toBe('m-1');
    expect(detail?.merchant.slug).toBe('noodle-shop');
    expect(detail?.merchant.name).toBe('麵舖');
    expect(detail?.merchant.district).toBe('Sha Tin');
    expect(detail?.merchant.geo?.lat).toBeCloseTo(22.38);
    expect(detail?.merchant.geo?.lng).toBeCloseTo(114.19);
    expect(detail?.rating).toEqual({ value: 4.5, count: 11 });
    // §20: availability is never invented; the wire never asserted it.
    expect(detail?.availability).toBeNull();
  });

  it('returns null when the merchant block is absent instead of fabricating an empty breadcrumb', () => {
    const rest = { ...DETAIL };
    delete rest.merchant;
    expect(offeringDetailFrom(rest)).toBeNull();
  });

  it('returns null when essential identity fields are missing', () => {
    const noSlug = { ...DETAIL, slug: null as unknown as string };
    expect(offeringDetailFrom(noSlug)).toBeNull();
    const noTitle = { ...DETAIL, name: null as unknown as string, name_zh: null as unknown as string };
    expect(offeringDetailFrom(noTitle)).toBeNull();
  });

  it('accepts missing optional merchant district + geo (untouched, never guessed)', () => {
    const sparse = {
      ...DETAIL,
      merchant: { ...DETAIL.merchant!, district: null, geo: null },
    };
    const detail = offeringDetailFrom(sparse);
    expect(detail?.merchant.district).toBeNull();
    expect(detail?.merchant.geo).toBeNull();
  });

  it('rating absent on the wire yields rating absent on the view-model, never a zero rating', () => {
    const unrated = { ...DETAIL, rating: null };
    expect(offeringDetailFrom(unrated)?.rating).toBeNull();
  });
});
