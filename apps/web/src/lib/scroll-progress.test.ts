import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1048 — the reading-progress hairline keeps its aesthetic contract in source:
 *
 *   - it is a client island (`'use client'`) pinned behind the one decorative gradient the
 *     token sheet allows (`var(--nexus-ai-gradient)`), never a second, forked accent;
 *   - the paint path is transform-only (scaleX) and compositor-friendly, never `width`;
 *   - the scroll/resize listeners are registered `{ passive: true }`;
 *   - the server-rendered markup ships `transform: scaleX(0)` inline and `aria-hidden="true"`;
 *   - the class exists in globals.css with pointer-events: none and no transition animation;
 *   - prefers-reduced-motion degrades opacity only, never implies motion nobody asked for.
 *
 * A bar that breaks any of those is decoration pretending to be trustworthy chrome.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const COMPONENT = 'apps/web/src/components/scroll-progress.tsx';
const GLOBAL_CSS = 'apps/web/app/globals.css';
const LAYOUT = 'apps/web/app/layout.tsx';

describe('D1048 reading-progress hairline', () => {
  it('is an opt-in client island rendered exactly once in the document shell', () => {
    const layout = read(LAYOUT);
    expect(layout).toContain("import { ScrollProgress } from '@/components/scroll-progress';");
    expect(layout).toContain('<ScrollProgress />');
    expect(layout.indexOf('<ScrollProgress />')).toBeLessThan(layout.indexOf('<SiteHeader'));
    const component = read(COMPONENT);
    expect(component.startsWith("'use client';")).toBe(true);
  });

  it('paints by transform scaleX, never by width', () => {
    const component = read(COMPONENT);
    expect(component).toContain('scaleX(');
    expect(component).not.toMatch(/\.style\.width\s*=/);
    const css = read(GLOBAL_CSS);
    expect(css).toMatch(/\.nexus-scroll-progress\s*\{[^}]*transform-origin:\s*0 0;/s);
  });

  it('registers passives listeners and no React state', () => {
    const component = read(COMPONENT);
    expect(component).toMatch(/addEventListener\('scroll', update, \{ passive: true \}\)/);
    expect(component).toMatch(/addEventListener\('resize', update, \{ passive: true \}\)/);
    expect(component).not.toContain('useState');
    expect(component).not.toContain('useReducer');
  });

  it('ships SSR-true zero width and is aria-hidden decorative', () => {
    const component = read(COMPONENT);
    expect(component).toContain('aria-hidden="true"');
    expect(component).toContain("style={{ transform: 'scaleX(0)' }}");
  });

  it('is drawn from the token gradient with pointer-events none, opacity-only reduced-motion', () => {
    const css = read(GLOBAL_CSS);
    expect(css).toContain('background: var(--nexus-ai-gradient);');
    expect(css).toMatch(/\.nexus-scroll-progress\s*\{[^}]*pointer-events:\s*none;/s);
    expect(css).not.toMatch(/\.nexus-scroll-progress\s*\{[^}]*transition:/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.nexus-scroll-progress[\s\S]*?opacity:\s*0\.7/);
  });
});
