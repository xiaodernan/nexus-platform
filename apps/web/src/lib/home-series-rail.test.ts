import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1099 — the HK series rail on the home page pins its shape and its guard:
 *   - the rail renders mock-fixture chapters only through IS_MOCK (live mode hides it);
 *   - dict carriers carry the four cards in both locales, Traditional script in zh;
 *   - the block is aria-label-less decorative jump-rail — visual only, not a heading route;
 *   - the page links to /guides/<slug> in the fixture plane so the chapters are one tap away.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1099 HK series rail on the home page', () => {
  it('is mock-plane only, links the four chapters, and renders the /guides CTA', () => {
    const page = read(PAGE);
    expect(page).toContain('{IS_MOCK ? (');
    expect(page).toContain('dict.home.hkSeries.cards.map');
    expect(page).toContain('href={`/guides/${card.slug}`}');
    expect(page).toContain("href=\"/guides\"");
    for (const slug of ['hk-food-chronicle', 'hk-siu-mei-chronicle', 'hk-dim-sum-chronicle', 'hk-temple-street-chronicle']) {
      expect(page).not.toContain(slug); // no fixture keys leak into render code — dict-driven only
    }
  });

  it('the dict carries the rail in both locales with Traditional script in zh', () => {
    const dict = read(DICT);
    expect(dict).toContain("title: '十三章反覆走完一個 HK'");
    expect(dict).toContain("title: 'One HK in thirteen chapters'");
    expect(dict).toContain("label: '香港三餐的血脈'");
    expect(dict).toContain("kicker: '第一章'");
  });
});
