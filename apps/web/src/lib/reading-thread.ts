/**
 * The reading thread — which door to open next, and why (§六).
 *
 * The HK corpus is 175 series chapters plus two demo guides, and an index page is a list, not a
 * path: a reader who has read
 * eleven of them has no answer to "what now", and an open world that cannot answer that is a world
 * the reader leaves. This module answers it from what the reader has already read, deterministically,
 * with no network and no model call: the same read-set always produces the same thread, on any
 * machine, in any locale, because the tie-break is the slug and nothing else.
 *
 * The measure is overlap over CHARACTER BIGRAMS and Latin words, cosine-normalised, so a long chapter
 * and a short one are compared on the same scale (Jaccard would punish length, and the corpus mixes
 * 400-character chapters with 3,000-character ones). The thread is then chosen greedily with a
 * diversity rule — no two steps may be reached through the same read chapter — so the three doors a
 * reader is offered span the world they have already walked instead of clustering in one corner of it.
 *
 * Everything here is pure: `guides` and `readSlugs` in, `ThreadStep[]` out. The island reads the
 * read-set from `chapter-read.ts` (localStorage, `nexus.hk-series.read`) and hands it here.
 */

import type { Guide } from './types';

export interface ThreadStep {
  slug: string;
  title: string;
  /** 0..1 — the strongest overlap this chapter has with any chapter the reader finished. */
  score: number;
  /** The chapter the thread reaches this one THROUGH — the reader's own reading history. */
  via: string | null;
  /** The words the two chapters share, most distinctive first — the reason the door was offered. */
  shared: string[];
  href: string;
}

export interface ThreadProgress {
  read: number;
  total: number;
  /** 0..100, rounded — the completion the island prints. */
  percent: number;
}

const LATIN = /[a-z0-9]+/g;

/** The chapter's own words: CJK character bigrams plus every Latin word, lowercased. */
export function threadTokens(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(LATIN)) out.add(match[0]);
  const run: string[] = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const left = run[i];
      const right = run[i + 1];
      if (left !== undefined && right !== undefined) out.add(left + right);
    }
    run.length = 0;
  };
  for (const ch of lower) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) run.push(ch);
    else flush();
  }
  flush();
  return out;
}

function guideText(guide: Guide): string {
  const blocks = guide.body_blocks ?? [];
  const parts: string[] = [guide.title, guide.description];
  for (const block of blocks) {
    if (block.type === 'paragraph' || block.type === 'heading') parts.push(block.text);
    else if (block.type === 'list') parts.push(...block.items);
    else parts.push(block.title);
  }
  return parts.join('\n');
}

/** How much of the reader's world this door continues: the best single-chapter overlap, 0..1. */
function affinity(tokens: Set<string>, readTokens: Set<string>): { score: number; shared: string[] } {
  if (tokens.size === 0 || readTokens.size === 0) return { score: 0, shared: [] };
  const shared: string[] = [];
  for (const token of tokens) if (readTokens.has(token)) shared.push(token);
  if (shared.length === 0) return { score: 0, shared: [] };
  const denom = Math.sqrt(tokens.size * readTokens.size);
  return { score: shared.length / denom, shared };
}

