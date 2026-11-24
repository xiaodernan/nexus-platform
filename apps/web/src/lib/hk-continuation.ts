/** D1580 — the hub's post-106 dead end, closed with a derived continuation rail. Pure, offline. */
import type { Guide } from './types';

export interface HkContinuationChapter {
  slug: string;
  title: string;
  number: number;
  href: string;
}

export interface HkContinuation {
  total: number;
  chapters: HkContinuationChapter[];
}

/**
 * The hub's clock strip and "continue reading" are curated to 106 chapters, while the corpus is
 * 185 and keeps growing. This takes the newest N chapters from the REAL corpus, so the primary
 * hub always offers a way forward; numbering comes from corpus position, not a hand-kept claim.
 */
export function hkContinuation(guides: Guide[], limit = 8): HkContinuation {
  const hk = guides.filter((g) => g.slug.startsWith('hk-'));
  const tail = hk.slice(Math.max(0, hk.length - Math.max(1, limit)));
  const first = hk.length - tail.length + 1;
  return {
    total: hk.length,
    chapters: tail.map((g, i) => ({
      slug: g.slug,
      title: g.title,
      number: first + i,
      href: `/guides/${g.slug}`,
    })),
  };
}
