/**
 * D1612 — the dawn arc (§六): six chapters, one night becoming a morning, from the midnight
 * vending machine to the blank sheet handed on at 05:30. Curated, not a similarity guess.
 */
import { arcPositionFor, type StoryArcPosition } from './story-arc';

export const DAWN_ARC_SLUGS: readonly string[] = [
  'hk-vending-machine-chronicle',
  'hk-fruit-market-chronicle',
  'hk-window-cleaner-chronicle',
  'hk-fish-market-chronicle',
  'hk-kwun-tong-newsboy-chronicle',
  'hk-central-dawn-blank-sheet-chronicle',
] as const;

export type DawnArcPosition = StoryArcPosition;

export function dawnArcFor(slug: string): DawnArcPosition | null {
  return arcPositionFor(DAWN_ARC_SLUGS, slug);
}
