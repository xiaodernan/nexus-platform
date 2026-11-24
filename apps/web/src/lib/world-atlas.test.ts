/**
 * D1210 — pins for the /world atlas route and its dictionary block.
 *
 * The atlas reads the arc-clock chips straight from the dictionary (no hand-duplication),
 * partitions them into seven hour-layers, and renders them in server markup. These pins
 * make sure the partition is total (106 = 17+20+18+21+10+10+10), the layers are bilingual in the
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
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const DICT_CN = 'apps/web/src/lib/i18n/dict-cn.ts';

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

  it('partitions all 106 arc-clock chips exactly once into the seven layers', async () => {
    const zh = getDict('zh-HK');
    const clock = zh.home.hkHub.clock;
    expect(clock).toHaveLength(106);
    const en = getDict('en');
    expect(en.home.hkHub.clock).toHaveLength(106);

    const counts = new Array<number>(7).fill(0);
    const seen = new Set<string>();
    for (const chip of clock) {
      const idx = layerOf(chip.time);
      counts[idx] = (counts[idx] ?? 0) + 1;
      seen.add(chip.href);
      expect(chip.href).toMatch(/^\/guides\//);
    }
    expect(counts).toEqual([17, 20, 18, 21, 10, 10, 10]);
    expect(seen.size).toBe(106);

    // zh and en must partition identically by time (translations drift only in copy)
    const enCounts = new Array<number>(7).fill(0);
    for (const chip of en.home.hkHub.clock) enCounts[layerOf(chip.time)] = (enCounts[layerOf(chip.time)] ?? 0) + 1;
    expect(enCounts).toEqual(counts);
  });

  it('the atlas nav hint states the real corpus size and clock-chip count', () => {
    const zh = getDict('zh-HK');
    const en = getDict('en');
    const nav = (dict: typeof zh) => {
      const found: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) walk(x); return; }
        const rec = node as Record<string, unknown>;
        if (rec.href === '/world' && typeof rec.title === 'string') found.push(rec.title);
        for (const value of Object.values(rec)) walk(value);
      };
      walk(dict);
      return found;
    };
    for (const locale of [zh, en]) {
      const titles = nav(locale);
      expect(titles.length, 'the /world nav hint must exist in every arm').toBeGreaterThan(0);
      for (const title of titles) {
        expect(title).toContain('190');
        expect(title).toContain('106');
        expect(title).not.toMatch(/160|87 hourly|87 個坐標/);
      }
    }
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
    const dict = read(DICT);
    const dictCn = read(DICT_CN);
    expect(chrome).toContain('dict.footer.extraLinks');
    expect(dict).toContain("href: '/world'");
    expect(dict).toContain('世界地圖');
    expect(dict).toContain('World atlas');
    expect(dictCn).toContain('世界地图');
  });

  it('handbook quickLinks covers every shipped surface, bilingual', () => {
    const zh = getDict('zh-HK').handbook.quickLinks;
    const en = getDict('en').handbook.quickLinks;
    expect(zh).toHaveLength(10);
    expect(en).toHaveLength(10);
    expect(zh.map((l) => l.href)).toEqual(en.map((l) => l.href));
    expect(zh.map((l) => l.href)).toEqual([
      '/search', '/hong-kong', '/world', '/stamp', '/handbook',
      '/hk-type', '/daily', '/insights', '/command', '/me',
    ]);
    for (const link of zh) expect(link.label.trim().length).toBeGreaterThan(0);
    for (const link of en) expect(link.label.trim().length).toBeGreaterThan(0);
  });
});
