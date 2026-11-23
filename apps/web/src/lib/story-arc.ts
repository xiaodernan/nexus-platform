/**
 * D1567 — the story-arc primitive shared by every curated arc (§六).
 *
 * A curated arc is a fact about the corpus an editor asserts, not a similarity score the
 * machine guesses. The ticket arc (D1563) was the first; the crossing arc (D1567) is the
 * second. Both need the same walk semantics — 1-based step, honest nulls at the two ends,
 * the full slug order for the numbered path — so that semantics lives here, once, and every
 * arc module stays a thin list of slugs over it. No network, no model, no client state.
 */

export interface StoryArcPosition {
  /** 1-based, for the copy's "{n} of {total}" slot. */
  step: number;
  total: number;
  /** The arc's slugs in reading order; stable, curated, never derived from a similarity score. */
  slugs: readonly string[];
  /** The neighbouring doors, null at the two ends of the arc. */
  prev: string | null;
  next: string | null;
}

/** Where a slug sits in a curated arc, or null when it is not one of its chapters. */
export function arcPositionFor(slugs: readonly string[], slug: string): StoryArcPosition | null {
  const index = slugs.indexOf(slug);
  if (index < 0) return null;
  return {
    step: index + 1,
    total: slugs.length,
    slugs,
    prev: index > 0 ? slugs[index - 1] ?? null : null,
    next: index + 1 < slugs.length ? slugs[index + 1] ?? null : null,
  };
}
