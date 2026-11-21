import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1502 — real public reference data surfaced through the SSRF-guarded tool, no LLM tokens. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('real web-facts lane', () => {
  it('the panel is click-only, language-switchable and labels third-party rows', () => {
    const p = read('apps/web/src/components/web-facts-panel.tsx');
    expect(p.startsWith("'use client';")).toBe(true);
    expect(p).toContain("fetch('/api/nexus/ai/web-facts'");
    expect(p).toContain('setLanguage(language === \'zh\' ? \'en\' : \'zh\')');
    expect(p).toContain('{row.source} · {row.confidence}');
    expect(p).toContain('disabled={busy || !query.trim()}');
    expect(p).not.toContain('useEffect');
  });

  it('the BFF bounds the query and proxies to the web-facts route', () => {
    const bff = read('apps/web/app/api/nexus/ai/web-facts/route.ts');
    expect(bff).toContain("'/ai/v1/world/web-facts'");
    expect(bff).toContain("body.query.trim().slice(0, 120)");
    expect(bff).toContain('reason: \'mock_provider\'');
  });

  it('/world mounts it beside the answer and wayfinder panels', () => {
    const world = read('apps/web/app/world/page.tsx');
    expect(world).toContain("import { WebFactsPanel } from '@/components/web-facts-panel'");
    expect(world).toContain('<WebFactsPanel locale={locale} copy={t.webFacts} />');
    expect(world).toContain('<WorldAnswerPanel');
    expect(world).toContain('<WayfinderPanel');
  });

  it('both authored arms carry the third-party disclaimer copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain('webFacts: {');
    expect(dict).toContain("eyebrow: '真實資料 · 聯網'");
    expect(dict).toContain("eyebrow: 'REAL FACTS · ONLINE'");
    expect(dict).toContain('不耗費大模型 token');
  });
});
