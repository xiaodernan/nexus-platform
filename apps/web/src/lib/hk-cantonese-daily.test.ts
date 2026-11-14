import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1115 — 每日一句 · 廣東話: the Cantonese-of-the-day tile on /hong-kong. Source pins only;
 * placement, pool shape and anti-telemetry bars. The day-pick algorithm is already covered
 * in almanac.test.ts — this pool is a client of it, not a redefinition.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/hk-cantonese-daily.tsx';
const HUB = 'apps/web/app/hong-kong/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1115 HK Cantonese of the day', () => {
  it('is a client island that ships the almanac and no telemetry', () => {
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("from '@/lib/almanac'");
    expect(island).toContain('hkDateKey');
    expect(island).toContain('almanacIndex');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
    expect(island).toContain('aria-label={copy.eyebrow}');
  });

  it('the mega hub renders the tile from dict copy', () => {
    const hub = read(HUB);
    expect(hub).toContain('HkCantoneseDaily');
    expect(hub).toContain('copy={hub.cantonese}');
  });

  it('both locales carry exactly twelve pool entries with jyutping and a gloss', () => {
    const dict = read(DICT);
    const poolCount = (dict.match(/jyutping: '/g) || []).length;
    // 12 phrases listed twice (zh + en locale blocks) — the pool is the same on both.
    expect(poolCount).toBe(24);
    expect(dict).toContain("'有冇推介？', jyutping: 'jau5 mou5 teoi1 gaai3'");
    expect(dict).toContain("eyebrow: '每日一句 · 廣東話'");
    expect(dict).toContain("eyebrow: 'ONE CANTONESE TODAY'");
  });
});
