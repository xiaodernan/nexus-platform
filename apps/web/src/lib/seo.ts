/**
 * The pure half of SEO discovery (§29/§30): turning a normalised list of candidate pages into the
 * sitemap entries a search engine may fetch. It is deliberately free of Next so `seo.test.ts` can
 * exercise the quality-bar and authorization rules without a server, a database, or a request.
 *
 * Two invariants the contract pins down and this module is responsible for:
 *  - Nothing is listed until a human authorises discovery (§27). `authorized === false` emits zero
 *    entries; the route additionally 404s so no empty sitemap ever advertises itself.
 *  - A programmatic page below the content-quality bar is never listed (§29/§30), but its parent
 *    category page still is — the bar is applied per page, not inherited.
 * `lastModified` is only carried when the payload already held a real timestamp; we never invent one
 * (§19/§155), and we never emit `changeFrequency`/`priority` because nothing derives them here.
 */

import { SITE_URL } from './env';

/** One candidate URL before authorization and the quality bar are applied. */
export interface SitemapSource {
  /** Site-relative path, e.g. `/hong-kong/restaurants` or `/m/lung-yuen-kitchen`. Never an origin. */
  path: string;
  /** A real timestamp from the payload (`updated_at`/`published_at`); omit or null when there is none. */
  lastModified?: string | null;
  /** §29/§30 quality gate. Only an explicit `false` suppresses a page; pages with no bar pass through. */
  indexable?: boolean;
}

/** A resolved sitemap row. Structurally a `MetadataRoute.Sitemap` entry, kept Next-free on purpose. */
export interface SitemapEntry {
  url: string;
  lastModified?: string;
}

/** The result-page path a query string produces — a function of `?q=`, never a document (§29). */
function isSearchPath(path: string): boolean {
  return path === '/search' || path.startsWith('/search/') || path.startsWith('/search?');
}

function normalizePath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // Strip any query/fragment defensively: a result page smuggled in as `/search?q=` must still drop out.
  return withSlash.split(/[?#]/, 1)[0] || null;
}

/** Keep a timestamp only when it is a real, parseable value; otherwise emit nothing rather than guess. */
function realTimestamp(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Number.isNaN(Date.parse(trimmed)) ? undefined : trimmed;
}

/**
 * Build the sitemap entries for a candidate list. Returns [] whenever discovery is not authorised,
 * regardless of `pages` — the authorization switch is the gate, not a filter applied afterwards.
 */
export function sitemapEntries(
  pages: readonly SitemapSource[],
  authorized: boolean,
  origin: string = SITE_URL,
): SitemapEntry[] {
  if (!authorized) return [];

  const base = origin.replace(/\/+$/, '');
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];

  for (const source of pages) {
    if (source.indexable === false) continue; // §29/§30: below the bar, never listed.
    const path = normalizePath(source.path);
    if (!path) continue;
    if (isSearchPath(path)) continue; // §29: result pages stay out of the index.

    let url: string;
    try {
      url = new URL(path, base).toString();
    } catch {
      continue; // A malformed origin or path drops the row rather than emitting a broken URL.
    }
    if (!url.startsWith(base)) continue; // Belt-and-braces: every emitted URL is on the site origin.
    if (seen.has(url)) continue; // Dedupe identical URLs (the bare `/{city}` can arrive from every route).

    seen.add(url);
    const entry: SitemapEntry = { url };
    const stamp = realTimestamp(source.lastModified);
    if (stamp) entry.lastModified = stamp;
    entries.push(entry);
  }

  return entries;
}
