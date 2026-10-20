import type { EntityCard, Guide } from './types';

/**
 * The wire → view-model crossing for §8 guides, and the only place that knows the two shapes differ.
 *
 * WHY THIS FILE EXISTS. `Guide.body_blocks` is declared **required** in `lib/types.ts` and read with an
 * unguarded `.map` in `growth-view.tsx:72`, but the word `body_blocks` does not occur anywhere in
 * `services/platform/src/main/java` — the platform serves the same content as `items` (the stored blocks,
 * in author order, with a resolved `card` attached to each merchant reference) plus a flat `cards` array.
 * Live mode therefore handed `undefined` to a required field and the guide page threw
 * `Cannot read properties of undefined (reading 'map')`. Mock mode never showed it: `DEMO_GUIDES` is
 * written in the view-model shape, so the two planes disagreed and only one of them was ever exercised.
 *
 * WHAT IT DOES NOT DO. It does not invent a block. The wire's merchant reference
 * (`{subject_type, subject_id, note, card}`) is not the view-model's `cards` block
 * (`{type:'cards', title, items}`), so the projection has to choose a shape — and the honest choice is to
 * collect the resolved cards, in author order, into one `cards` block, and to carry a `note` through as
 * the block's title when the author wrote one. A reference the platform could not resolve carries no
 * `card` and is skipped rather than rendered as a placeholder (§8: "unresolvable ids drop the item, they
 * never render a placeholder card"). A block that already states a `type` is passed through unchanged,
 * because that is the view-model shape already.
 *
 * `body_blocks` present on the wire wins: if the platform starts serving the §8 name (it is documented,
 * so it should), this projection gets out of the way instead of second-guessing it.
 */

type Wire = Record<string, unknown>;

function asRecord(value: unknown): Wire | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Wire) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** One wire item → zero or one view-model block. */
function blockOf(item: unknown): Guide['body_blocks'][number] | null {
  const record = asRecord(item);
  if (!record) {
    // A non-object element is still one of the `item_count` elements the row stores. It cannot be typed,
    // so it is not rendered — but it is not silently turned into an empty paragraph either.
    return null;
  }
  const type = str(record.type);
  if (type === 'paragraph' || type === 'heading') {
    const text = str(record.text);
    return text === null ? null : ({ type, text } as Guide['body_blocks'][number]);
  }
  if (type === 'list') {
    const items = Array.isArray(record.items) ? record.items.filter((v): v is string => typeof v === 'string') : [];
    return items.length === 0 ? null : { type: 'list', items };
  }
  if (type === 'cards') {
    const items = Array.isArray(record.items) ? (record.items.filter(asRecord) as unknown as EntityCard[]) : [];
    return items.length === 0 ? null : { type: 'cards', title: str(record.title) ?? '', items };
  }
  return null;
}

/**
 * The platform's `items` array, projected. Cards are collected in author order into a single `cards`
 * block, placed where the first reference appeared, so the prose and the pictures keep their relative
 * order; any typed block is passed through as itself.
 */
export function toBodyBlocks(payload: Wire): Guide['body_blocks'] {
  const served = payload.body_blocks;
  if (Array.isArray(served)) {
    return served.map(blockOf).filter((block): block is Guide['body_blocks'][number] => block !== null);
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  const blocks: Guide['body_blocks'] = [];
  let cards: EntityCard[] = [];
  let cardsTitle = '';
  let cardsPlaced = false;
  const flush = () => {
    if (cards.length > 0) {
      blocks.push({ type: 'cards', title: cardsTitle, items: cards });
      cards = [];
    }
  };
  for (const item of items) {
    const record = asRecord(item);
    const typed = blockOf(item);
    if (typed) {
      flush();
      cardsPlaced = true;
      blocks.push(typed);
      continue;
    }
    if (!record) continue;
    const card = asRecord(record.card);
    if (card) {
      if (!cardsPlaced) cardsTitle = cardsTitle || str(record.note) || '';
      cards.push(card as unknown as EntityCard);
    }
    // No `card` and no `type`: the platform named it in `dropped_item_ids`. It is not rendered.
  }
  flush();
  return blocks;
}

/** The whole guide, with `body_blocks` derived rather than assumed. */
export function toGuide(payload: Wire): Guide {
  return { ...(payload as unknown as Guide), body_blocks: toBodyBlocks(payload) };
}

/**
 * A guide list page, projected item by item. The return type replaces `items` rather than casting the
 * whole page: a cast here is what hid the missing field in the first place, and TypeScript refused the one
 * I tried (`CursorPage<Record<string, unknown>>` does not overlap `CursorPage<Guide>`) — which is the
 * compiler saying the two shapes were never the same shape.
 */
export function toGuidePage<T extends { items?: unknown[] }>(page: T): Omit<T, 'items'> & { items: Guide[] } {
  const items = Array.isArray(page.items) ? page.items : [];
  return { ...page, items: items.map((item) => toGuide((asRecord(item) ?? {}) as Wire)) };
}
