import { describe, expect, it } from 'vitest';

import { toBodyBlocks, toGuide, toGuidePage } from './platform-guides';

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
    const guide = toGuide({
      slug: 'sha-tin-date-night',
      title: 'A Sha Tin Date Night',
      generated_by: 'creator',
      reviewed_by_human: false,
      items: [{ subject_type: 'merchant', subject_id: 'a', card: card('a', 'A') }],
    });
    expect(guide.slug).toBe('sha-tin-date-night');
    expect(guide.generated_by).toBe('creator');
    expect(guide.reviewed_by_human).toBe(false);
    expect(guide.body_blocks).toHaveLength(1);
  });

  it('projects every item of a page, and tolerates a page with no items', () => {
    const page = toGuidePage({ items: [{ slug: 'a', items: [] }, { slug: 'b' }], next_cursor: null });
    expect(page.items.map((g) => g.slug)).toEqual(['a', 'b']);
    expect(page.items.every((g) => Array.isArray(g.body_blocks))).toBe(true);
    expect(toGuidePage({ items: [] }).items).toEqual([]);
  });
});
