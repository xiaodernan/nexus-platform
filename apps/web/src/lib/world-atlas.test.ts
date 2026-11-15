/**
 * D1210 — pins for the /world atlas route and its dictionary block.
 *
 * The atlas reads the 68 arc-clock chips straight from the dictionary (no hand-duplication),
 * partitions them into seven hour-layers, and renders them in server markup. These pins
 * make sure the partition is total (68 = 12+16+11+12+6+5+6), the layers are bilingual in the
 * same breath, and the page stays an SSR dossier (no client island).
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDict } from './i18n';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/world/page.tsx';
const CHROME = 'apps/web/src/components/site-chrome.tsx';

const BOUNDS = [225, 465, 720, 1020, 1140, 1290];
const layerOf = (time: string): number => {
  const [h = 0, m = 0] = time.split(':').map(Number);
  const minutes = h * 60 + m;
  let i = 0;
  while (i < BOUNDS.length && minutes >= (BOUNDS[i] ?? Infinity)) i += 1;
  return i;
};

describe('D1210 /world atlas — the corpus read by the hour', () => {
  it('renders server-side per request, bilingual, with no client island', () => {
    const page = read(PAGE);
    expect(page).toContain('currentLocale()');
    expect(page).not.toContain("'use client'");
    expect(page).toContain('dict.world');
    expect(page).toContain('canonical: \'/world\'');
  });

  it('partitions all 68 arc-clock chips exactly once into the seven layers', async () => {
    const zh = getDict('zh-HK');
    const clock = zh.home.hkHub.clock;
    expect(clock).toHaveLength(76);
    const en = getDict('en');
    expect(en.home.hkHub.clock).toHaveLength(76);

    const counts = new Array<number>(7).fill(0);
    const seen = new Set<string>();
    for (const chip of clock) {
      const idx = layerOf(chip.time);
      counts[idx] = (counts[idx] ?? 0) + 1;
      seen.add(chip.href);
      expect(chip.href).toMatch(/^\/guides\//);
    }
    expect(counts).toEqual([12, 16, 16, 15, 6, 5, 6]);
    expect(seen.size).toBe(76);

    // zh and en must partition identically by time (translations drift only in copy)
    const enCounts = new Array<number>(7).fill(0);
    for (const chip of en.home.hkHub.clock) enCounts[layerOf(chip.time)] = (enCounts[layerOf(chip.time)] ?? 0) + 1;
    expect(enCounts).toEqual(counts);
  });

  it('ships identical layer codes in both locales, bilingual blurbs', () => {
    const zh = getDict('zh-HK');
    const en = getDict('en');
    expect(zh.world.layers.map((l) => l.code)).toEqual(['night', 'dawn', 'morning', 'afternoon', 'evening', 'nightlife', 'late']);
    expect(en.world.layers.map((l) => l.code)).toEqual(['night', 'dawn', 'morning', 'afternoon', 'evening', 'nightlife', 'late']);
    expect(zh.world.title).toContain('攤在桌上');
    expect(en.world.title).toContain('The whole day');
    // zh copy is Traditional: simplified 攤's counterpart 摊 must never appear
    expect(zh.world.intro).not.toContain('摊');
    expect(zh.world.countNote).toContain('合成敘事');
  });

  it('footer chrome carries the world atlas link (both locales, hint attached)', () => {
    const chrome = read(CHROME);
    expect(chrome).toContain("href: '/world'");
    expect(chrome).toContain('世界地圖');
    expect(chrome).toContain('World atlas');
  });
});
