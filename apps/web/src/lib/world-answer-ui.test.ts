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
});
