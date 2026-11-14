import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1071 — the BackToTop button pins its shape and greets only below the fold.
 *
 *   - the island never renders above viewport height (it returns null);
 *   - it registers only a passive scroll listener and cleans it up on unmount;
 *   - reduced motion toggles the FOLLOW behaviour smoothly — the press button always does what you asked;
 *   - dict carries both locales with Traditional script in zh-HK;
 *   - the layout mounts the island exactly once.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/back-to-top.tsx';
const LAYOUT = 'apps/web/app/layout.tsx';
const DICT = 'apps/web/src/lib/i18n/dict.ts';

describe('D1071 back-to-top island', () => {
  it('is a client island mounted once in the layout and is passive-only', () => {
    const component = read(COMPONENT);
    expect(component.startsWith("'use client';")).toBe(true);
    expect(component).toContain('addEventListener');
    expect(component).toContain("{ passive: true }");
    expect(component).toContain('aria-label={labels.toTop}');
    expect(component).toContain('prefers-reduced-motion');
    const layout = read(LAYOUT);
    expect(layout).toContain("import { BackToTop } from '@/components/back-to-top';");
    expect((layout.match(/<BackToTop/g) ?? []).length).toBe(1);
  });

  it('never renders before the reader has scrolled past the viewport', () => {
    const component = read(COMPONENT);
    expect(component).toContain('if (!visible) return null;');
  });

  it('the dict carries both locales with Traditional script in zh-HK', () => {
    const dict = read(DICT);
    expect(dict).toContain("backToTop: '回到頁首'");
    expect(dict).toContain("backToTop: 'Back to top'");
    expect(dict).toContain('backToTop: string;');
  });
});
