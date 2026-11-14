import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1095 — the /hk-type archetype quiz. Three pins:
 *   - the route exists, is force-static, renders a client island, serializes zero answers;
 *   - the island carries three archetypes with deterministic scoring and a restart loop;
 *   - the dict carries the whole quiz in both locales with HK Traditional script in zh.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/hk-type/page.tsx';
const ISLAND = 'apps/web/src/components/hk-quiz.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1095 /hk-type archetype quiz', () => {
  it('is a force-static route streaming a client island with no telemetry', () => {
    const page = read(PAGE);
    expect(page).toContain("export const dynamic = 'force-static';");
    expect(page).toContain('HkQuiz');
    expect(page).toContain("import { HkQuiz }");
    const island = read(ISLAND);
    expect(island.startsWith("'use client';")).toBe(true);
    expect(island).not.toContain('fetch(');
    expect(island).not.toContain('XMLHttpRequest');
    expect(island).not.toContain('analytics');
    expect(island).toContain('navigator.clipboard');
  });

  it('the island has three archetypes with deterministic scoring and a restart', () => {
    const island = read(ISLAND);
    for (const archetype of ['yum_cha', 'siu_mei', 'cha_chaan_teng']) {
      expect(island).toContain(archetype);
    }
    expect(island).toContain('isLast');
    expect(island).toContain('setPhase');
    expect(island).toContain('aria-valuenow');
    expect(island).toContain('progressbar');
  });

  it('the dict carries the whole quiz in both locales with HK Traditional script in zh', () => {
    const dict = read(DICT);
    expect(dict).toContain("title: '你係邊一個 HK？'");
    expect(dict).toContain("title: 'Which Hong Kong are you?'");
    expect(dict).toContain("guideHref: '/guides/hk-siu-mei-chronicle'");
    expect(dict).toContain("guideHref: '/guides/hk-dim-sum-chronicle'");
    expect(dict).toContain("guideHref: '/guides/hk-food-chronicle'");
    expect(dict).toContain("seriesLabel: '六章香港系列指南'");
    expect(dict).toContain("seriesLabel: 'Six HK chapters'");
    expect(dict).toContain("hint: '第四章'");
    expect(dict).toContain("hint: 'Chapter four'");
  });
});
