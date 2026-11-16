import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1273 — pins for the in-app /afterward tail of the closed arc: the page is SSR, dict-carried,
 * canonical /afterward, both locales carry the five flashes, the footer carries the door.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/afterward/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';

describe('D1273 the /afterward tail', () => {
  it('the page is server-rendered, dict-carried, canonical /afterward', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain("currentLocale()");
    expect(page).toContain("dict.afterward");
    expect(page).toContain("canonical: '/afterward'");
    expect(page).toContain('/chronicle');
    expect(page).toContain('/hong-kong');
  });

  it('both locales carry the same five flashes and the codex clincher', () => {
    const dict = read(DICT);
    for (const key of ['flashes', 'finaleTitle', 'ctaChronicle', 'ctaStory']) {
      const hits = (dict.match(new RegExp(`${key}:`, 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2);
    }
    expect(dict).toContain('龍翔道');
    expect(dict).toContain('Lung Cheung');
    expect(dict).toContain('百番甜麵包');
    expect(dict).toContain('00:00');
    expect(dict).toContain('01:15');
    expect(dict).toContain('05:00');
    expect(dict).toContain('06:40');
  });

  it('the footer carries the door (both locales)', () => {
    const chrome = read(CHROME);
    expect(chrome).toContain("href: '/afterward'");
    expect(chrome).toContain('收工之後');
    expect(chrome).toContain('The Afterward');
  });
});
