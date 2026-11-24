/**
 * D1560 — the world census: REAL derived numbers for the size of the world (§六), plus
 * deterministic "re-entry" doors for a reader who has finished the visible arc.
 *
 * Pure, offline, no network and no LLM. Everything here is computed from the guides the
 * product actually carries — if a number cannot be derived, it is not printed. This is the
 * antidote to "看着很大、里面很空": the bigness is measured, not claimed.
 *
 * D1592: `layers` used to be a hardcoded 7, which contradicted the module's own promise. It is
 * now passed in by the caller from the real `world.layers` list, so a copy edit cannot lie.
 */

import type { Guide } from './types';

export interface WorldCensus {
  chapters: number;
  englishArms: number;
  bodyBlocks: number;
  cardSets: number;
  timeBands: number;
  layers: number;
}

/** Time cues a chapter title may open with — the world's day is measured by these bands. */
const TIME_BANDS: string[] = [
  '凌晨', '半夜', '清晨', '早上', '上午', '中午', '下午', '傍晚', '晚上',
];

export function worldCensus(guides: Guide[], layerCount = 0): WorldCensus {
  const unique = new Map<string, Guide>();
  for (const g of guides) if (g.slug.startsWith('hk-')) unique.set(g.slug, g);
  const all = [...unique.values()];
  let englishArms = 0;
  let bodyBlocks = 0;
  let cardSets = 0;
  const bands = new Set<string>();
  for (const g of all) {
    if (g.body_blocks_en?.length) englishArms += 1;
    bodyBlocks += g.body_blocks.length + (g.body_blocks_en?.length ?? 0);
    cardSets += g.body_blocks.filter((b) => b.type === 'cards').length;
    for (const band of TIME_BANDS) {
      if (g.title.includes(band)) bands.add(band);
    }
  }
  return {
    chapters: all.length,
    englishArms,
    bodyBlocks,
    cardSets,
    timeBands: bands.size,
    layers: layerCount,
  };
}

/**
 * Re-entry doors: deterministic unvisited chapters from DIFFERENT time bands. A reader who
 * has exhausted the visible arc is handed more world, never a dead "done / back to index".
 * The result is pure over the inputs, so the same state always yields the same doors.
 */
export function endlessDoors(guides: Guide[], readSlugs: ReadonlySet<string>, count = 3): Guide[] {
  const all = guides.filter((g) => g.slug.startsWith('hk-'));
  const unvisited = all.filter((g) => !readSlugs.has(g.slug));
  const pool = unvisited.length ? unvisited : all; // the world is endless: replay from another hour
  const picked: Guide[] = [];
  const usedBands = new Set<string>();
  for (const g of pool) {
    if (picked.length >= count) break;
    const band = TIME_BANDS.find((b) => g.title.includes(b)) ?? 'other';
    if (!usedBands.has(band)) {
      picked.push(g);
      usedBands.add(band);
    }
  }
  // Prefer variety, but never return fewer doors than asked while the pool has chapters.
  for (const g of pool) {
    if (picked.length >= count) break;
    if (!picked.includes(g)) picked.push(g);
  }
  return picked;
}
