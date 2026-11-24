/**
 * D1600 — per-layer census of the curated clock. Pure, offline, derived from the dictionary's
 * 106 arc-clock chips; the seven counts are never hand-maintained. The /world page already
 * partitions these chips with the same boundaries; this module makes that partition countable.
 */
export interface LayerCensusRow {
  code: string;
  title: string;
  chapters: number;
  share: number;
}

export interface LayerCensus {
  total: number;
  rows: LayerCensusRow[];
}

const BOUNDARIES = [225, 465, 720, 1020, 1140, 1290]; // 03:45 07:45 12:00 17:00 19:00 21:30

const minutesOf = (time: string): number => {
  const [h = 0, m = 0] = time.split(':').map((n) => Number(n));
  return h * 60 + m;
};

export function layerIndexOf(time: string): number {
  const m = minutesOf(time);
  let i = 0;
  while (i < BOUNDARIES.length && m >= (BOUNDARIES[i] ?? Infinity)) i += 1;
  return i;
}

/** Counts every chip exactly once; share is a rounded percentage of the total. */
export function layerCensus(
  chips: readonly { time: string }[],
  layers: readonly { code: string; title: string }[],
): LayerCensus {
  const counts = new Array<number>(layers.length).fill(0);
  for (const chip of chips) {
    const i = layerIndexOf(chip.time);
    if (i >= 0 && i < counts.length) counts[i] = (counts[i] ?? 0) + 1;
  }
  const total = chips.length;
  return {
    total,
    rows: layers.map((layer, i) => ({
      code: layer.code,
      title: layer.title,
      chapters: counts[i] ?? 0,
      share: total ? Math.round(((counts[i] ?? 0) / total) * 100) : 0,
    })),
  };
}
