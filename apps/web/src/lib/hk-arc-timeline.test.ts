import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1124 — the arc timeline strip pins: src for the eleven-clock checkpoints and both-locales
 * dict copy; placement pin on the hub; source-level anti-telemetry/absence-of-island checks.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/hk-arc-timeline.tsx';
const HUB = 'apps/web/app/hong-kong/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1124 HK arc timeline — eleven clock checkpoints', () => {
  it('the strip is a client island that shares chapter-read storage; no fetch, no telemetry', () => {
    const strip = read(ISLAND);
    expect(strip.startsWith("'use client';")).toBe(true);
    expect(strip).not.toContain('fetch(');
    expect(strip).not.toContain('XMLHttpRequest');
    expect(strip).not.toContain('analytics');
    expect(strip).toContain('aria-labelledby="arc-timeline-title"');
    expect(strip).toContain('chapter-read');
    expect(strip).toContain('HkArcClockEntry');
  });

  it('both locales carry the eleven clock checkpoints and two hint strings', () => {
    const dict = read(DICT);
    expect(dict).toContain("clockTitle: '香港一日的讀法：照時間讀'");
    expect(dict).toContain("clockTitle: 'Reading the day in Hong Kong — clock order'");
    expect((dict.match(/\{ time: '/g) || []).length).toBe(28); // 14 chips × 2 locales
    expect(dict).toContain("'/guides/hk-cart-noodles-chronicle'");
    expect(dict).toContain("'/guides/hk-food-chronicle'");
    for (const t of ['09:30', '03:10', '04:15', '04:30', '05:30', '06:00', '06:45', '07:30', '12:00', '17:58', '19:00', '22:30', '22:45', '02:00']) {
      expect((dict.match(new RegExp(`time: '${t}'`, 'g')) || []).length).toBe(2);
    }
  });

  it('the mega hub renders the arc timeline above the chapter grids', () => {
    const hub = read(HUB);
    expect(hub).toContain("import { HkArcTimeline }");
    expect(hub).toContain('<HkArcTimeline');
    expect(hub).toContain('hub.clockTitle');
    expect(hub).toContain('hub.clock');
    expect(hub).toContain('{hub.chaptersTitle}');
  });
});