export function threadProgress(guides: readonly Guide[], readSlugs: readonly string[]): ThreadProgress {
  const read = new Set(readSlugs);
  const total = guides.length;
  const done = guides.filter((guide) => read.has(guide.slug)).length;
  return { read: done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The next doors, best first, never two through the same read chapter.
 *
 * An empty read-set answers an empty thread on purpose: a reader who has read nothing has no world
 * to continue, and the island shows the "start anywhere" state rather than an arbitrary ranking.
 */
export function readingThread(
  guides: readonly Guide[],
  readSlugs: readonly string[],
  options: { steps?: number } = {},
): ThreadStep[] {
  const steps = Math.max(1, options.steps ?? 3);
  const read = new Set(readSlugs);
  const unread = guides.filter((guide) => !read.has(guide.slug));
  if (unread.length === 0) return [];

  const readGuides = guides.filter((guide) => read.has(guide.slug));
  if (readGuides.length === 0) return [];

  const tokenCache = new Map<string, Set<string>>();
  const tokensOf = (guide: Guide): Set<string> => {
    let hit = tokenCache.get(guide.slug);
    if (!hit) {
      hit = threadTokens(guideText(guide));
      tokenCache.set(guide.slug, hit);
    }
    return hit;
  };

  // One pass over the read set per unread chapter: the best overlap and the chapter it comes from.
  const best = new Map<string, { score: number; via: string; shared: string[] }>();
  for (const guide of unread) {
    const tokens = tokensOf(guide);
    let top = { score: 0, via: '', shared: [] as string[] };
    for (const source of readGuides) {
      const { score, shared } = affinity(tokens, tokensOf(source));
      if (score > top.score) top = { score, via: source.slug, shared };
    }
    if (top.score > 0) best.set(guide.slug, top);
  }
  if (best.size === 0) return [];

  // Distinctive first: a shared word that few chapters carry is a reason; a word every chapter
  // carries is noise. Frequency is counted over the corpus the reader was handed.
  const frequency = new Map<string, number>();
  for (const guide of guides) {
    for (const token of tokensOf(guide)) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  const ranked = [...best.entries()]
    .map(([slug, hit]) => ({ slug, ...hit }))
    .sort((a, b) => (b.score - a.score) || a.slug.localeCompare(b.slug));

  const out: ThreadStep[] = [];
  const usedVia = new Set<string>();
  for (const candidate of ranked) {
    if (out.length >= steps) break;
    if (usedVia.has(candidate.via)) continue;
    usedVia.add(candidate.via);
    const guide = unread.find((item) => item.slug === candidate.slug);
    if (!guide) continue;
    const shared = [...candidate.shared]
      .sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0)
        || b.length - a.length || a.localeCompare(b))
      .slice(0, 3);
    out.push({
      slug: guide.slug,
      title: guide.title,
      score: Math.round(candidate.score * 1000) / 1000,
      via: candidate.via,
      shared,
      href: `/guides/${guide.slug}`,
    });
  }
  return out;
}


export interface RelatedChapter {
  slug: string;
  title: string;
  score: number;
  shared: string[];
  href: string;
}

/**
 * The chapters that stand CLOSEST to the one being read — the thread engine run in one direction.
 *
 * The reading thread answers "what next, from what I finished"; this answers "what else is about
 * this", which is the other half of not getting lost in 177 chapters: a reader at the bottom of a
 * chapter should be handed its neighbours rather than an index. Deterministic, no network, no
 * identity — the same chapter always shows the same neighbours.
 */
export function relatedChapters(
  guides: readonly Guide[],
  slug: string,
  options: { steps?: number } = {},
): RelatedChapter[] {
  const steps = Math.max(1, options.steps ?? 3);
  const current = guides.find((guide) => guide.slug === slug);
  if (!current) return [];

  const tokens = threadTokens(guideText(current));
  if (tokens.size === 0) return [];

  const frequency = new Map<string, number>();
  for (const guide of guides) {
    for (const token of threadTokens(guideText(guide))) {
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }

  return guides
    .filter((guide) => guide.slug !== slug)
    .map((guide) => {
      const other = threadTokens(guideText(guide));
      const shared: string[] = [];
      for (const token of tokens) if (other.has(token)) shared.push(token);
      const score = shared.length / Math.sqrt(tokens.size * other.size || 1);
      return {
        slug: guide.slug,
        title: guide.title,
        score: Math.round(score * 1000) / 1000,
        shared: shared
          .sort((a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0)
            || b.length - a.length || a.localeCompare(b))
          .slice(0, 3),
        href: `/guides/${guide.slug}`,
      };
    })
    .filter((entry) => entry.score > 0 && entry.shared.length > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    .slice(0, steps);
}


export interface StarterChapter {
  slug: string;
  title: string;
  /** How many other chapters this one connects to — the hub's degree in the affinity graph. */
  degree: number;
  href: string;
}

/**
 * Where a reader with NO history should start.
 *
 * The thread needs a read-set and the radar needs a current chapter; a first-time visitor has
 * neither, and "start anywhere" is the answer that loses them (§六: 防止迷失、失去耐心). The honest
 * replacement is the HUBS: the chapters that share words with the most other chapters, so wherever
 * the reader goes next, the path back into the world is short. Deterministic — the same corpus
 * always names the same three doors.
 */
export function starterChapters(
  guides: readonly Guide[],
  options: { steps?: number } = {},
): StarterChapter[] {
  const steps = Math.max(1, options.steps ?? 3);
  if (guides.length < 2) return [];

  const tokens = new Map<string, Set<string>>();
  for (const guide of guides) tokens.set(guide.slug, threadTokens(guideText(guide)));

  // Measured on the shipped corpus: the DEGREE saturates — with a one-shared-bigram threshold
  // every chapter already connects to all 178 others, and with a two-bigram threshold nothing
  // connects at all. So the degree is a true statement about reach ("this chapter connects to
  // essentially the whole book") and NOT the ranking; the ranking is the affinity MASS, which
  // spreads (44.55 at the top against 43.70 and down from there) and is what actually separates a
  // hub from a leaf. Both are computed; the degree is displayed, the mass decides.
  const degrees = new Map<string, number>();
  const mass = new Map<string, number>();
  for (const guide of guides) {
    const mine = tokens.get(guide.slug) ?? new Set<string>();
    let degree = 0;
    let total = 0;
    for (const other of guides) {
      if (other.slug === guide.slug) continue;
      const theirs = tokens.get(other.slug) ?? new Set<string>();
      let shared = 0;
      for (const token of mine) if (theirs.has(token)) shared += 1;
      if (shared >= 1) {
        degree += 1;
        total += shared / Math.sqrt(mine.size * theirs.size || 1);
      }
    }
    degrees.set(guide.slug, degree);
    mass.set(guide.slug, total);
  }

  return guides
    .map((guide) => ({
      slug: guide.slug,
      title: guide.title,
      degree: degrees.get(guide.slug) ?? 0,
      href: `/guides/${guide.slug}`,
    }))
    .filter((entry) => entry.degree > 0)
    .sort((a, b) => b.degree - a.degree
      || (mass.get(b.slug) ?? 0) - (mass.get(a.slug) ?? 0)
      || a.slug.localeCompare(b.slug))
    .slice(0, steps);
}
