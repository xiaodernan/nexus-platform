/**
 * D1567 — the crossing arc (§六): five chapters, one border, a night into a morning.
 *
 * Chapter 64 opens the border's day with Ho Ming's first rice truck through Man Kam To at
 * 00:45; chapter 61 holds the Huanggang night gate at 02:45; chapter 62 walks the night market
 * below Lo Wu at 03:45; chapter 65 brings Ho Ming back for his third run at 07:15; chapter 67
 * rolls his second truck out of the gate at 08:15. An index page is a list, not a path; this
 * module makes the border's hidden line walkable, deterministically and locally: no network,
 * no model, no read-state, no localStorage.
 *
 * The arc is a CURATED fact about the corpus, not a guessed similarity. It names slugs that
 * ship; `crossingArcFor` returns null for any chapter outside the arc, so the caller simply
 * renders nothing elsewhere. Titles are deliberately NOT stored here — the component receives
 * the current locale's guide titles from the same corpus the index serves, so a rename upstream
 * can never leave a stale copy in this rail.
 */

import { arcPositionFor, type StoryArcPosition } from './story-arc';

/** The five chapters of the border's night into morning, in reading order. */
export const CROSSING_ARC_SLUGS = [
  'hk-man-kam-to-driver-chronicle',
  'hk-shenzhen-huanggang-night-gate-chronicle',
  'hk-shenzhen-luohu-night-market-chronicle',
  'hk-man-kam-to-return-chronicle',
  'hk-man-kam-to-second-truck-chronicle',
] as const;

export type CrossingArcPosition = StoryArcPosition;

/** Where a chapter sits in the crossing arc, or null when it is not one of the five. */
export function crossingArcFor(slug: string): CrossingArcPosition | null {
  return arcPositionFor(CROSSING_ARC_SLUGS, slug);
}
