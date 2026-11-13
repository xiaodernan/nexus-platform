import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D1018 — the EntityRail scroll chrome: the rail must never become unreachable chrome and never
 * hydrate different elements on the server and the client.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(HERE, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

const CARD = read('packages/ui/src/trust/EntityCard.tsx');
const RENDERER = read('packages/ui/src/trust/Renderers.tsx');
const ZH = read('apps/web/src/lib/i18n/trust-labels.ts');

describe('D1018 rail chrome — the contract is pinned where it can be read', () => {
  it('the rail measures its own geometry, not a media query', () => {
    expect(CARD).toContain('const railRef = React.useRef<HTMLDivElement>(null)');
    expect(CARD).toContain('const measure = React.useCallback');
    expect(CARD).toContain('new ResizeObserver(measure)');
    expect(CARD).toContain("el.addEventListener('scroll', measure");
    expect(CARD).toContain('max > 8');
  });

  it('the navigation buttons exist only when the rail scrolls, and are disabled at the ends', () => {
    expect(CARD).toContain('metrics.scrollable ? (');
    expect(CARD).toContain('aria-label={labels.railPrev}');
    expect(CARD).toContain('aria-label={labels.railNext}');
    expect(CARD).toContain('disabled={metrics.atStart}');
    expect(CARD).toContain('disabled={metrics.atEnd}');
  });

  it('the trust contract carries the two rail strings — never a hard-coded literal', () => {
    expect(RENDERER).toContain('railPrev: string;');
    expect(RENDERER).toContain('railNext: string;');
    expect(ZH).toContain("railPrev: '向左滾動'");
    expect(ZH).toContain("railNext: '向右滾動'");
    expect(ZH).toContain("railPrev: 'Scroll left'");
    expect(ZH).toContain("railNext: 'Scroll right'");
  });

  it('the progress thumb is an honest scroll fraction of the thumb, never a decorative loop', () => {
    expect(CARD).toContain('const thumb = scrollable ? Math.min(100, (el.clientWidth / el.scrollWidth) * 100) : 100;');
    expect(CARD).toContain('const offset = scrollable ? (el.scrollLeft / max) * (100 - thumb) : 0;');
    expect(CARD).toContain('motion-safe:transition-[left]');
  });

  it('the rail chrome moves under reduced motion only as an instant jump', () => {
    expect(CARD).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
    expect(CARD).toContain("behavior: reduced ? 'auto' : 'smooth'");
  });

  it('the rail always renders the same client element set', () => {
    expect(CARD).toContain('const empty = cards.length === 0;');
    expect(CARD).toContain('if (empty) return null;');
    expect(CARD.indexOf('const railRef = React.useRef')).toBeLessThan(CARD.indexOf('if (empty) return null;'));
  });
});
