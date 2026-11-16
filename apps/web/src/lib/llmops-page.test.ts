import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * D1265 — pins for the in-app /llm-ops operator page: the page is server-rendered,
 * dict-carried and canonical /llm-ops; both locales carry the six sections incl. the
 * measured wire; the figure carries the live A/B numbers from 2026-11-16 (direct JSON
 * 81.5% vs SSE 16.3%); the page exposes no island (zero client JS beyond the JSX).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const PAGE = 'apps/web/app/llm-ops/page.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';
const CHROME = 'apps/web/src/components/site-chrome.tsx';
const ATLAS = 'docs/ATLAS.md';

describe('D1265 the /llm-ops operator page', () => {
  it('the page is server-rendered, dict-carried, canonical /llm-ops', () => {
    const page = read(PAGE);
    expect(page).not.toContain("'use client'");
    expect(page).toContain("currentLocale()");
    expect(page).toContain("dict.llmops");
    expect(page).toContain("canonical: '/llm-ops'");
    expect(page).toContain('<svg');
    expect(page).toContain('lo-wire');
    expect(page).toContain('lo-prefix');
    expect(page).toContain('lo-router');
    expect(page).toContain('lo-cost');
    expect(page).toContain('lo-probe');
    expect(page).toContain('lo-truth');
  });

  it('both locales carry the operator page re-entering the real numbers', () => {
    const dict = read(DICT);
    for (const key of ['llmops: {', 'eyebrow:', 'title:', 'intro:', 'figureTitle:',
      'envelopeTitle', 'prefixTitle', 'routerTitle', 'costTitle', 'probeTitle', 'honestyTitle', 'ctaHandbook']) {
      const hits = (dict.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      expect(hits).toBeGreaterThanOrEqual(2);
    }
    // The exact live measurements from 2026-11-16 stay pinned verbatim — no rounding.
    expect(dict).toContain('direct JSON');
    expect(dict).toContain('81.5%');
    expect(dict).toContain('16.3%');
    expect(dict).toContain('44,160 / 54,211');
    expect(dict).toContain('NEXUS_LLM_STREAM=true');
    expect(dict).toContain('cache_probe.py');
    expect(dict).toContain('llm-cache-probe.yml');
    expect(dict).toContain('Clash Verge');
    // The honesty strip is present both arms
    expect(dict).toContain('provider 遷移');
    expect(dict).toContain('provider migration must re-measure');
  });

  it('the footer chrome carries the door (both locales)', () => {
    const chrome = read(CHROME);
    expect(chrome).toContain("href: '/llm-ops'");
    expect(chrome).toContain('模型手術枱');
    expect(chrome).toContain('LLM ops');
  });

  it('ATLAS names the route and the page carries its figures', () => {
    const atlas = read(ATLAS);
    expect(atlas).toContain('apps/web/app/llm-ops/page.tsx');
    expect(atlas).toContain('/llm-ops');
  });
});
