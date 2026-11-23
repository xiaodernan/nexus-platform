/**
 * D1563 — the ticket arc (§六): five chapters, one object, a whole day.
 *
 * Chapters 179–183 tell one continuous story about a single ticket: it is found without a
 * name, kept, waited with, given a second name, claimed, given a third, carried across the
 * harbour and left it beside ANOTHER ticket already waiting at the terminus. An index page is a
 * list, not a path; a reader who lands on chapter 181 in a search has no way to see that the
 * chapter before and after it are part of the same story. This module makes that hidden arc
 * walkable, deterministically and locally: no network, no model, no read-state, no localStorage.
 *
 * The arc is a CURATED fact about the corpus, not a guessed similarity. It names slugs that
 * ship; `ticketArcFor` returns null for any chapter outside the arc, so the caller simply
 * renders nothing elsewhere. Titles are deliberately NOT stored here — the component receives
 * the current locale's guide titles from the same corpus the index serves, so a rename upstream
 * can never leave a stale copy in this rail.
 *
 * D1567: the walk semantics moved into the shared story-arc primitive; this module stays the
 * curated slug list over it, and its exports are unchanged.
 */

import { arcPositionFor, type StoryArcPosition } from './story-arc';

/** The five chapters of the ticket's day, in reading order. */
export const TICKET_ARC_SLUGS = [
  'hk-sha-tin-shui-chuen-o-nameless-ticket-chronicle',
  'hk-sha-tin-shui-chuen-o-second-morning-wait-chronicle',
  'hk-sha-tin-shui-chuen-o-ticket-for-two-chronicle',
  'hk-sha-tin-shui-chuen-o-second-name-chronicle',
  'hk-sha-tin-to-central-night-ticket-chronicle',
] as const;

export type TicketArcPosition = StoryArcPosition;

/** Where a chapter sits in the arc, or null when it is not one of the five. */
export function ticketArcFor(slug: string): TicketArcPosition | null {
  return arcPositionFor(TICKET_ARC_SLUGS, slug);
}
