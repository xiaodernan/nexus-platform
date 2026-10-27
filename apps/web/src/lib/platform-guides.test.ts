import { describe, expect, it } from 'vitest';

import { toBodyBlocks, toCollection, toCollectionPage, toGuide, toGuidePage, toLocalizedTitle } from './platform-guides';

/**
 * The wire → view-model projection for §8 guides. These cases are written from what the platform actually
 * serves (`items` + a resolved `card` on each merchant reference, `dropped_item_ids` for what it could not
 * resolve), because the defect this file fixes was exactly a disagreement about that shape: mock mode
 * agreed with the view-model and live mode did not.
 */

const card = (id: string, title: string) =>
  ({ id, slug: id, title, category: 'restaurant' }) as never;

describe('toBodyBlocks', () => {
  it('collects merchant references into one cards block, in author order', () => {
    const blocks = toBodyBlocks({
      items: [
        { subject_type: 'merchant', subject_id: 'a', note: 'Sha Tin · $$', card: card('a', 'A') },
        { subject_type: 'merchant', subject_id: 'b', note: 'Tai Wai · $', card: card('b', 'B') },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'cards', title: 'Sha Tin · $$' });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('keeps the author’s relative order when prose sits between references', () => {
    const blocks = toBodyBlocks({
      items: [
        { type: 'paragraph', text: 'First' },
        { subject_type: 'merchant', subject_id: 'a', card: card('a', 'A') },
        { type: 'heading', text: 'After' },
        { subject_type: 'merchant', subject_id: 'b', card: card('b', 'B') },
      ],
    });
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'cards', 'heading', 'cards']);
  });

  it('drops an unresolved reference instead of rendering a placeholder card', () => {
    const blocks = toBodyBlocks({
      items: [
        { subject_type: 'merchant', subject_id: 'gone', note: 'no card here' },
        { subject_type: 'merchant', subject_id: 'a', card: card('a', 'A') },
      ],
    });
    expect((blocks[0] as { items: { id: string }[] }).items.map((c) => c.id)).toEqual(['a']);
  });

  it('returns an empty list rather than undefined when the wire carries nothing', () => {
    expect(toBodyBlocks({})).toEqual([]);
    expect(toBodyBlocks({ items: [] })).toEqual([]);
    expect(toBodyBlocks({ items: ['not an object', 42, null] })).toEqual([]);
  });

  it('prefers the §8 name when the platform serves it', () => {
    const blocks = toBodyBlocks({
      body_blocks: [{ type: 'paragraph', text: 'Served directly' }],
      items: [{ subject_type: 'merchant', subject_id: 'a', card: card('a', 'A') }],
    });
    expect(blocks).toEqual([{ type: 'paragraph', text: 'Served directly' }]);
  });

  it('never invents text for a typed block that states none', () => {
    expect(toBodyBlocks({ body_blocks: [{ type: 'paragraph' }, { type: 'heading', text: 'kept' }] })).toEqual([
      { type: 'heading', text: 'kept' },
    ]);
  });
});

describe('toGuide / toGuidePage', () => {
  it('derives body_blocks and leaves every other wire field alone', () => {
    const guide = toGuide(
      {
        slug: 'sha-tin-date-night',
        title: 'A Sha Tin Date Night',
        generated_by: 'creator',
        reviewed_by_human: false,
        items: [{ subject_type: 'merchant', subject_id: 'a', card: card('a', 'A') }],
      },
      'en',
    );
    expect(guide.slug).toBe('sha-tin-date-night');
    expect(guide.generated_by).toBe('creator');
    expect(guide.reviewed_by_human).toBe(false);
    expect(guide.body_blocks).toHaveLength(1);
  });

  it('projects every item of a page, and tolerates a page with no items', () => {
    const page = toGuidePage({ items: [{ slug: 'a', items: [] }, { slug: 'b' }], next_cursor: null }, 'en');
    expect(page.items.map((g) => g.slug)).toEqual(['a', 'b']);
    expect(page.items.every((g) => Array.isArray(g.body_blocks))).toBe(true);
    expect(toGuidePage({ items: [] }, 'en').items).toEqual([]);
  });
});

/**
 * The platform's §8 view serves `title` as a localized pair — `CollectionsController.summary()` puts
 * `{"en": title, "zh": title_zh}` in every row it projects — while the view-model declares a string.
 * The four growth routes answered HTTP 500 with "Objects are not valid as a React child (found: object
 * with keys {en, zh})" because the pair was rendered raw. These cases are written from the pair the
 * platform actually serves, not from the mock plane's plain-string titles.
 */
describe('toLocalizedTitle', () => {
  const pair = { en: 'A Sha Tin Date Night', zh: '沙田情侶約會路線' };

  it('reads the column the locale asks for', () => {
    expect(toLocalizedTitle(pair, 'zh-HK')).toBe('沙田情侶約會路線');
    expect(toLocalizedTitle(pair, 'en')).toBe('A Sha Tin Date Night');
  });

  it('falls back to the other column when the locale has none', () => {
    expect(toLocalizedTitle({ en: 'Only English' }, 'zh-HK')).toBe('Only English');
    expect(toLocalizedTitle({ zh: '只有中文' }, 'en')).toBe('只有中文');
  });

  it('passes a plain string through — the mock plane serves one', () => {
    expect(toLocalizedTitle('A Sha Tin Date Night', 'zh-HK')).toBe('A Sha Tin Date Night');
  });

  it('answers an empty string rather than a map when there is no title', () => {
    expect(toLocalizedTitle(null, 'en')).toBe('');
    expect(toLocalizedTitle({}, 'en')).toBe('');
    expect(toLocalizedTitle({ en: null, zh: null }, 'en')).toBe('');
  });
});

describe('toCollection / toCollectionPage', () => {
  const wire = {
    slug: 'tai-wai-under-100',
    title: { en: 'Tai Wai Under HK$100', zh: '大圍百蚊以下' },
    description: '大圍區人均低價位示範之選。',
    cover_image: { url: '/demo/img/restaurant.svg', alt: null, credit: null },
    curated_by: { type: 'creator', name: '陳小姐 (Demo)' },
    updated_at: '2026-09-22T03:00:00Z',
    // The stored references the author wrote — not what the page renders.
    items: [{ subject_type: 'merchant', subject_id: 'a', note: 'Tai Wai · $', card: card('a', 'A') }],
    // The resolved cards, in the same order.
    cards: [card('a', 'A'), card('b', 'B')],
  };

  it('reads the title in the page locale', () => {
    expect(toCollection(wire, 'zh-HK').title).toBe('大圍百蚊以下');
    expect(toCollection(wire, 'en').title).toBe('Tai Wai Under HK$100');
  });

  it('renders the resolved cards, not the stored references', () => {
    const collection = toCollection(wire, 'en');
    expect(collection.items.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('carries a null cover alt as an empty string, not as null', () => {
    expect(toCollection(wire, 'en').cover_image).toEqual({ url: '/demo/img/restaurant.svg', alt: '', credit: null });
  });

  it('treats a cover without a url as no cover at all', () => {
    expect(toCollection({ ...wire, cover_image: { url: null, alt: 'x', credit: null } }, 'en').cover_image).toBeNull();
    expect(toCollection({ ...wire, cover_image: null }, 'en').cover_image).toBeNull();
  });

  it('projects a list page item by item, and a list item has no cards', () => {
    const page = toCollectionPage({ items: [wire, { slug: 'b' }], next_cursor: null }, 'zh-HK');
    const [first, second] = page.items;
    expect(page.items.map((c) => c.title)).toEqual(['大圍百蚊以下', '']);
    expect(first?.items).toHaveLength(2);
    expect(second?.items).toEqual([]);
  });
});
