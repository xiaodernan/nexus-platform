import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** D1497 — the full-corpus answer lane's user surface and proxy. */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

describe('world answer lane', () => {
  it('the panel is click-only and bounded', () => {
    const p = read('apps/web/src/components/world-answer-panel.tsx');
    expect(p.startsWith("'use client';")).toBe(true);
    expect(p).toContain("fetch('/api/nexus/ai/world-answer'");
    expect(p).toContain('maxLength={200}');
    expect(p).toContain('disabled={busy || !query.trim()}');
    expect(p).not.toContain('useEffect');
  });

  it('the BFF validates the query and proxies to the AI lane', () => {
    const bff = read('apps/web/app/api/nexus/ai/world-answer/route.ts');
    expect(bff).toContain("'/ai/v1/world/answer'");
    expect(bff).toContain("body.query.trim().slice(0, 200)");
    expect(bff).toContain('reason: \'invalid_query\'');
  });

  it('/world mounts it beside the wayfinder and recap', () => {
    const world = read('apps/web/app/world/page.tsx');
    expect(world).toContain("import { WorldAnswerPanel } from '@/components/world-answer-panel'");
    expect(world).toContain('<WorldAnswerPanel locale={locale} copy={t.worldAnswer} />');
    expect(world).toContain('<WayfinderPanel');
    expect(world).toContain('<StoryRecap');
  });

  it('both authored arms carry the answer-copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain('worldAnswer: {');
    expect(dict).toContain("eyebrow: '世界問答 · 全語料'");
    expect(dict).toContain("eyebrow: 'WORLD ANSWER · FULL CORPUS'");
    expect(dict).toContain('placeholder:');
  });

  // D1514 — the reader-owned context budget. These are source readers, not render tests:
  // the promise is that the depth knob is wired end-to-end and its copy teaches the reader,
  // so a lane that removes any hop (panel -> proxy -> service) reddens here.
  it('the panel offers a reader-owned quick/deep budget with how-to copy', () => {
    const p = read('apps/web/src/components/world-answer-panel.tsx');
    expect(p).toContain("const [depth, setDepth] = useState<Depth>('quick')");
    expect(p).toContain("(['quick', 'deep'] as const).map");
    expect(p).toContain('aria-pressed={active}');
    expect(p).toContain('body: JSON.stringify({ query, locale, depth })');
    expect(p).toContain('copy.quickHint');
    expect(p).toContain('copy.deepHint');
    expect(p).toContain('copy.budgetLabel(');
    expect(p).toContain('copy.measuredLabel(');
  });

  it('the proxy repeats the depth whitelist — a client cannot name a raw char budget', () => {
    const bff = read('apps/web/app/api/nexus/ai/world-answer/route.ts');
    expect(bff).toContain("body.depth === 'deep' ? 'deep' : 'quick'");
    expect(bff).toContain('body: { query, locale, depth }');
  });

  it('all three dictionaries teach the depth trade-off', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    const cn = read('apps/web/src/lib/i18n/dict-cn.ts');
    for (const arm of [dict, cn]) {
      expect(arm).toContain('depthLabel:');
      expect(arm).toContain('quickHint:');
      expect(arm).toContain('deepHint:');
      expect(arm).toContain('budgetLabel: (');
    }
    expect(dict).toContain("deepLabel: '深讀'");
    expect(dict).toContain("deepLabel: 'Deep read'");
    expect(cn).toContain("deepLabel: '深读'");
  });
});
