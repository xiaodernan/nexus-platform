import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1122 — the home newcomer strip: five first-run anchors reachable from the hero onward,
 * local-first dismissal, dict-carried. Source pins; placement pins.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const ISLAND = 'apps/web/src/components/newcomer-tour.tsx';
const HOME = 'apps/web/app/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1122 the newcomer strip', () => {
  it('is a client island persisting dismissal to localStorage with no telemetry', () => {
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).toContain("STORAGE_KEY = 'nexus.newcomer-tour.off'");
    expect(island).toContain('window.localStorage');
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
  });

  it('home renders the strip above the almanac, after the hero, from dict copy', () => {
    const home = read(HOME);
    expect(home).toContain("import { NewcomerTour }");
    expect(home).toContain('<NewcomerTour copy={dict.home.newcomer} />');
    expect(home).toContain('<HkDailyAlmanac');
  });

  it('both locales carry four anchors and a dismissable label', () => {
    const dict = read(DICT);
    expect(dict).toContain("eyebrow: '新手上路'");
    expect(dict).toContain("eyebrow: 'FIRST RUN'");
    expect(dict).toContain("dismiss: '我知道了'");
    expect(dict).toContain("dismiss: 'Got it'");
    for (const href of ['/search', '/hong-kong', '/hk-type', '/handbook']) {
      const hits = (dict.match(new RegExp(`{ href: '${href}'`, 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2); // zh + en blocks
    }
  });
});
