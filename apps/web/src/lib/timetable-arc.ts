/**
 * D1590 — the timetable arc (§六): nine chapters, one folded sheet, a bus ride from the terminus through Wan Chai
 * and North Point, onto the ferry, into the iron box and out again at dawn. A curated fact about the corpus, not a similarity guess. Shared walk semantics.
 */
import { arcPositionFor, type StoryArcPosition } from './story-arc';

export const TIMETABLE_ARC_SLUGS: readonly string[] = [
  'hk-central-terminus-claimed-ticket-chronicle',
  'hk-central-terminus-tomorrow-time-ticket-chronicle',
  'hk-central-terminus-first-bus-ticket-chronicle',
  'hk-wan-chai-folded-timetable-chronicle',
  'hk-north-point-third-stop-timetable-chronicle',
  'hk-north-point-ferry-timetable-chronicle',
  'hk-central-pier-timetable-sixth-line-chronicle',
  'hk-central-iron-box-unfinished-sheets-chronicle',
  'hk-central-dawn-blank-sheet-chronicle',
] as const;

export type TimetableArcPosition = StoryArcPosition;

/** Where a chapter sits in the timetable arc, or null when it is not one of the nine. */
export function timetableArcFor(slug: string): TimetableArcPosition | null {
  return arcPositionFor(TIMETABLE_ARC_SLUGS, slug);
}
