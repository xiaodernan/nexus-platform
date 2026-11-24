import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getDict } from './i18n';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/**
 * D1584 — the browser console showed 12 "duplicate key" React errors on /hong-kong: the curated
 * hkSeries card list has more entries than unique slugs, and HkSeriesProgress keyed its <li> by
 * slug alone. The key now includes the list index, so every rendered child is unique.
 */
describe('HK series progress keys', () => {
  it('keys by slug AND index, because the curated card list contains repeated slugs', () => {
    const source = read('apps/web/src/components/hk-series-progress.tsx');
    expect(source).toContain('key={`${card.slug}-${index}`}');
    expect(source).not.toContain('key={card.slug}');

    const cards = getDict('zh-HK').home.hkSeries.cards;
    const slugs = cards.map((c) => c.slug);
    expect(slugs.length).toBeGreaterThan(new Set(slugs).size);
  });
});
