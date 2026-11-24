import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** D1580 — the post-106 rail is wired to the primary hub and stays local-only in both arms. */
describe('HK continuation wiring', () => {
  it('the hub renders the rail from the full seeded corpus', () => {
    const page = read('apps/web/app/hong-kong/page.tsx');
    expect(page).toContain("import { HkContinuationRail } from '@/components/hk-continuation-rail'");
    expect(page).toContain("import { mockGuides } from '@/lib/mock'");
    expect(page).toContain('<HkContinuationRail guides={mockGuides(locale)} copy={hub.continuation} />');
  });

  it('the rail is a server component with no network or LLM', () => {
    const ui = read('apps/web/src/components/hk-continuation-rail.tsx');
    expect(ui).not.toContain("'use client'");
    expect(ui).toContain('hkContinuation(guides, 8)');
    expect(ui).not.toMatch(/\bfetch\s*\(/);
    expect(ui).not.toMatch(/\bllm\b/i);
  });

  it('both authored arms carry the copy', () => {
    const dict = read('apps/web/src/lib/i18n/dict.ts');
    expect(dict).toContain("eyebrow: '再往前走 · 全語料'");
    expect(dict).toContain("eyebrow: 'KEEP GOING · FULL CORPUS'");
    expect(dict).toContain('The clock ends. The world does not.');
    expect(dict).toContain('chapterLabel: string;');
  });
});
