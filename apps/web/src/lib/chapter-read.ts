/**
 * Shared persistence for "which HK series chapter did I read". Used by the reading-progress
 * strip and the clock timeline alike. Local-first; zero network; zero migration path —
 * a reader who clears storage simply restarts the series, which is honest behavior.
 *
 * Kept dependency-free so it can be imported from any client island on the hub.
 */

export const CHAPTER_READ_KEY = 'nexus.hk-series.read';
const SAFE_PARSE = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((slug): slug is string => typeof slug === 'string');
  } catch {
    return [];
  }
};

export function readChapters(): string[] {
  try {
    if (typeof window === 'undefined') return [];
    return SAFE_PARSE(window.localStorage.getItem(CHAPTER_READ_KEY));
  } catch {
    return [];
  }
}

export function markChapter(slug: string): string[] {
  const current = readChapters();
  if (current.includes(slug)) return current;
  const next = [...current, slug];
  try {
    window.localStorage.setItem(CHAPTER_READ_KEY, JSON.stringify(next));
  } catch {
    /* private mode — session-local intent */
  }
  return next;
}

export function slugFromGuideHref(href: string): string {
  const trimmed = href.replace(/\/$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
