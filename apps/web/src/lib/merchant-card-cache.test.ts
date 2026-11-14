import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * D1079 — the merchant card as a cacheable artifact:
 *   - the loader projects the wire profile exactly like `/m/[slug]`;
 *   - `unstable_cache` is entered with the documented 10-minute TTL and the `merchant-card` tag;
 *   - the read is anonymous by construction (no cookie options on the fetch);
 *   - the hydration consumers (rails-stream, console-consumer) go through this one loader.
 */

const hoisted = vi.hoisted(() => ({
  opts: null as { revalidate?: number; tags?: string[] } | null,
  keyParts: null as string[] | null,
  fn: null as ((id: string) => Promise<unknown>) | null,
  get: vi.fn(),
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (id: string) => Promise<unknown>, keyParts: string[], opts: { revalidate?: number; tags?: string[] }) => {
    hoisted.fn = fn;
    hoisted.keyParts = keyParts;
    hoisted.opts = opts;
    return fn;
  },
}));
vi.mock('./api/base', () => ({ nexusGet: (...args: unknown[]) => hoisted.get(...args) }));

const { getMerchantCard, MERCHANT_CARD_TAG, MERCHANT_CARD_TTL_S } = await import('./merchant-card-cache');

const PROFILE = {
  card_type: 'merchant',
  id: 'card-id-1',
  slug: 'x',
  title: 'X',
  subtitle: '测试',
  description: null,
  image: null,
  price: { amount: '88.00', currency: 'HKD', model: 'per_person' },
  rating: { value: 4.2, count: 9 },
  open: { is_open: true, as_of: '2026-11-13T12:00:00Z', source_fact_id: 'fact-hours' },
  facts: [
    {
      fact_id: 'fact-hours',
      subject_type: 'merchant',
      subject_id: 'card-id-1',
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
      address_line1: '1/F',
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

describe('D1079 merchant-card cache', () => {
  beforeEach(() => {
    hoisted.get.mockReset();
  });

  it('exports the documented tag and TTL and wires them into unstable_cache', () => {
    expect(MERCHANT_CARD_TAG).toBe('merchant-card');
    expect(MERCHANT_CARD_TTL_S).toBe(600);
    expect(hoisted.opts).toMatchObject({ revalidate: 600, tags: ['merchant-card'] });
    expect(hoisted.keyParts).toEqual(['merchant-card']);
  });

  it('projects the public wire profile anonymously (no cookie options on the fetch)', async () => {
    hoisted.get.mockResolvedValueOnce(PROFILE);
    const card = await getMerchantCard('x');
    const call = hoisted.get.mock.calls[0];
    expect(call?.[0]).toBe('platform');
    expect(call?.[1]).toBe('/api/v1/merchants/x');
    expect(call?.[2]).toBeUndefined(); // anonymous: options carry no authorization and no cookie
    expect(card?.id).toBe('card-id-1');
    expect(card?.href).toBe('/m/x');
  });

  it('propagates upstream failures instead of inventing a card', async () => {
    hoisted.get.mockRejectedValueOnce(Object.assign(new Error('upstream_unreachable'), { code: 'upstream_unreachable' }));
    await expect(getMerchantCard('y')).rejects.toThrow('upstream_unreachable');
  });

  it('the hydration consumers import this loader rather than re-projecting inline', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');
    expect(read('apps/web/src/lib/rails-stream.ts')).toContain("from './merchant-card-cache'");
    expect(read('apps/web/src/lib/console-consumer.ts')).toContain("from './merchant-card-cache'");
  });
});
