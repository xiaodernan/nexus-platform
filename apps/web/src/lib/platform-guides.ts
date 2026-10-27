import { normalizeLocale } from './i18n/dict';
import type { Collection, EntityCard, Guide } from './types';

/**
 * The wire → view-model crossing for the §8 growth surfaces (guides and collections), and the only
 * place that knows the two shapes differ.
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
 *
 * THE SECOND DISAGREEMENT: THE TITLE IS A PAIR, NOT A STRING. `CollectionsController.summary()` serves
 * `title` as `{"en": title, "zh": title_zh}` — one projection shared by `/api/v1/collections`,
 * `/api/v1/guides`, both detail routes and the draft-create answer — because `docs/API_CONTRACT.md:397`
 * promises "`collections.slug`, `title` (+ `title_zh` for the zh-HK locale)" and the row stores two
 * columns. The web's view-model declares `title: string` and rendered the map raw, so all four growth
 * routes answered **HTTP 500** with `Objects are not valid as a React child (found: object with keys
 * {en, zh})`. Mock mode never showed it: `DEMO_GUIDES`/`DEMO_COLLECTIONS` are written in the view-model
 * shape with plain-string titles, so the two planes disagreed and only one of them was ever exercised —
 * the same failure as `body_blocks`, one layer down.
 *
 * So the pair is resolved **by the page's locale**, not by a guess: `zh-HK` reads the `zh` column,
 * `en` reads the `en` one, and a locale with no column falls back to the other rather than to nothing.
 * A title that is already a string passes through — the mock plane and any future wire that serves a
 * plain title must keep working.
 *
 * The narrowing rule here is the same as `platform-catalog.ts`: **narrow where the wire's type differs
 * from the view-model's declared type, and copy the rest.** `generated_by`, `curated_by` and `flags`
 * carry the same unions on both sides (the platform constrains them with its own token lists at write
 * time), so they are spread through untouched; `title`, `description`, `cover_image`, `city`, `category`
 * and a collection's `items` do not, so they are projected.
 */

type Wire = Record<string, unknown>;

function asRecord(value: unknown): Wire | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Wire) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The wire's localized title pair, keyed by the locale that reads it: `zh-HK` reads `zh`, `en` reads `en`. */
const TITLE_KEYS: Record<string, string> = { en: 'en', 'zh-HK': 'zh' };

/**
 * The wire's title → the one string the page renders.
 *
 * The platform serves a pair (`{en, zh}`), the view-model wants a string, and the page knows which
 * locale it is rendering in. So the locale picks the column; a locale with no column of its own falls
 * back to the other one rather than to an empty title, and a wire that already serves a plain string
 * passes straight through.
 */
export function toLocalizedTitle(value: unknown, locale: string): string {
  if (typeof value === 'string') return value;
  const pair = asRecord(value);
  if (!pair) return '';
  const preferred = TITLE_KEYS[normalizeLocale(locale)] ?? 'en';
  const other = preferred === 'en' ? 'zh' : 'en';
  return str(pair[preferred]) ?? str(pair[other]) ?? '';
}

/**
 * The wire's cover image → the view-model's cover. The wire allows a null `alt`; the view-model declares
 * a string, and an empty alt is the honest spelling of "this image carries no alt text" (it also keeps
 * `openGraph.images[].alt` typed). A cover without a url is no cover.
 */
function toCoverImage(value: unknown): Collection['cover_image'] {
  const record = asRecord(value);
  if (!record) return null;
  const url = str(record.url);
  if (url === null) return null;
  return { url, alt: str(record.alt) ?? '', credit: str(record.credit) };
}

/**
 * The wire's resolved cards.
 *
 * A detail view serves two arrays: `items` is what the author wrote (stored references —
 * `{subject_type, subject_id, note, card}`) and `cards` is the same walk with the merchant resolved.
 * The view-model's `items` is a list of `EntityCard`s — the things the page renders — so it is the
 * resolved array, not the stored one. A card the platform could not resolve is absent from `cards` and
 * is named in `dropped_item_ids`; it is never rendered as a placeholder.
 */
function toCards(payload: Wire): EntityCard[] {
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  return cards.filter(asRecord) as unknown as EntityCard[];
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

/** The whole guide, with `body_blocks` derived rather than assumed and the title read for the locale. */
export function toGuide(payload: Wire, locale: string): Guide {
  const base = payload as unknown as Guide;
  return {
    ...base,
    title: toLocalizedTitle(payload.title, locale),
    description: str(payload.description) ?? '',
    city: str(payload.city) ?? '',
    category: str(payload.category) ?? '',
    body_blocks: toBodyBlocks(payload),
  };
}

/**
 * A guide list page, projected item by item. The return type replaces `items` rather than casting the
 * whole page: a cast here is what hid the missing field in the first place, and TypeScript refused the one
 * I tried (`CursorPage<Record<string, unknown>>` does not overlap `CursorPage<Guide>`) — which is the
 * compiler saying the two shapes were never the same shape.
 */
export function toGuidePage<T extends { items?: unknown[] }>(page: T, locale: string): Omit<T, 'items'> & { items: Guide[] } {
  const items = Array.isArray(page.items) ? page.items : [];
  return { ...page, items: items.map((item) => toGuide((asRecord(item) ?? {}) as Wire, locale)) };
}

/**
 * The whole collection. `summary()` is one projection shared by both growth surfaces, so a collection
 * arrives with the same fields a guide does — including the localized title pair.
 */
export function toCollection(payload: Wire, locale: string): Collection {
  const base = payload as unknown as Collection;
  return {
    ...base,
    title: toLocalizedTitle(payload.title, locale),
    description: str(payload.description) ?? '',
    cover_image: toCoverImage(payload.cover_image),
    city: str(payload.city) ?? '',
    category: str(payload.category),
    items: toCards(payload),
  };
}

/** A collection list page, projected item by item — the same shape of page as `toGuidePage`. */
export function toCollectionPage<T extends { items?: unknown[] }>(page: T, locale: string): Omit<T, 'items'> & { items: Collection[] } {
  const items = Array.isArray(page.items) ? page.items : [];
  return { ...page, items: items.map((item) => toCollection((asRecord(item) ?? {}) as Wire, locale)) };
}
